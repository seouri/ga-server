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
  expect(vitalRow(o('Weight', { meta: { source: '/a/b/visit.pdf' }, valueQuantity: { value: 70, unit: 'kg' } }))).toMatchObject({ value: '70 kg', setting: 'clinic', source: 'visit.pdf', kind: 'reading' });
  for (const [text, kind] of [['Heart rate, daily mean (Apple Health)', 'daily mean'], ['Steps, daily total (Apple Health)', 'daily total'], ['Activity rings, daily (Apple Health)', 'daily'], ['Sleep, nightly (Apple Health)', 'nightly']])
    expect(vitalRow(o(text, { meta: apple })).kind).toBe(kind);
});

test('vitals: readings query vital-signs; daily keeps only Apple summaries and says how to narrow', async () => {
  const seen: URLSearchParams[] = [];
  const entries = [o('Steps, daily total (Apple Health)', { meta: apple }), o('Six-minute walk distance (estimated)', { meta: apple }), o('Sleep, nightly (Apple Health)', { meta: apple })];
  const client = { search: async (_t: string, q: URLSearchParams) => (seen.push(q), { resourceType: 'Bundle', entry: entries.map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  await vitals(client, 'p', { name: 'weight', since: '2024-01-01' });
  expect(seen[0].getAll('category')).toEqual(['vital-signs']);
  expect(seen[0].get('_tag')).toBeNull();
  expect(seen[0].getAll('date')).toEqual(['ge2024-01-01']);
  const d = await vitals(client, 'p', { daily: true, limit: 1 });
  expect(seen[1].getAll('category')).toEqual(['activity']);
  expect(seen[1].get('_tag')).toBe('urn:ga-server:tag|src-apple-health');
  expect(d).toMatchObject({ rows: [{ kind: 'daily total' }], truncated: true, hint: expect.any(String) });
  expect((await vitals(client, 'p', { daily: true })).rows.map((r) => r.kind)).toEqual(['daily total', 'nightly']);
  await expect(vitals(client, 'p', { until: '2024-13-01' })).rejects.toThrow(/until must be/);
});
