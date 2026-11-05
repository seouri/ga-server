import { expect, test } from 'vitest';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { contentKey, stableIdentifier, stamp, type SourceInfo } from '../src/identity.ts';

const ccda: SourceInfo = { kind: 'ccda', file: 'a.xml', date: '2024-07-26T00:00:00Z', writer: 'importer' };
const pdf: SourceInfo = { kind: 'pdf', file: 'b.pdf', date: '2024-08-01', writer: 'agent', llm: true };
const obs = (dt?: string, coded = true): Observation => ({
  resourceType: 'Observation',
  id: 'o1',
  status: 'final',
  code: coded ? { coding: [{ system: 'http://loinc.org', code: '4548-4' }] } : { text: 'A1c' },
  effectiveDateTime: dt,
  valueQuantity: { value: 5.6, unit: '%' },
});

test('stableIdentifier is deterministic for ccda and pdf', () => {
  expect(stableIdentifier(obs(), ccda, 'h')).toEqual({ system: 'urn:ga-server:id:ccda', value: 'o1' });
  const a = stableIdentifier(obs('2024-07-26'), pdf, 'h');
  expect(a).toEqual(stableIdentifier(obs('2024-07-26'), pdf, 'h'));
  expect(a.system).toBe('urn:ga-server:id:pdf');
  expect(a.value).toMatch(/^[0-9a-f]{64}$/);
  expect(stableIdentifier(obs('2024-07-27'), pdf, 'h').value).not.toBe(a.value);
  expect(stableIdentifier(obs('2024-07-26'), pdf, 'h2').value).not.toBe(a.value);
  const cond: Resource = { resourceType: 'Condition', id: 'x', subject: { reference: 'Patient/1' } };
  expect(stableIdentifier(cond, pdf, 'h')).toEqual(stableIdentifier({ ...cond, id: 'y', meta: {} }, pdf, 'h'));
});

test('contentKey ignores time of day', () => {
  expect(contentKey(obs('2024-07-26T08:00:00Z'))).toBe('http://loinc.org|4548-4|2024-07-26');
  expect(contentKey(obs('2024-07-26T08:00:00Z'))).toBe(contentKey(obs('2024-07-26T17:00:00Z')));
});

test('contentKey undefined when uncoded or undated', () => {
  expect(contentKey(obs('2024-07-26', false))).toBeUndefined();
  expect(contentKey(obs(undefined))).toBeUndefined();
});

test('stamp is idempotent and does not mutate', () => {
  const r = obs('2024-07-26');
  const id = stableIdentifier(r, pdf, 'h');
  const once = stamp(r, pdf, id);
  expect(r.identifier).toBeUndefined();
  const twice = stamp(once, pdf, id);
  expect(twice).toEqual(once);
  expect((twice as Observation).identifier).toHaveLength(1);
  expect(twice.meta?.tag?.map((t) => t.code).sort()).toEqual(['extracted-by-llm', 'src-pdf', 'writer-agent']);
  expect(twice.meta?.source).toBe('b.pdf');
  expect((twice as Observation).extension).toEqual([
    { url: 'urn:ga-server:ext:source-date', valueDateTime: '2024-08-01' },
  ]);
});

test('stamp keeps Composition identifier singular', () => {
  const id = { system: 'urn:ga-server:id:ccda', value: 'c1' };
  const comp = { resourceType: 'Composition', id: 'c1', identifier: { system: 'urn:oid:1', value: 'doc' } } as Resource;
  expect((stamp(comp, ccda, id) as { identifier?: unknown }).identifier).toEqual(id);
  const bare = { resourceType: 'Composition', id: 'c1' } as Resource;
  expect((stamp(bare, ccda, id) as { identifier?: unknown }).identifier).toEqual(id);
});
