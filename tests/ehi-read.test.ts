import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EhiTables, exportInfo, isEhiExport } from '../src/ehi/read.ts';

const dir = join(import.meta.dirname, 'fixtures/ehi');

describe('EHI reader', () => {
  it('quotes kept literally, LF inside a field kept', () => {
    const rows = [...new EhiTables(dir).rows('MSG_TXT')];
    expect(rows.map((r) => r.MSG_TXT)).toEqual(['plain line', 'say "x', '"quoted" start not split', 'line1\nline2']);
    expect(rows[0]).toMatchObject({ MESSAGE_ID: '900002', LINE: '1' });
  });

  it('missing and empty tables are skipped and counted', () => {
    const t = new EhiTables(dir);
    expect([...t.rows('HM_ENC_DATE')]).toEqual([]);
    expect([...t.rows('NO_SUCH_TABLE')]).toEqual([]);
    expect(t.skipped).toEqual([
      { table: 'HM_ENC_DATE', reason: 'empty' },
      { table: 'NO_SUCH_TABLE', reason: 'missing' },
    ]);
    expect([...t.rows('ORDER_RESULTS')][0].COMPONENT_ID_NAME).toBe('LDL CALCULATED');
  });

  // A table is read a chunk at a time (here 5 bytes), never whole: a row, a CRLF or a character can straddle two chunks.
  const table = (body: string) => {
    const d = mkdtempSync(join(tmpdir(), 'ehi-stream-'));
    mkdirSync(join(d, 'EHITables'));
    writeFileSync(join(d, 'EHITables', 'T.tsv'), `\uFEFFK\tV\r\n${body}`);
    return new EhiTables(d, 5);
  };
  it('streams rows across chunks: a split CRLF or character, an LF in a field, a last row without CRLF', () => {
    const rows = Array.from(table('1\tthe patient\u2019s\r\n2\ta\nb\r\n\r\n3\tlast').rows('T'), (r) => ({ K: r.K, V: r.V })); // an empty cell reads ''
    expect(rows).toEqual([{ K: '1', V: 'the patient\u2019s' }, { K: '2', V: 'a\nb' }, { K: '', V: '' }, { K: '3', V: 'last' }]);
  });

  it('index groups rows by key in first-seen order and reads a group back from its byte ranges', () => {
    const t = table('a\t1\r\na\t2\r\nb\t3\r\na\t4\r\n\t5\r\n');
    const ix = t.index('T', (r) => r.K || undefined);
    expect([...ix.keys()]).toEqual(['a', 'b']);
    expect(ix.get('a')).toHaveLength(4); // two [start, end) runs: rows 1-2, and row 4
    expect(t.read('T', ix.get('a')!).map((r) => r.V)).toEqual(['1', '2', '4']);
    expect(t.read('T', ix.get('b')!).map((r) => [r.K, r.V])).toEqual([['b', '3']]);
    expect([...table('').index('T', (r) => r.K).keys()]).toEqual([]);
  });

  it('isEhiExport detects the fixture and rejects a C-CDA folder', () => {
    expect(isEhiExport(dir)).toBe(true);
    expect(isEhiExport(join(dir, '..'))).toBe(false);
  });

  it('exportInfo reads org and date from the fixture', () => {
    expect(exportInfo(dir)).toMatchObject({ org: 'synthetic-health', date: '2026-01-17T08:30:00-05:00' });
    // R17: the zone local EHI times are in: the caller's, else GA_EHI_TZ, else this machine's.
    expect(exportInfo(dir, 'America/Chicago').timeZone).toBe('America/Chicago');
    expect(exportInfo(dir).timeZone).toBe(process.env.GA_EHI_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('exportInfo keeps the creation time and zone; no zone or a date only reads as UTC', () => {
    const at = (created: string) => {
      const d = mkdtempSync(join(tmpdir(), 'ehi-'));
      const stream = 'BT (from Synthetic Health. At the time of export) Tj ET';
      writeFileSync(join(d, 'readme.PDF'), `%PDF-1.4\n1 0 obj\n<</CreationDate(D:${created})>>\nendobj\n2 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`);
      return exportInfo(d).date;
    };
    expect(at("20261104203459+05'30'")).toBe('2026-11-04T20:34:59+05:30');
    expect(at('20261104203459Z')).toBe('2026-11-04T20:34:59Z');
    expect(at('20261104203459')).toBe('2026-11-04T20:34:59Z');
    expect(at('20261104')).toBe('2026-11-04T00:00:00Z');
  });

  it('org name split across Tj/TJ fragments with an octal escape reads whole', () => {
    const d = mkdtempSync(join(tmpdir(), 'ehi-'));
    const stream = 'BT (...request on 1/1/2026 from Syn) Tj [(thetic H) -20 (\\145a)] TJ (lth. At ) Tj (the time of export, x) Tj ET';
    writeFileSync(join(d, 'README.pdf'), `%PDF-1.4\n1 0 obj\n<</CreationDate(D:20260117083000)>>\nendobj\n2 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`);
    expect(exportInfo(d)).toMatchObject({ org: 'synthetic-health', date: '2026-01-17T08:30:00Z' });
  });
});
