import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { GaError } from '../config.ts';

export type Row = Record<string, string>;


export function isEhiExport(dir: string): boolean {
  try { return statSync(join(dir, 'EHITables')).isDirectory(); } catch { return false; }
}

// A table's lines as [start, end) byte ranges of the file, contiguous lines merged into one range.
export type Ranges = number[];
const CRLF = Buffer.from('\r\n');

// Tables are read a chunk at a time, never whole: an export's tables and the notes and messages in them can be hundreds of MB.
export class EhiTables {
  skipped: { table: string; reason: 'missing' | 'empty' }[] = [];
  private dir: string;
  private chunk: number;
  private headers = new Map<string, string[]>();
  constructor(dir: string, chunk = 1 << 20) {
    this.dir = dir;
    this.chunk = chunk;
  }

  private skip(table: string, reason: 'missing' | 'empty'): void {
    if (!this.skipped.some((s) => s.table === table)) this.skipped.push({ table, reason });
  }

  // Each line of the file with its byte range: split on CRLF only (a bare LF stays in its field); a last line without CRLF counts
  // unless empty. Bytes are split before decoding, so a character across two chunks stays whole.
  private *lines(file: string): Generator<{ text: string; start: number; end: number }> {
    const fd = openSync(file, 'r');
    try {
      let buf = Buffer.alloc(0);
      let at = 0; // file offset of buf[0]
      for (;;) {
        const chunk = Buffer.alloc(this.chunk);
        const n = readSync(fd, chunk, 0, this.chunk, at + buf.length);
        buf = buf.length ? Buffer.concat([buf, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        let from = 0;
        for (let i = buf.indexOf(CRLF); i >= 0; i = buf.indexOf(CRLF, from)) {
          yield { text: buf.toString('utf8', from, i), start: at + from, end: at + i + 2 };
          from = i + 2;
        }
        if (!n) {
          if (from < buf.length) yield { text: buf.toString('utf8', from), start: at + from, end: at + buf.length };
          return;
        }
        buf = buf.subarray(from);
        at += from;
      }
    } finally { closeSync(fd); }
  }

  private file(table: string): string | undefined {
    const file = join(this.dir, 'EHITables', `${table}.tsv`);
    if (existsSync(file)) return file;
    this.skip(table, 'missing');
  }

  private *entries(table: string): Generator<{ row: Row; start: number; end: number }> {
    const file = this.file(table);
    if (!file) return;
    let header: string[] | undefined;
    let empty = true;
    for (const l of this.lines(file)) {
      if (!header) {
        header = l.text.replace(/^﻿/, '').split('\t');
        this.headers.set(table, header);
        continue;
      }
      empty = false;
      yield { row: toRow(header, l.text), start: l.start, end: l.end };
    }
    if (empty) this.skip(table, 'empty');
  }

  *rows(table: string): Generator<Row> {
    for (const e of this.entries(table)) yield e.row;
  }

  // Rows grouped by key (no key: left out), keys in first-seen order, each group as byte ranges to read back with read().
  index(table: string, key: (r: Row) => string | undefined): Map<string, Ranges> {
    const out = new Map<string, Ranges>();
    let last: Ranges | undefined;
    for (const { row, start, end } of this.entries(table)) {
      const k = key(row);
      const r = k === undefined ? undefined : out.get(k) ?? out.set(k, []).get(k)!;
      if (r && r === last && r[r.length - 1] === start) r[r.length - 1] = end;
      else r?.push(start, end);
      last = r;
    }
    return out;
  }

  read(table: string, ranges: Ranges): Row[] {
    if (!ranges.length) return [];
    const header = this.headers.get(table) as string[]; // set by the index() that gave the ranges
    const fd = openSync(join(this.dir, 'EHITables', `${table}.tsv`), 'r');
    try {
      const out: Row[] = [];
      for (let i = 0; i < ranges.length; i += 2) {
        const buf = Buffer.alloc(ranges[i + 1] - ranges[i]);
        readSync(fd, buf, 0, buf.length, ranges[i]);
        const text = buf.toString('utf8');
        for (const line of (text.endsWith('\r\n') ? text : `${text}\r\n`).split('\r\n').slice(0, -1)) out.push(toRow(header, line));
      }
      return out;
    } finally { closeSync(fd); }
  }
}
// Epic's TSVs are unquoted (checked on a real export: every row has the header's width). Fields are literal: split on tab,
// rows on CRLF only, so quotes and a bare LF inside a field survive.
const toRow = (header: string[], line: string): Row => {
  const cells = line.split('\t');
  return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
};

const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
function pdfString(s: string): string {
  return s.replace(/\\(?:([0-7]{1,3})|(\r\n|[\s\S]))/g, (_, oct, c) => (oct ? String.fromCharCode(parseInt(oct, 8) & 255) : (ESC[c] ?? (c === '\n' || c === '\r\n' ? '' : c))));
}

// Text of a PDF: Tj/TJ strings of each (possibly Flate) content stream. Fragments are joined with no
// separator (the PDF puts its own spaces in the strings), so a name split across fragments stays whole.
function pdfText(buf: Buffer): string {
  const out: string[] = [];
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let s = m[1];
    try { s = inflateSync(Buffer.from(s, 'latin1')).toString('latin1'); } catch { /* uncompressed */ }
    for (const t of s.matchAll(/\[((?:\\[\s\S]|[^\]\\])*)\]\s*TJ|\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj/g)) {
      if (t[2] !== undefined) out.push(pdfString(t[2]));
      else for (const q of t[1].matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)/g)) out.push(pdfString(q[1]));
    }
  }
  return out.join('').replace(/\s+/g, ' ');
}

// The export carries no OID or org field, so both come from the readme PDF (written by the exporting Epic site):
// org from "... from <Org>. At the time of export", date from the PDF's /CreationDate.
// timeZone (R17): the zone the export's local times are in; default GA_EHI_TZ, else this machine's zone.
export function exportInfo(
  dir: string,
  timeZone = process.env.GA_EHI_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
): { org: string; date: string; timeZone: string } {
  const name = readdirSync(dir).find((f) => /^readme\.pdf$/i.test(f));
  if (!name) throw new GaError(`not an EHI export: no readme.PDF in ${dir}`);
  const buf = readFileSync(join(dir, name));
  const org = /\bfrom (.+?)\. At the time of export/.exec(pdfText(buf))?.[1];
  if (!org) throw new GaError('cannot read the organization from readme.PDF');
  // D:YYYYMMDD[HHmmSS][Z|±HH'mm']. A full dateTime, so an export made the day after a C-CDA compares as newer.
  const d = /\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:([+-])(\d{2})'?(\d{2})?)?/.exec(buf.toString('latin1'));
  if (!d) throw new GaError('cannot read the creation date from readme.PDF');
  const [, y, mo, da, h = '00', mi = '00', se = '00', sign, zh, zm = '00'] = d;
  // shortcut: no zone (or Z) reads as UTC; PDF spec calls it unknown, local time could be off by the UTC offset.
  const zone = sign ? `${sign}${zh}:${zm}` : 'Z';
  return { org: org.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), date: `${y}-${mo}-${da}T${h}:${mi}:${se}${zone}`, timeZone };
}
