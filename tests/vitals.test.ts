import { expect, test } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { vitalRow, vitals } from '../src/vitals.ts';

const apple = { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }] };
const o = (text: string, extra: Partial<Observation> = {}): Observation => ({ resourceType: 'Observation', id: text, status: 'final', code: { text }, effectiveDateTime: '2025-01-01', ...extra });

test('vitalRow: home vs clinic, summary kind, components as value', () => {
  const bp = o('Blood pressure panel', {
    meta: apple, device: { display: 'Cuff' },
    component: [{ code: { text: 'Systolic' }, valueQuantity: { value: 120, unit: 'mm[Hg]' } }, { code: { text: 'Diastolic' }, valueQuantity: { value: 80, unit: 'mm[Hg]' } }],
  });
  expect(vitalRow(bp)).toEqual({ date: '2025-01-01', name: 'Blood pressure panel', value: 'Systolic: 120 mm[Hg]; Diastolic: 80 mm[Hg]', kind: 'reading', setting: 'home', source: 'Apple Health (Cuff)', id: 'Blood pressure panel' });
  expect(vitalRow(o('Weight', { meta: { source: '/a/b/visit.pdf' }, valueQuantity: { value: 70, unit: 'kg' } }))).toMatchObject({ value: '70 kg', setting: 'unknown', source: 'visit.pdf', kind: 'reading' });
  expect(vitalRow(o('Weight', { meta: { source: '/a/ehi', tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] }, valueQuantity: { value: 70, unit: 'kg' } })).setting).toBe('clinic');
  for (const [text, kind] of [['Heart rate, daily mean (Apple Health)', 'daily mean'], ['Steps, daily total (Apple Health)', 'daily total'], ['Activity rings, daily (Apple Health)', 'daily'], ['Sleep, nightly (Apple Health)', 'nightly']])
    expect(vitalRow(o(text, { meta: apple })).kind).toBe(kind);
});

test('vitals: readings query vital signs and activity readings; daily keeps only Apple summaries and says how to narrow', async () => {
  const seen: URLSearchParams[] = [];
  const entries = [o('Steps, daily total (Apple Health)', { meta: apple }), o('Six-minute walk distance (estimated)', { meta: apple }), o('Sleep, nightly (Apple Health)', { meta: apple })];
  const client = { search: async (_t: string, q: URLSearchParams) => (seen.push(q), { resourceType: 'Bundle', entry: entries.map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  await vitals(client, 'p', { name: 'weight', since: '2024-01-01' });
  expect(seen[0].get('_filter')).toBe('category eq vital-signs or category eq activity or _tag eq urn:ga-server:tag|extracted-by-llm');
  expect(seen[0].get('_tag')).toBeNull();
  expect(seen[0].getAll('date')).toEqual(['ge2024-01-01']);
  const d = await vitals(client, 'p', { daily: true, limit: 1 });
  expect(seen[2].getAll('category')).toEqual(['activity']); // 'weight' searched twice: by text and by its concept codes
  expect(seen[2].get('_tag')).toBe('urn:ga-server:tag|src-apple-health');
  expect(d).toMatchObject({ rows: [{ kind: 'daily total' }], truncated: true, hint: expect.any(String) });
  expect((await vitals(client, 'p', { daily: true })).rows.map((r) => r.kind)).toEqual(['daily total', 'nightly']);
  await expect(vitals(client, 'p', { until: '2024-13-01' })).rejects.toThrow(/until must be/);
  // No summary for the name (e.g. weight): the readings come back, labelled.
  const weight = [o('Body weight', { meta: apple })];
  const c2 = { search: async (_t: string, q: URLSearchParams) => ({ resourceType: 'Bundle', entry: (q.get('category') !== 'activity' ? weight : []).map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  expect((await vitals(c2, 'p', { name: 'weight', limit: 1 })).hint).toBeUndefined();
  const many = { search: async () => ({ resourceType: 'Bundle', entry: [weight[0], weight[0]].map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  expect((await vitals(many, 'p', { name: 'weight', limit: 1 })).hint).toBe('more results: narrow the dates or the name');
  expect((await vitals(many, 'p', { name: 'heart rate', limit: 1 })).hint).toMatch(/use daily: true/);
  expect(await vitals(c2, 'p', { name: 'weight', daily: true })).toMatchObject({ rows: [{ name: 'Body weight', kind: 'reading' }], hint: 'no daily summaries for this; these are readings' });
});

test('vitals: a vital concept name ("weight") also finds its member codes; one row per record, newest first', async () => {
  const seen: URLSearchParams[] = [];
  const coded = o('Wt', { id: 'c', effectiveDateTime: '2025-02-01', code: { text: 'Wt', coding: [{ system: 'http://loinc.org', code: '29463-7' }] } });
  const both = o('Body weight', { effectiveDateTime: '2024-01-01', code: { text: 'Body weight', coding: [{ system: 'http://loinc.org', code: '29463-7' }] } });
  const client = { search: async (_t: string, q: URLSearchParams) => (seen.push(q), { resourceType: 'Bundle', entry: (q.has('code') ? [coded, both] : [both]).map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  expect((await vitals(client, 'p', { name: 'weight' })).rows.map((r) => r.id)).toEqual(['c', 'Body weight']);
  expect(seen.map((q) => q.get('code') ?? `text:${q.get('code:text')}`).sort()).toEqual(['http://loinc.org|29463-7', 'text:weight']);
  seen.length = 0;
  await vitals(client, 'p', { name: 'weight', daily: true });
  expect(seen[0].get('code')).toBeNull(); // daily summaries carry no vital concept code
});

test('vitals readings: Apple activity readings and uncategorised PDF vitals, never summaries or labs', async () => {
  const cat = (code: string) => ({ category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }] }] });
  const entries = [
    o('Walking steadiness', { meta: apple, ...cat('activity') }),
    o('Steps, daily total (Apple Health)', { meta: apple, ...cat('activity') }),
    o('Weight', { valueQuantity: { value: 70, unit: 'kg' } }), // an older PDF extraction, no category
    o('Glucose', { valueQuantity: { value: 90, unit: 'mg/dL' } }),
    o('LDL', cat('laboratory')),
    o('Body weight', cat('vital-signs')),
  ];
  const client = { search: async () => ({ resourceType: 'Bundle', entry: entries.map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  expect((await vitals(client, 'p', {})).rows.map((r) => r.name).sort()).toEqual(['Body weight', 'Walking steadiness', 'Weight']);
});

test('pairBloodPressure joins systolic and diastolic taken at the same moment from the same source', async () => {
  const { pairBloodPressure } = await import('../src/vitals.ts');
  const r = (id: string, code: string, v: number, t: string, src = '/x/ehi') => ({ resourceType: 'Observation', status: 'final', id, code: { text: 'BLOOD PRESSURE', coding: [{ system: 'http://loinc.org', code }] }, valueQuantity: { value: v, unit: 'mm[Hg]' }, effectiveDateTime: t, meta: { source: src } }) as never;
  const out = pairBloodPressure([r('s1', '8480-6', 122, '2026-11-03T13:01:00Z'), r('d1', '8462-4', 80, '2026-11-03T13:01:00Z'), r('s2', '8480-6', 108, '2026-11-03T15:02:00Z'), r('d2', '8462-4', 76, '2026-11-03T15:02:00Z'), r('d3', '8462-4', 70, '2026-11-03T16:00:00Z')]);
  expect(out.map((o: { id?: string; component?: { valueQuantity?: { value?: number } }[] }) => [o.id, o.component?.map((c) => c.valueQuantity?.value)])).toEqual([['s1', [122, 80]], ['s2', [108, 76]], ['d3', undefined]]);
});
