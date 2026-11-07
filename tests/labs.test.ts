import { describe, expect, it } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { labResults, labRow } from '../src/labs.ts';

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
    pages = [[obs(1), obs(2, { category: [{ coding: [{ code: 'vital-signs' }] }] })], [obs(3), obs(4)]];
    const r = await labResults(fake(seen), 'p', { name: 'a1c', since: '2024-01-01', until: '2024-12-31', limit: 2 });
    expect(r).toMatchObject({ total: 2, truncated: true });
    expect(r.rows.map((x) => x.id)).toEqual(['id1', 'id3']);
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
