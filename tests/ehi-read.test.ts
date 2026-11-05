import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EhiTables, exportInfo, isEhiExport } from '../src/ehi/read.ts';

const dir = join(import.meta.dirname, 'fixtures/ehi');

describe('EHI reader', () => {
  it('reader handles quoted fields with tabs and newlines', () => {
    const rows = new EhiTables(dir).rows('MSG_TXT');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ MESSAGE_ID: '900001', LINE: '1', MSG_TXT: 'plain line' });
    expect(rows[1].MSG_TXT).toBe('a\tb\nc "q"');
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
});
