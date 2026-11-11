import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AhClinical, type AhRecord, type AhSummary, appleDate, isAppleHealthExport, readExport } from '../src/apple/read.ts';

const fixture = 'tests/fixtures/apple';
const collect = async (dir: string) => {
  const records: AhRecord[] = [], summaries: AhSummary[] = [], clinical: AhClinical[] = [];
  const meta = await readExport(dir, { record: (r) => records.push(r), summary: (s) => summaries.push(s), clinical: (c) => clinical.push(c) });
  return { ...meta, records, summaries, clinical };
};

describe('apple read', () => {
  it('appleDate converts offsets', () => {
    expect(appleDate('2017-11-03 10:13:05 -0500')).toBe('2017-11-03T10:13:05-05:00');
    expect(appleDate('2017-11-03 10:13:05 +0900')).toBe('2017-11-03T10:13:05+09:00');
  });

  it('reads sourceName', async () => {
    expect((await collect(fixture)).clinical[0]).toMatchObject({ sourceName: 'Example Hospital' });
    expect((await collect('tests/fixtures/apple/clinical')).clinical[0]).toMatchObject({ sourceName: 'Synthetic Hospital' });
  });

  it('detects an Apple export', () => {
    expect(isAppleHealthExport(fixture)).toBe(true);
    expect(isAppleHealthExport('tests/fixtures/ehi')).toBe(false);
  });

  it('streams the fixture, counting nested records once', async () => {
    const r = await collect(fixture);
    expect(r.exportDate).toBe('2026-11-05T13:39:52-05:00');
    const n = (t: string) => r.records.filter((x) => x.type.endsWith(t)).length;
    expect(n('HeartRate')).toBe(3);
    expect(n('BloodPressureSystolic')).toBe(1);
    expect(r.nested).toBe(3);
    expect(r.summaries.map((s) => s.date)).toEqual(['2026-03-01', '2020-11-05']);
    expect(r.summaries[0]).toMatchObject({ activeEnergyBurned: 450.5, appleExerciseTime: 42 });
    expect(r.clinical).toHaveLength(3);
    expect(r.clinical[0].resourceFilePath).toBe('/clinical-records/Patient-A.json');
    expect(r.records.find((x) => x.sourceName.startsWith('Scale'))?.sourceName).toBe('Scale & Co');
    expect(r.records.find((x) => x.type.endsWith('SleepAnalysis'))).toMatchObject({ unit: undefined, value: 'HKCategoryValueSleepAnalysisInBed' });
  });

  it('decodes numeric entities and rejects a non-export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-'));
    writeFileSync(join(dir, 'export.xml'), '<HealthData>\n <ExportDate value="2026-01-01 00:00:00 +0000"/>\n <Record type="T" sourceName="Tester&#8217;s &#x41;" startDate="2026-01-01 00:00:00 +0000" endDate="2026-01-01 00:00:00 +0000" value="1"/>\n</HealthData>\n');
    expect((await collect(dir)).records[0].sourceName).toBe('Tester\u2019s A');
    writeFileSync(join(dir, 'export.xml'), '<HealthData>\n</HealthData>\n');
    await expect(collect(dir)).rejects.toThrow(/not an Apple Health export/);
  });
});
