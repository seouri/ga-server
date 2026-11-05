import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { GaError } from '../config.ts';

export type Row = Record<string, string>;

// Epic's TSVs are tab-separated with CRLF rows and no quoting (verified on a real export:
// every row has the header's width). A field that starts with `"` is read CSV-style so
// embedded tabs/newlines survive if an export ever quotes; a mid-field `"` stays literal.
function parseTsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let f = '';
    if (text[i] === '"') {
      i++;
      for (; i < n; i++) {
        if (text[i] !== '"') f += text[i];
        else if (text[i + 1] === '"') { f += '"'; i++; } else { i++; break; }
      }
    } else {
      while (i < n && text[i] !== '\t' && text[i] !== '\n' && text[i] !== '\r') f += text[i++];
    }
    row.push(f);
    if (text[i] === '\t') { i++; continue; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    out.push(row);
    row = [];
  }
  return out;
}

export function isEhiExport(dir: string): boolean {
  try { return statSync(join(dir, 'EHITables')).isDirectory(); } catch { return false; }
}

export class EhiTables {
  skipped: { table: string; reason: 'missing' | 'empty' }[] = [];
  private dir: string;
  constructor(dir: string) { this.dir = dir; }

  rows(table: string): Row[] {
    const file = join(this.dir, 'EHITables', `${table}.tsv`);
    if (!existsSync(file)) { this.skipped.push({ table, reason: 'missing' }); return []; }
    const [header, ...body] = parseTsv(readFileSync(file, 'utf8'));
    if (!body.length) { this.skipped.push({ table, reason: 'empty' }); return []; }
    return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
}

// Text of the readme PDF: Tj/TJ strings from each (possibly Flate) content stream. Enough for Epic's readme.
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let s = m[1];
    try { s = inflateSync(Buffer.from(s, 'latin1')).toString('latin1'); } catch { /* uncompressed */ }
    for (const t of s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1].replace(/\\(.)/g, '$1'));
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

// The export carries no OID or org field, so both come from readme.PDF (written by the exporting Epic site):
// org from "... from <Org>. At the time of export", date from the PDF's /CreationDate.
export function exportInfo(dir: string): { org: string; date: string } {
  const file = join(dir, 'readme.PDF');
  if (!existsSync(file)) throw new GaError(`not an EHI export: no readme.PDF in ${dir}`);
  const buf = readFileSync(file);
  const org = /\bfrom (.+?)\. At the time of export/.exec(pdfText(buf))?.[1];
  const d = /\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})/.exec(buf.toString('latin1'));
  if (!org || !d) throw new GaError('cannot read organization or creation date from readme.PDF');
  return { org: org.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), date: `${d[1]}-${d[2]}-${d[3]}` };
}
