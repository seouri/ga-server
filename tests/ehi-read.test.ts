import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EhiTables, exportInfo, isEhiExport } from '../src/ehi/read.ts';

const dir = join(import.meta.dirname, 'fixtures/ehi');

describe('EHI reader', () => {
  it('quotes kept literally, LF inside a field kept', () => {
    const rows = new EhiTables(dir).rows('MSG_TXT');
    expect(rows.map((r) => r.MSG_TXT)).toEqual(['plain line', 'say "x', '"quoted" start not split', 'line1\nline2']);
    expect(rows[0]).toMatchObject({ MESSAGE_ID: '900002', LINE: '1' });
  });

  it('missing and empty tables are skipped and counted', () => {
    const t = new EhiTables(dir);
    expect(t.rows('HM_ENC_DATE')).toEqual([]);
    expect(t.rows('NO_SUCH_TABLE')).toEqual([]);
    expect(t.skipped).toEqual([
      { table: 'HM_ENC_DATE', reason: 'empty' },
      { table: 'NO_SUCH_TABLE', reason: 'missing' },
    ]);
    expect(t.rows('ORDER_RESULTS')[0].COMPONENT_ID_NAME).toBe('LDL CALCULATED');
  });

  it('isEhiExport detects the fixture and rejects a C-CDA folder', () => {
    expect(isEhiExport(dir)).toBe(true);
    expect(isEhiExport(join(dir, '..'))).toBe(false);
  });

  it('exportInfo reads org and date from the fixture', () => {
    expect(exportInfo(dir)).toEqual({ org: 'synthetic-health', date: '2026-01-17T08:30:00-05:00' });
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
    expect(exportInfo(d)).toEqual({ org: 'synthetic-health', date: '2026-01-17T08:30:00Z' });
  });
});
