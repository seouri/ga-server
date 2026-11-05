import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { GaError } from '../config.ts';

export type Row = Record<string, string>;

// Epic's TSVs are unquoted (checked on a real export: every row has the header's width). Fields are
// literal: split on tab, rows on CRLF only, so quotes and a bare LF inside a field survive.
function parseTsv(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').split('\r\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}

export function isEhiExport(dir: string): boolean {
  try { return statSync(join(dir, 'EHITables')).isDirectory(); } catch { return false; }
}

export class EhiTables {
  skipped: { table: string; reason: 'missing' | 'empty' }[] = [];
  private dir: string;
  constructor(dir: string) { this.dir = dir; }

  private skip(table: string, reason: 'missing' | 'empty'): Row[] {
    if (!this.skipped.some((s) => s.table === table)) this.skipped.push({ table, reason });
    return [];
  }

  rows(table: string): Row[] {
    const file = join(this.dir, 'EHITables', `${table}.tsv`);
    if (!existsSync(file)) return this.skip(table, 'missing');
    const [header, ...body] = parseTsv(readFileSync(file, 'utf8'));
    if (!body.length) return this.skip(table, 'empty');
    return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
}

const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
function pdfString(s: string): string {
  return s.replace(/\\(?:([0-7]{1,3})|(\r\n|[\s\S]))/g, (_, oct, c) => (oct ? String.fromCharCode(parseInt(oct, 8) & 255) : (ESC[c] ?? (c === '\n' || c === '\r\n' ? '' : c))));
}

// Text of a PDF: Tj/TJ strings of each (possibly Flate) content stream. Fragments are joined with no
// separator (the PDF puts its own spaces in the strings), so a name split across fragments stays whole.
export function pdfText(buf: Buffer): string {
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
export function exportInfo(dir: string): { org: string; date: string } {
  const name = readdirSync(dir).find((f) => /^readme\.pdf$/i.test(f));
  if (!name) throw new GaError(`not an EHI export: no readme.PDF in ${dir}`);
  const buf = readFileSync(join(dir, name));
  const org = /\bfrom (.+?)\. At the time of export/.exec(pdfText(buf))?.[1];
  if (!org) throw new GaError('cannot read the organization from readme.PDF');
  const d = /\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})/.exec(buf.toString('latin1'));
  if (!d) throw new GaError('cannot read the creation date from readme.PDF');
  return { org: org.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), date: `${d[1]}-${d[2]}-${d[3]}` };
}
