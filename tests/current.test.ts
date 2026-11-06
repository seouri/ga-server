import { expect, test } from 'vitest';
import type { Endpoint, MedicationStatement, Observation } from '@medplum/fhirtypes';
import { currency, currencyContext } from '../src/current.ts';

const T1 = '2026-11-01T00:00:00Z';
const T0 = '2026-10-01T00:00:00Z';
const ep = (key: string, last: string): Endpoint => ({
  resourceType: 'Endpoint',
  status: 'active',
  connectionType: { code: 'hl7-fhir-rest' },
  payloadType: [{ text: 'x' }],
  address: 'https://x.example/fhir',
  identifier: [{ system: 'urn:ga-server:id:smart-source', value: key }],
  extension: [{ url: 'urn:ga-server:ext:smart-last-success', valueDateTime: last }],
});
const med = (o: { seen?: string; date?: string; keys?: string[]; status?: 'active' | 'stopped'; tag?: string }): MedicationStatement => ({
  resourceType: 'MedicationStatement',
  status: o.status ?? 'active',
  medicationCodeableConcept: { text: 'm' },
  subject: { reference: 'Patient/p' },
  identifier: (o.keys ?? []).map((k) => ({ system: `urn:ga-server:id:smart:${k}`, value: 'MedicationRequest/1' })),
  ...(o.tag && { meta: { tag: [{ system: 'urn:ga-server:tag', code: o.tag }] } }),
  extension: [
    ...(o.seen ? [{ url: 'urn:ga-server:ext:last-seen', valueDateTime: o.seen }] : []),
    ...(o.date ? [{ url: 'urn:ga-server:ext:source-date', valueDateTime: o.date }] : []),
  ],
});
const ctx = currencyContext([], [ep('a', T1), ep('b', T0)]);

test('last-seen equal to endpoint last success is current', () => {
  expect(currency(med({ seen: T1, keys: ['a'] }), ctx)).toBe('current');
});
test('older last-seen is unconfirmed', () => {
  expect(currency(med({ seen: T0, keys: ['a'] }), ctx)).toBe('unconfirmed');
});
test('any matching source of several makes it current', () => {
  expect(currency(med({ seen: T0, keys: ['a', 'b'] }), ctx)).toBe('current');
});
test('no last-seen: source-date vs newest import', () => {
  expect(currency(med({ date: T1 }), ctx)).toBe('current');
  expect(currency(med({ date: T0 }), ctx)).toBe('unconfirmed');
});
test('newest import also counts tagged resources', () => {
  const c = currencyContext([med({ date: '2026-12-01T00:00:00Z', tag: 'src-ehi' })], [ep('a', T1)]);
  expect(currency(med({ date: T1 }), c)).toBe('unconfirmed');
});
test('inactive and uncovered types are undefined', () => {
  expect(currency(med({ status: 'stopped', seen: T1, keys: ['a'] }), ctx)).toBeUndefined();
  const o: Observation = { resourceType: 'Observation', status: 'final', code: { text: 'x' } };
  expect(currency(o, ctx)).toBeUndefined();
});
