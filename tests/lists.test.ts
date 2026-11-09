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

test('allergies: a "no known allergies" statement is one row saying so (currency none known), never an allergy', () => {
  const nka = (id: string, text: string, src: string) => ({ resourceType: 'AllergyIntolerance', id, clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ code: 'confirmed' }] },
    code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text }, meta: { source: src } }) as Resource;
  const rs = [nka('n1', 'No known allergy', '/x/a.xml'), nka('n2', 'No Known Allergies', '/x/apple')];
  const rows = listRows(rs, currencyContext(rs, []), 'allergies');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: 'No known allergies', currency: 'none known', reason: expect.stringMatching(/not an allergy/), ids: ['n1', 'n2'] });
  // a real allergy is listed first and as itself
  expect(listRows([...rs, ...all], currencyContext([...rs, ...all], []), 'allergies').map((r) => r.name)).toEqual(['Penicillin', 'No known allergies']);
});

test('a refuted allergy or problem (clinical status active, any source) is never current; with include all it reads "Not allergic to"', () => {
  const tag = (code: string) => ({ meta: { tag: [{ system: 'urn:ga-server:tag', code }] } });
  const refuted = { verificationStatus: { coding: [{ code: 'refuted' }] }, clinicalStatus: { coding: [{ code: 'active' }] } };
  const rs = [
    { resourceType: 'AllergyIntolerance', id: 'e', code: { text: 'Penicillin' }, ...refuted, ...tag('src-ehi') },
    { resourceType: 'AllergyIntolerance', id: 'c', code: { text: 'Peanut' }, ...refuted, ...tag('src-ccda') },
    { resourceType: 'Condition', id: 'd', code: { text: 'Asthma' }, category: [{ coding: [{ code: 'problem-list-item' }] }], ...refuted },
  ] as Resource[];
  const c = currencyContext(rs, []);
  expect(listRows(rs, c, 'allergies')).toEqual([]);
  expect(listRows(rs, c, 'problems')).toEqual([]);
  expect(listRows(rs, c, 'allergies', 'all').map((r) => `${r.name}|${r.currency}`).sort()).toEqual(['Not allergic to Peanut|inactive', 'Not allergic to Penicillin|inactive']);
});

test('a "no known allergies" statement with no clinical status is still that, never an allergy', () => {
  const rs = [{ resourceType: 'AllergyIntolerance', id: 'n', code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003' }] } }] as Resource[];
  expect(listRows(rs, currencyContext(rs, []), 'allergies')).toMatchObject([{ name: 'No known allergies', currency: 'none known' }]);
});

test('one row per item across sources; best currency wins, inactive never hides active', () => {
  const stamp = (d: string) => ({ extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: d }] });
  const rx = { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '617310' }], text: 'atorvastatin 40 mg tablet' };
  const ehi = { resourceType: 'MedicationRequest', id: 'r', status: 'active', medicationCodeableConcept: rx, meta: { source: '/x/ehi', tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] }, ...stamp('2026-11-04T18:00:00Z') };
  const ccda = { resourceType: 'MedicationStatement', id: 's', status: 'active', medicationCodeableConcept: { text: 'Atorvastatin 40 MG Tablet' }, meta: { source: '/x/ccda.xml' }, ...stamp('2026-11-04T03:00:00Z') };
  const stopped = { resourceType: 'MedicationStatement', id: 'z', status: 'stopped', medicationCodeableConcept: { text: 'atorvastatin 40 mg tablet' }, meta: { source: '/x/old.pdf' } };
  const other = { resourceType: 'MedicationStatement', id: 'o', status: 'active', medicationCodeableConcept: { text: 'Lisinopril' }, ...stamp('2026-11-04T03:00:00Z') };
  const rs = [ccda, ehi, stopped, other] as Resource[];
  const c = currencyContext(rs, []);
  const rows = listRows(rs, c, 'medications', 'all');
  expect(rows.map((r) => r.name?.toLowerCase())).toEqual(['atorvastatin 40 mg tablet', 'lisinopril']);
  expect(rows[0]).toMatchObject({ currency: 'current', source: 'ccda.xml; ehi; old.pdf', ids: ['s', 'r', 'z'], id: 's' });
  const cond = (id: string, src: string) => ({ resourceType: 'Condition', id, clinicalStatus: { coding: [{ code: 'active' }] }, category: [{ coding: [{ code: 'problem-list-item' }] }], code: { text: 'Asthma' }, meta: { source: src } });
  const p = listRows([cond('1', '/a/one'), cond('2', '/a/two')] as Resource[], c, 'problems');
  expect(p).toHaveLength(1);
  expect(p[0]).toMatchObject({ source: 'one; two', ids: ['1', '2'] });
});

test('medications: a C-CDA planned or proposed MedicationRequest is not current (listed as planned with include all); a portal\'s is as before', () => {
  const tag = (code: string) => ({ meta: { tag: [{ system: 'urn:ga-server:tag', code }] } });
  const req = (id: string, src: string, intent?: string) => ({ resourceType: 'MedicationRequest', id, status: 'active', ...(intent && { intent }), medicationCodeableConcept: { text: `Drug ${id}` }, ...tag(src) });
  const rows = [req('plan', 'src-ccda', 'plan'), req('prop', 'src-ccda', 'proposal'), req('order', 'src-ccda', 'order'), req('none', 'src-ccda'), req('portal', 'src-smart', 'plan')] as Resource[];
  expect(listRows(rows, ctx, 'medications').map((r) => r.id).sort()).toEqual(['none', 'order', 'portal']);
  const all = listRows(rows, ctx, 'medications', 'all');
  expect(all.filter((r) => r.currency === 'planned').map((r) => r.id).sort()).toEqual(['plan', 'prop']);
  expect(all.filter((r) => r.currency === 'planned').map((r) => r.reason)).toEqual([expect.stringMatching(/planned/), expect.stringMatching(/planned/)]);
  expect(all.map((r) => r.currency).indexOf('planned')).toBeGreaterThan(all.map((r) => r.currency).lastIndexOf('current'));
});
