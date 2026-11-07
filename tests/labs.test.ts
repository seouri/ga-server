import { describe, expect, it } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { labResults, labRow, summarizeLabs, type LabRow } from '../src/labs.ts';

describe('labRow', () => {
  it('keeps the comparator, unit, one-sided ranges and flags; omits empty fields', () => {
    const o: Observation = {
      resourceType: 'Observation', id: 'x', status: 'final', code: { coding: [{ code: '1988-5', display: 'CRP' }] },
      effectiveDateTime: '2024-05-01T08:00:00Z', valueQuantity: { comparator: '<', value: 0.5, unit: 'mg/L' },
      referenceRange: [{ high: { value: 5, unit: 'mg/L' } }], interpretation: [{ coding: [{ code: 'N' }] }],
      meta: { source: '/home/u/labs.pdf', tag: [{ code: 'extracted-by-llm' }, { code: 'possible-duplicate' }] },
    };
    expect(labRow(o)).toEqual({ date: '2024-05-01', name: 'CRP', value: '<0.5 mg/L', range: '≤5 mg/L', interpretation: 'N', source: 'labs.pdf', flags: ['read from a document by AI', 'possible-duplicate'], id: 'x' });
    expect(labRow({ resourceType: 'Observation', status: 'final', code: { text: 'HDL' }, referenceRange: [{ low: { value: 40 } }], valueString: 'see note' })).toEqual({ name: 'HDL', value: 'see note', range: '≥40' });
    expect(labRow({ resourceType: 'Observation', status: 'final', code: {}, referenceRange: [{ low: { value: 4 }, high: { value: 6, unit: '%' } }] }).range).toBe('4–6 %');
  });
});

const obs = (n: number, extra: Partial<Observation> = {}): Observation => ({ resourceType: 'Observation', id: `id${n}`, status: 'final', code: { text: 'X'.repeat(300) }, effectiveDateTime: '2024-01-01', ...extra });
const fake = (seen: string[] = []) =>
  ({
    search: async (_t: string, q: URLSearchParams) => (seen.push(q.toString()), page(0)),
    get: async (url: string) => (seen.push(url), page(Number(new URLSearchParams(url.split('?')[1]).get('p')))),
  }) as unknown as MedplumClient;
let pages: Observation[][] = [];
const page = (i: number) => ({ resourceType: 'Bundle', entry: pages[i].map((resource) => ({ resource })), link: i + 1 < pages.length ? [{ relation: 'next', url: `http://medplum:8103/fhir/R4/Observation?p=${i + 1}` }] : [] });

describe('labResults', () => {
  it('validates dates', async () => {
    for (const since of ['2024', '2024-02-30', '2024-01-01T00:00:00Z']) await expect(labResults(fake(), 'p', { since })).rejects.toThrow(/since must be/);
  });
  it('builds the query, follows next by path, drops non-lab categories, flags truncation', async () => {
    const seen: string[] = [];
    pages = [[obs(0, { effectiveDateTime: undefined }), obs(1), obs(2, { category: [{ coding: [{ code: 'vital-signs' }] }] })], [obs(3), obs(4)]];
    const r = await labResults(fake(seen), 'p', { name: 'a1c', since: '2024-01-01', until: '2024-12-31', limit: 2 });
    expect(r).toMatchObject({ total: 2, truncated: true });
    expect((r.rows as LabRow[]).map((x) => x.id)).toEqual(['id1', 'id3']);
    const q = new URLSearchParams(seen[0]);
    expect(q.getAll('date')).toEqual(['ge2024-01-01', 'lt2025-01-01']);
    expect(q.get('code:text')).toBe('a1c');
    expect(q.get('_tag:not')).toBe('urn:ga-server:tag|src-apple-health');
    expect(seen[1]).toBe('fhir/R4/Observation?p=1');
  });
  it('drops rows past the remote size budget instead of letting the cap cut JSON', async () => {
    pages = [Array.from({ length: 1000 }, (_, n) => obs(n))];
    const r = await labResults(fake(), 'p', { limit: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.total).toBeLessThan(1000);
    expect(JSON.stringify(r).length).toBeLessThan(150_000);
  });
});

describe('summarizeLabs', () => {
  const lab = (text: string, date: string | undefined, value: number, extra: Partial<Observation> = {}): Observation =>
    ({ resourceType: 'Observation', status: 'final', code: { text }, effectiveDateTime: date, valueQuantity: { value, unit: 'mg/dL' }, ...extra });
  const loinc = { coding: [{ system: 'urn:local', code: 'L1' }, { system: 'http://loinc.org', code: '13457-7' }] };
  it('groups by LOINC, else by case/space-insensitive name; an uncoded result joins the LOINC group of its name', () => {
    const s = summarizeLabs([
      lab('LDL Cholesterol', '2024-01-01', 120, { code: { ...loinc, text: 'LDL Cholesterol' } }),
      lab('LDL  cholesterol', '2025-01-01', 100), // PDF, no code
      lab('LDL calc', '2023-01-01', 130, { code: { ...loinc, text: 'LDL calc' } }),
      lab('Glucose', undefined, 90),
      lab('glucose', '2022-05-01', 99),
    ]);
    expect(s.map((x) => [x.name, x.loinc, x.count])).toEqual([['LDL  cholesterol', '13457-7', 3], ['glucose', undefined, 2]]);
    expect(s[0]).toMatchObject({ latest: { date: '2025-01-01', value: 100 }, previous: { date: '2024-01-01', value: 120 }, change: -20, first: '2023-01-01' });
    expect(s[1]).toMatchObject({ latest: { date: '2022-05-01', value: 99 }, first: '2022-05-01' }); // undated last
    expect(s[1].previous).toBeUndefined();
  });
  it('change only for same-unit numbers; out of range by interpretation, else by the reference range', () => {
    const range = { referenceRange: [{ low: { value: 3.5 }, high: { value: 5.1 } }] };
    const [k] = summarizeLabs([
      lab('Potassium', '2024-03-01', 5.6, { ...range, interpretation: [{ coding: [{ code: 'N' }] }] }), // interpretation wins over the range
      lab('Potassium', '2024-02-01', 5.4, { ...range, valueQuantity: { value: 5.4, unit: 'mmol/L' } }),
      lab('Potassium', '2024-01-01', 3.0, range),
      lab('Potassium', '2023-01-01', 4, { interpretation: [{ text: 'High' }] }),
    ]);
    expect(k).toMatchObject({ count: 4, outOfRange: 3, previous: { value: 5.4 } });
    expect(k.latest.flag).toBeUndefined();
    expect(k.change).toBeUndefined(); // mg/dL vs mmol/L
    const [c] = summarizeLabs([lab('CRP', '2024-02-01', 5.6), lab('CRP', '2024-01-01', 5.4, { valueQuantity: { comparator: '<', value: 5.4, unit: 'mg/dL' } })]);
    expect(c.change).toBeUndefined();
    expect(c.previous?.value).toBe('<5.4 mg/dL');
    expect(summarizeLabs([lab('A', '2024-01-01', 6.1), lab('A', '2023-01-01', 5.4)])[0].change).toBe(0.7);
  });
});
