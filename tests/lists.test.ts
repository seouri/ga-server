import { expect, test } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { currencyContext } from '../src/current.ts';
import { listRows } from '../src/lists.ts';

const T1 = '2026-11-01T00:00:00Z';
const T0 = '2026-10-01T00:00:00Z';
const ep = { resourceType: 'Endpoint', identifier: [{ system: 'urn:ga-server:id:smart-source', value: 'hosp' }], extension: [{ url: 'urn:ga-server:ext:smart-last-success', valueDateTime: T1 }] } as Resource;
const seen = (t: string) => ({ identifier: [{ system: 'urn:ga-server:id:smart:hosp', value: 'x' }], extension: [{ url: 'urn:ga-server:ext:last-seen', valueDateTime: t }] });
const all = [
  { resourceType: 'Medication', id: 'm1', code: { coding: [{ code: '1', display: 'Metformin 500 mg' }] } },
  { resourceType: 'MedicationRequest', id: 'a', status: 'active', authoredOn: '2026-01-02', medicationReference: { reference: 'Medication/m1' }, ...seen(T1) },
  { resourceType: 'MedicationStatement', id: 'b', status: 'active', medicationCodeableConcept: { text: 'Lisinopril' }, effectiveDateTime: '2025-05-01', ...seen(T0) },
  { resourceType: 'MedicationStatement', id: 'c', status: 'stopped', medicationCodeableConcept: { text: 'Old drug' }, meta: { source: '/x/y/list.pdf', tag: [{ system: 'urn:ga-server:tag', code: 'extracted-by-llm' }] } },
  { resourceType: 'Condition', id: 'p', clinicalStatus: { coding: [{ code: 'active' }] }, category: [{ coding: [{ code: 'problem-list-item' }] }], code: { text: 'Asthma' } },
  { resourceType: 'Condition', id: 'v', clinicalStatus: { coding: [{ code: 'active' }] }, category: [{ coding: [{ code: 'encounter-diagnosis' }] }], code: { text: 'Cough' } },
  { resourceType: 'AllergyIntolerance', id: 'al', code: { text: 'Penicillin' } },
  { resourceType: 'AllergyIntolerance', id: 'ar', code: { text: 'Peanut' }, verificationStatus: { coding: [{ code: 'refuted' }] } },
] as Resource[];
const ctx = currencyContext(all, [ep as never]);

test('medications: Medication name resolved, current vs unconfirmed with reasons, inactive only with include all', () => {
  expect(listRows(all, ctx, 'medications')).toEqual([
    { name: 'Metformin 500 mg', status: 'active', currency: 'current', reason: 'on the list at the latest hosp portal sync', since: '2026-01-02', source: 'hospital portal hosp', type: 'MedicationRequest', id: 'a' },
    { name: 'Lisinopril', status: 'active', currency: 'unconfirmed', reason: expect.stringMatching(/stopped returning it \(last returned 2026-10-01\)/), since: '2025-05-01', source: 'hospital portal hosp', type: 'MedicationStatement', id: 'b' },
  ]);
  expect(listRows(all, ctx, 'medications', 'all')[2]).toEqual({ name: 'Old drug', status: 'stopped', currency: 'inactive', source: 'list.pdf', flags: ['read from a document by AI'], type: 'MedicationStatement', id: 'c' });
});

test('problems: problem list only; allergies: unstated status kept, refuted dropped', () => {
  expect(listRows(all, ctx, 'problems').map((r) => r.name)).toEqual(['Asthma']);
  expect(listRows(all, ctx, 'allergies')).toEqual([{ name: 'Penicillin', status: 'not stated', reason: expect.stringMatching(/possibly active/), id: 'al' }]);
});
