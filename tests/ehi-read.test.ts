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
    expect(rows[0]).toMatchObject({ MESSAGE_ID: '900001', LINE: '1' });
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
    expect(exportInfo(dir)).toEqual({ org: 'synthetic-health', date: '2026-01-17' });
  });

  it('org name split across Tj/TJ fragments with an octal escape reads whole', () => {
    const d = mkdtempSync(join(tmpdir(), 'ehi-'));
    const stream = 'BT (...request on 1/1/2026 from Syn) Tj [(thetic H) -20 (\\145a)] TJ (lth. At ) Tj (the time of export, x) Tj ET';
    writeFileSync(join(d, 'README.pdf'), `%PDF-1.4\n1 0 obj\n<</CreationDate(D:20260117083000)>>\nendobj\n2 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`);
    expect(exportInfo(d)).toEqual({ org: 'synthetic-health', date: '2026-01-17' });
  });
});
