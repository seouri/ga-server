// Synthetic Epic EHI export (no real data): tests/fixtures/ehi with every table's rows repeated `factor` times. Copy k > 0 gets new
// ids (each *_ID / *_CSN value with k appended, the same in every table and in the Rich Text file names, so the joins hold) and
// dates k days earlier, so copies are separate visits, results and notes. Notes and messages carry synthetic text of a set size
// (RTF notes are the bulk of a real export), with a ’ so the text is not Latin-1 only, as in real exports.
import { copyFileSync, cpSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EhiTables, type Row } from '../../src/ehi/read.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'ehi');
const ID = /(^|_)(ID|CSN)$|_CSN_ID$/;
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}:\d{2}:\d{2} [AP]M)$/;
const PARA = 'Synthetic paragraph: the patient’s visit went as planned, vitals stable, no new complaints, plan unchanged. ';

// sizes in KB per copy: an RTF note (note 1001), a plain-text note (1002) and an RTF message (900001).
export type EhiSizes = { noteKB: number; plainKB: number; messageKB: number };

const newId = (v: string, k: number) => (k && /^\d+$/.test(v) ? `${v}${String(k).padStart(5, '0')}` : v);
function shift(v: string, k: number): string {
  const m = DATE.exec(v);
  if (!m || !k) return v;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]) - k));
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${m[4]}`;
}
const text = (kb: number, rtf: boolean) => {
  let s = '';
  for (let i = 0; s.length < kb * 1024; i++) s += `${i} ${rtf ? PARA.replace('’', "\\u8217?") : PARA}${rtf ? '\\par ' : ''}`;
  return s;
};

export async function writeEhiExport(dir: string, factor: number, sizes: EhiSizes = { noteKB: 60, plainKB: 30, messageKB: 15 }): Promise<{ bytes: number; notes: number; messages: number }> {
  mkdirSync(join(dir, 'EHITables'), { recursive: true });
  mkdirSync(join(dir, 'Rich Text'), { recursive: true });
  copyFileSync(join(FIX, 'readme.PDF'), join(dir, 'readme.PDF'));
  cpSync(join(FIX, 'Media'), join(dir, 'Media'), { recursive: true });
  let bytes = 0;
  const noteRtf = `{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Synthetic note body.\\par ${text(sizes.noteKB, true)}}`;
  const msgRtf = `{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello there\\par Second\\u8217?s line\\par ${text(sizes.messageKB, true)}}`;
  const plain = text(sizes.plainKB, false).match(/.{1,1000}/g) ?? [];
  for (const file of readdirSync(join(FIX, 'EHITables'))) {
    const [header, ...rows] = readFileSync(join(FIX, 'EHITables', file), 'utf8').split('\r\n').filter(Boolean);
    const cols = header.split('\t');
    const out = createWriteStream(join(dir, 'EHITables', file));
    const w = (s: string) => { bytes += Buffer.byteLength(s); return out.write(s) || new Promise((r) => out.once('drain', r)); };
    await w(`${header}\r\n`);
    for (let k = 0; k < factor; k++) {
      let s = '';
      const row = (cells: string[]) => (s += `${cells.join('\t')}\r\n`);
      const remap = (cells: string[]) => cells.map((v, i) => (ID.test(cols[i]) && cols[i] !== 'PAT_ID' ? newId(v, k) : /_REAL$/.test(cols[i]) && v ? String(Number(v) - k) : shift(v, k)));
      const at = (cells: string[], col: string) => cells[cols.indexOf(col)];
      for (const cells of rows.map((r) => remap(r.split('\t')))) {
        // The fixture message 900001's two RTF lines become the whole sized message, cut at fixed widths as Epic does.
        if (file === 'MYC_MESG_RTF_TEXT.tsv') {
          if (at(cells, 'LINE') !== '9') continue;
          (msgRtf.match(/[\s\S]{1,1000}/g) ?? []).forEach((part, i) => row([at(cells, 'MESSAGE_ID'), String(i + 1), part]));
        } else if (file === 'HNO_PLAIN_TEXT.tsv' && at(cells, 'LINE') === '2') {
          row(cells);
          plain.forEach((part, i) => row(cells.map((v, j) => (cols[j] === 'LINE' ? String(i + 3) : cols[j] === 'NOTE_TEXT' ? part : v))));
        } else row(cells);
      }
      await w(s);
    }
    await new Promise((r) => out.end(r));
  }
  for (let k = 0; k < factor; k++) {
    const out = join(dir, 'Rich Text', `HNO_${newId('1001', k)}_56510_41.RTF`);
    const s = `${noteRtf}`;
    bytes += s.length;
    await new Promise<void>((ok, no) => createWriteStream(out).end(s, () => ok()).on('error', no));
  }
  // per copy: 3 notes (RTF, plain text, metadata only) and 2 messages (RTF, plain text)
  return { bytes, notes: 3 * factor, messages: 2 * factor };
}

// The fixture's tables as `rows` gives them (a table it gives nothing for is empty), written as an export's EHITables.
export function ehiTables(rows: (table: string) => Iterable<Row>, dir = mkdtempSync(join(tmpdir(), 'ehi-tables-'))): EhiTables {
  mkdirSync(join(dir, 'EHITables'), { recursive: true });
  for (const f of readdirSync(join(FIX, 'EHITables'))) {
    const rs = [...rows(f.replace('.tsv', ''))];
    const cols = [...new Set([...readFileSync(join(FIX, 'EHITables', f), 'utf8').split('\r\n')[0].split('\t'), ...rs.flatMap(Object.keys)])];
    writeFileSync(join(dir, 'EHITables', f), [cols, ...rs.map((r) => cols.map((c) => r[c] ?? ''))].map((l) => `${l.join('\t')}\r\n`).join(''));
  }
  return new EhiTables(dir);
}
