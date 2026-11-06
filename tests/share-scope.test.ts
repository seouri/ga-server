import { afterEach, expect, test, vi } from 'vitest';
import type { Patient, Resource } from '@medplum/fhirtypes';
import { COMPARTMENT_TYPES, dateOf, groupOf, inScope, scopedCache, selectScoped, trimPatient } from '../src/share/scope.ts';
import type { Scoped } from '../src/share/scope.ts';
import type { Group, Share } from '../src/share/store.ts';

const share = (o: Partial<Share> = {}): Share => ({
  id: 's1', label: 't', audience: 'family', groups: 'all', layout: 'B', questionsPerDay: 20,
  tokenHash: 'h', patientId: 'p', baseUrl: 'http://x', created: '2026-11-06T00:00:00Z', ...o,
});
const r = (o: object): Resource => o as Resource;
const obs = (cat: string, extra: object = {}) =>
  r({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, category: [{ coding: [{ code: cat }] }], ...extra });
const cond = (clinical: string, date: string) =>
  r({ resourceType: 'Condition', clinicalStatus: { coding: [{ code: clinical }] }, recordedDate: date });

test.each<[Resource, Group | undefined]>([
  [obs('laboratory', { meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }] } }), 'apple'],
  [obs('laboratory'), 'labs'],
  [r({ resourceType: 'DiagnosticReport' }), 'labs'],
  [obs('vital-signs'), 'vitals'],
  [r({ resourceType: 'MedicationStatement' }), 'medications'],
  [r({ resourceType: 'MedicationRequest' }), 'medications'],
  [r({ resourceType: 'MedicationAdministration' }), 'medications'],
  [r({ resourceType: 'MedicationDispense' }), 'medications'],
  [r({ resourceType: 'Condition' }), 'problems'],
  [r({ resourceType: 'AllergyIntolerance' }), 'allergies'],
  [r({ resourceType: 'Immunization' }), 'immunizations'],
  [r({ resourceType: 'Encounter' }), 'visits'],
  [r({ resourceType: 'DocumentReference' }), 'notes'],
  [r({ resourceType: 'Composition' }), 'notes'],
  [r({ resourceType: 'Procedure' }), 'procedures'],
  [r({ resourceType: 'FamilyMemberHistory' }), 'family'],
  [r({ resourceType: 'Communication' }), 'messages'],
  [obs('social-history'), undefined],
  [r({ resourceType: 'QuestionnaireResponse' }), undefined],
])('groupOf %#', (res, g) => expect(groupOf(res)).toBe(g));

test('dateOf takes the first present field, sliced to a day', () => {
  expect(dateOf(r({ resourceType: 'Observation', effectivePeriod: { start: '2024-03-05T10:00:00Z' }, issued: '2024-04-01T00:00:00Z' }))).toBe('2024-03-05');
  expect(dateOf(r({ resourceType: 'Encounter', period: { start: '2023-01-02' } }))).toBe('2023-01-02');
  expect(dateOf(r({ resourceType: 'Observation' }))).toBeUndefined();
});

const archive = (system: string) => r({ resourceType: 'DocumentReference', identifier: [{ system, value: 'a' }], date: '2025-02-01' });
test.each([
  r({ resourceType: 'Endpoint' }),
  r({ resourceType: 'Provenance' }),
  r({ resourceType: 'AuditEvent' }),
  r({ resourceType: 'Patient', id: 'p' }),
  r({ resourceType: 'Coverage' }),
  r({ resourceType: 'RelatedPerson' }),
  r({ resourceType: 'Account' }),
  r({ resourceType: 'Claim' }),
  r({ resourceType: 'ExplanationOfBenefit' }),
  r({ resourceType: 'Person' }),
  archive('urn:ga-server:id:ehi-archive'),
  archive('urn:ga-server:id:apple-health-archive'),
])('never shared, even with all: %#', (res) => {
  expect(inScope(res, share())).toBe(false);
  expect(inScope(res, share({ groups: ['notes'] }))).toBe(false);
});

test('a plain note is shared under notes', () => {
  expect(inScope(r({ resourceType: 'DocumentReference', date: '2025-02-01' }), share({ groups: ['notes'] }))).toBe(true);
});

test('date range', () => {
  const since = share({ since: '2025-01-01' });
  expect(inScope(obs('laboratory', { effectiveDateTime: '2020-06-01' }), since)).toBe(false);
  expect(inScope(obs('laboratory', { effectiveDateTime: '2025-06-01' }), since)).toBe(true);
  expect(inScope(obs('laboratory', { effectiveDateTime: '2025-06-01' }), share({ until: '2025-05-31' }))).toBe(false);
  expect(inScope(obs('laboratory', { effectiveDateTime: '2025-05-31T23:00:00Z' }), share({ until: '2025-05-31' }))).toBe(true);
  expect(inScope(cond('active', '2018-01-01'), since)).toBe(true);
  expect(inScope(cond('resolved', '2018-01-01'), since)).toBe(false);
  expect(inScope(r({ resourceType: 'MedicationStatement', status: 'active' }), since)).toBe(true);
  expect(inScope(r({ resourceType: 'MedicationAdministration', status: 'in-progress', effectiveDateTime: '2018-01-01' }), since)).toBe(false);
  expect(inScope(obs('laboratory'), since)).toBe(false);
  expect(inScope(obs('laboratory'), share({ until: '2025-01-01' }))).toBe(false);
  expect(inScope(obs('laboratory'), share())).toBe(true);
});

test('groups filter', () => {
  const labs = share({ groups: ['labs'] });
  expect(inScope(r({ resourceType: 'MedicationStatement', status: 'active' }), labs)).toBe(false);
  expect(inScope(obs('laboratory'), labs)).toBe(true);
  expect(inScope(obs('social-history'), labs)).toBe(false);
  expect(inScope(obs('social-history'), share())).toBe(true);
});

test('trimPatient keeps only name, birthDate and gender', () => {
  const p = {
    resourceType: 'Patient', id: 'p', name: [{ family: 'Test' }], birthDate: '1980-01-01', gender: 'other',
    address: [{ city: 'X' }], telecom: [{ value: '1' }], identifier: [{ value: 'i' }], contact: [{ name: { text: 'c' } }],
    meta: { source: 'x' }, extension: [{ url: 'u', valueString: 'v' }],
  } as Patient;
  expect(trimPatient(p)).toEqual({ resourceType: 'Patient', id: 'p', name: [{ family: 'Test' }], birthDate: '1980-01-01', gender: 'other' });
});

test('selectScoped follows support references only from in-scope records', () => {
  const ms = r({
    resourceType: 'MedicationStatement', status: 'active',
    medicationReference: { reference: 'Medication/m1' },
    informationSource: { reference: 'Practitioner/pr1' },
    subject: { reference: 'Patient/p' },
    derivedFrom: [{ reference: 'Observation/o9' }],
  });
  const lab = obs('laboratory', { performer: [{ reference: 'Practitioner/pr2' }, { reference: 'Organization/o2' }] });
  const note = r({ resourceType: 'DocumentReference', content: [{ attachment: { url: 'Binary/00000000-0000-0000-0000-000000000001' } }] });
  const out = selectScoped([r({ resourceType: 'Patient', id: 'p', telecom: [{ value: '1' }] }), ms, lab, note], share({ groups: ['medications'] }));
  expect(out.resources).toEqual([ms]);
  expect(out.refs.sort()).toEqual(['Medication/m1', 'Practitioner/pr1']);
  const all = selectScoped([r({ resourceType: 'Patient', id: 'p' }), note], share());
  expect(all.refs).toEqual(['Binary/00000000-0000-0000-0000-000000000001']);
});

test('never-shared types are not even fetched', () => {
  for (const t of ['Endpoint', 'Provenance', 'AuditEvent', 'Patient', 'Coverage', 'RelatedPerson', 'Account', 'Claim', 'ExplanationOfBenefit', 'Person', 'Binary', 'Medication']) {
    expect(COMPARTMENT_TYPES).not.toContain(t);
  }
  for (const t of ['Observation', 'MedicationStatement', 'DocumentReference', 'Communication', 'Condition']) expect(COMPARTMENT_TYPES).toContain(t);
});

afterEach(() => vi.useRealTimers());
test('scopedCache shares one load per share until the TTL passes, and drops failures', async () => {
  vi.useFakeTimers();
  const result = {} as Scoped;
  let fail = true;
  const load = vi.fn(async () => {
    if (fail) throw new Error('boom');
    return result;
  });
  const cached = scopedCache(load, 1000);
  const c = {} as never;
  await expect(cached(c, share())).rejects.toThrow('boom');
  fail = false;
  expect(await cached(c, share())).toBe(result);
  expect(await cached(c, share())).toBe(result);
  expect(load).toHaveBeenCalledTimes(2);
  await cached(c, share({ id: 's2' }));
  expect(load).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(1001);
  await cached(c, share());
  expect(load).toHaveBeenCalledTimes(4);
});
