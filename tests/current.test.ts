import { expect, test } from 'vitest';
import type { AllergyIntolerance, Endpoint, MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import { currency, currencyContext } from '../src/current.ts';

const T1 = '2026-11-01T00:00:00Z';
const T0 = '2026-10-01T00:00:00Z';
const ep = (key: string, last: string, types = 'MedicationRequest,Condition'): Endpoint => ({
  resourceType: 'Endpoint',
  status: 'active',
  connectionType: { code: 'hl7-fhir-rest' },
  payloadType: [{ text: 'x' }],
  address: 'https://x.example/fhir',
  identifier: [{ system: 'urn:ga-server:id:smart-source', value: key }],
  extension: [{ url: 'urn:ga-server:ext:smart-last-success', valueDateTime: last }, { url: 'urn:ga-server:ext:smart-enabled-types', valueString: types }],
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
// Sync stamps records before it writes the Endpoint: a sync dying in between leaves last-seen after last-success.
test('last-seen after endpoint last success is current; a source with no last success confirms nothing', () => {
  expect(currency(med({ seen: '2026-11-02T00:00:00Z', keys: ['a'] }), ctx)).toBe('current');
  expect(currency(med({ seen: T1, keys: ['never'] }), ctx)).toBe('unconfirmed');
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
test('same calendar day is not older; the day before is', () => {
  const c = currencyContext([med({ date: '2026-11-04T18:00:00Z', tag: 'src-ehi' })], []);
  expect(currency(med({ date: '2026-11-04T03:00:00Z' }), c)).toBe('current');
  expect(currency(med({ date: '2026-11-03T23:59:00Z' }), c)).toBe('unconfirmed');
});
test('newest import also counts tagged resources', () => {
  const c = currencyContext([med({ date: '2026-12-01T00:00:00Z', tag: 'src-ehi' })], [ep('a', T1)]);
  expect(currency(med({ date: T1 }), c)).toBe('unconfirmed');
});
test('a portal sync raises the cutoff only for the types it syncs; its medication list covers MedicationStatement too', () => {
  const labsOnly = currencyContext([], [ep('a', T1, 'Observation')]);
  const allergy = { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ code: 'active' }] }, patient: { reference: 'Patient/p' }, extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: T0 }] } as AllergyIntolerance;
  expect(currency(allergy, labsOnly)).toBe('current');
  expect(currency(med({ date: T0 }), labsOnly)).toBe('current');
  expect(currency(med({ date: T0 }), currencyContext([], [ep('a', T1, 'MedicationRequest')]))).toBe('unconfirmed');
  expect(currency(allergy, currencyContext([], [ep('a', T1, 'MedicationRequest')]))).toBe('current');
  // A portal record's own date is no whole-record import.
  expect(currency(med({ date: T0 }), currencyContext([med({ date: T1, tag: 'src-smart' })], []))).toBe('current');
});
test('inactive and uncovered types are undefined', () => {
  expect(currency(med({ status: 'stopped', seen: T1, keys: ['a'] }), ctx)).toBeUndefined();
  const o: Observation = { resourceType: 'Observation', status: 'final', code: { text: 'x' } };
  expect(currency(o, ctx)).toBeUndefined();
});

test('a C-CDA planned MedicationRequest is not active; a portal one with the same intent still is', () => {
  const req = (code: string) => ({ resourceType: 'MedicationRequest', status: 'active', intent: 'plan', subject: { reference: 'Patient/p' }, medicationCodeableConcept: { text: 'm' },
    meta: { tag: [{ system: 'urn:ga-server:tag', code }] } }) as Resource;
  expect(currency(req('src-ccda'), ctx)).toBeUndefined();
  expect(currency(req('src-smart'), ctx)).toBe('current');
});
