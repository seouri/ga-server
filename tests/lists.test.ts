import { expect, test } from 'vitest';
import type { Endpoint, Resource } from '@medplum/fhirtypes';
import { currencyContext } from '../src/current.ts';
import { listsByKind } from '../src/lists.ts';
import type { MedplumClient } from '@medplum/core';
import { NEWEST_IMPORT } from '../src/identity.ts';

const T1 = '2026-11-01T00:00:00Z';
const T0 = '2026-10-01T00:00:00Z';
const ep = { resourceType: 'Endpoint', identifier: [{ system: 'urn:ga-server:id:smart-source', value: 'hosp' }], extension: [{ url: 'urn:ga-server:ext:smart-last-success', valueDateTime: T1 }] } as Endpoint;
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

// listsByKind over rs: one page per search (Medications included in it), the Patient's newest Epic import read from rs's tags.
const lists = (rs: Resource[], include?: 'all', eps: Endpoint[] = [ep]) => {
  const newest = currencyContext(rs, []).newestImport;
  const client = {
    search: async (t: string) => ({ resourceType: 'Bundle', entry: rs.filter((r) => r.resourceType === t || r.resourceType === 'Medication').map((resource) => ({ resource })) }),
    readResource: async () => ({ resourceType: 'Patient', extension: Number.isFinite(newest) ? [{ url: NEWEST_IMPORT, valueDateTime: new Date(newest).toISOString() }] : [] }),
    searchResourcePages: async function* () {},
  } as unknown as MedplumClient;
  return listsByKind(client, 'p1', eps, undefined, include);
};

test('medications: Medication name resolved, current vs unconfirmed with reasons, inactive only with include all', async () => {
  expect((await lists(all)).medications).toEqual([
    { name: 'Metformin 500 mg', status: 'active', currency: 'current', reason: 'on the list at the latest hosp portal sync', since: '2026-01-02', source: 'hospital portal hosp', type: 'MedicationRequest', id: 'a' },
    { name: 'Lisinopril', status: 'active', currency: 'unconfirmed', reason: expect.stringMatching(/stopped returning it \(last returned 2026-10-01\)/), since: '2025-05-01', source: 'hospital portal hosp', type: 'MedicationStatement', id: 'b' },
  ]);
  expect((await lists(all, 'all')).medications[2]).toEqual({ name: 'Old drug', status: 'stopped', currency: 'inactive', source: 'list.pdf', flags: ['read from a document by AI'], type: 'MedicationStatement', id: 'c' });
});

test('problems: problem list only; allergies: unstated status kept, refuted dropped', async () => {
  const got = await lists(all);
  expect(got.problems.map((r) => r.name)).toEqual(['Asthma']);
  expect(got.allergies).toEqual([{ name: 'Penicillin', status: 'not stated', reason: expect.stringMatching(/possibly active/), id: 'al' }]);
});

test('allergies: a "no known allergies" statement is one row saying so (currency none known), never an allergy', async () => {
  const nka = (id: string, text: string, src: string) => ({ resourceType: 'AllergyIntolerance', id, clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ code: 'confirmed' }] },
    code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text }, meta: { source: src } }) as Resource;
  const rs = [nka('n1', 'No known allergy', '/x/a.xml'), nka('n2', 'No Known Allergies', '/x/apple')];
  const rows = (await lists(rs, undefined, [])).allergies;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: 'No known allergies', currency: 'none known', reason: expect.stringMatching(/not an allergy/), ids: ['n1', 'n2'] });
  // a real allergy is listed first and as itself
  expect((await lists([...rs, ...all], undefined, [])).allergies.map((r) => r.name)).toEqual(['Penicillin', 'No known allergies']);
});

test('a refuted allergy or problem (clinical status active, any source) is never current; with include all it reads "Not allergic to"', async () => {
  const tag = (code: string) => ({ meta: { tag: [{ system: 'urn:ga-server:tag', code }] } });
  const refuted = { verificationStatus: { coding: [{ code: 'refuted' }] }, clinicalStatus: { coding: [{ code: 'active' }] } };
  const rs = [
    { resourceType: 'AllergyIntolerance', id: 'e', code: { text: 'Penicillin' }, ...refuted, ...tag('src-ehi') },
    { resourceType: 'AllergyIntolerance', id: 'c', code: { text: 'Peanut' }, ...refuted, ...tag('src-ccda') },
    { resourceType: 'Condition', id: 'd', code: { text: 'Asthma' }, category: [{ coding: [{ code: 'problem-list-item' }] }], ...refuted },
  ] as Resource[];
  const got = await lists(rs, undefined, []);
  expect(got.allergies).toEqual([]);
  expect(got.problems).toEqual([]);
  expect((await lists(rs, 'all', [])).allergies.map((r) => `${r.name}|${r.currency}`).sort()).toEqual(['Not allergic to Peanut|inactive', 'Not allergic to Penicillin|inactive']);
});

test('a "no known allergies" statement with no clinical status is still that, never an allergy', async () => {
  const rs = [{ resourceType: 'AllergyIntolerance', id: 'n', code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003' }] } }] as Resource[];
  expect((await lists(rs, undefined, [])).allergies).toMatchObject([{ name: 'No known allergies', currency: 'none known' }]);
});

test('an allergy with no clinical status, refuted in any verification coding, is not listed', async () => {
  const rs = [{ resourceType: 'AllergyIntolerance', id: 'x', code: { text: 'Peanut' },
    verificationStatus: { coding: [{ system: 'urn:local', code: 'no' }, { system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'refuted' }] } }] as Resource[];
  expect((await lists(rs, undefined, [])).allergies).toEqual([]);
});

test('a refuted "no known allergies" statement reads as that under include all, never "Not allergic to" a code', async () => {
  const rs = [{ resourceType: 'AllergyIntolerance', id: 'n', code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003' }] },
    clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ code: 'refuted' }] } }] as Resource[];
  expect((await lists(rs, undefined, [])).allergies).toEqual([]);
  expect((await lists(rs, 'all', [])).allergies).toMatchObject([{ name: 'No known allergies (refuted)', currency: 'inactive' }]);
});

test('one row per item across sources; best currency wins, inactive never hides active', async () => {
  const stamp = (d: string) => ({ extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: d }] });
  const rx = { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '617310' }], text: 'atorvastatin 40 mg tablet' };
  const ehi = { resourceType: 'MedicationRequest', id: 'r', status: 'active', medicationCodeableConcept: rx, meta: { source: '/x/ehi', tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] }, ...stamp('2026-11-04T18:00:00Z') };
  const ccda = { resourceType: 'MedicationStatement', id: 's', status: 'active', medicationCodeableConcept: { text: 'Atorvastatin 40 MG Tablet' }, meta: { source: '/x/ccda.xml' }, ...stamp('2026-11-04T03:00:00Z') };
  const stopped = { resourceType: 'MedicationStatement', id: 'z', status: 'stopped', medicationCodeableConcept: { text: 'atorvastatin 40 mg tablet' }, meta: { source: '/x/old.pdf' } };
  const other = { resourceType: 'MedicationStatement', id: 'o', status: 'active', medicationCodeableConcept: { text: 'Lisinopril' }, ...stamp('2026-11-04T03:00:00Z') };
  // Statements are read before requests (each search in turn), as before.
  const rows = (await lists([ccda, ehi, stopped, other] as Resource[], 'all', [])).medications;
  expect(rows.map((r) => r.name?.toLowerCase())).toEqual(['atorvastatin 40 mg tablet', 'lisinopril']);
  expect(rows[0]).toMatchObject({ currency: 'current', source: 'ccda.xml; ehi; old.pdf', ids: ['s', 'z', 'r'], id: 's' });
  const cond = (id: string, src: string) => ({ resourceType: 'Condition', id, clinicalStatus: { coding: [{ code: 'active' }] }, category: [{ coding: [{ code: 'problem-list-item' }] }], code: { text: 'Asthma' }, meta: { source: src } });
  const p = (await lists([cond('1', '/a/one'), cond('2', '/a/two')] as Resource[], undefined, [])).problems;
  expect(p).toHaveLength(1);
  expect(p[0]).toMatchObject({ source: 'one; two', ids: ['1', '2'] });
});

test('medications: a C-CDA planned or proposed MedicationRequest is not current (listed as planned with include all); a portal\'s is as before', async () => {
  const tag = (code: string) => ({ meta: { tag: [{ system: 'urn:ga-server:tag', code }] } });
  const req = (id: string, src: string, intent?: string) => ({ resourceType: 'MedicationRequest', id, status: 'active', ...(intent && { intent }), medicationCodeableConcept: { text: `Drug ${id}` }, ...tag(src) });
  const rows = [req('plan', 'src-ccda', 'plan'), req('prop', 'src-ccda', 'proposal'), req('order', 'src-ccda', 'order'), req('none', 'src-ccda'), req('portal', 'src-smart', 'plan')] as Resource[];
  expect((await lists(rows)).medications.map((r) => r.id).sort()).toEqual(['none', 'order', 'portal']);
  const got = (await lists(rows, 'all')).medications;
  expect(got.filter((r) => r.currency === 'planned').map((r) => r.id).sort()).toEqual(['plan', 'prop']);
  expect(got.filter((r) => r.currency === 'planned').map((r) => r.reason)).toEqual([expect.stringMatching(/planned/), expect.stringMatching(/planned/)]);
  expect(got.map((r) => r.currency).indexOf('planned')).toBeGreaterThan(got.map((r) => r.currency).lastIndexOf('current'));
});

// Medplum and GA's store refuse a page over 1000 entries, includes counted: a search with _include asks for at most 500 matches.
test('listsByKind: searches with _include ask for at most 500 per page', async () => {
  const asked: [string, URLSearchParams][] = [];
  const client = { search: async (t: string, q: URLSearchParams) => { asked.push([t, q]); return { resourceType: 'Bundle', entry: [] }; },
    readResource: async () => ({ resourceType: 'Patient', extension: [{ url: NEWEST_IMPORT, valueDateTime: T0 }] }) } as unknown as MedplumClient;
  await listsByKind(client, 'p1', []);
  for (const [t, q] of asked) expect([t, q.get('_count')]).toEqual([t, q.has('_include') ? '500' : '1000']);
  expect(asked.filter(([, q]) => q.has('_include')).length).toBe(2);
});

// health_summary reads the lists page by page: each page's included Medications name its medications; the same rows as one page.
test('listsByKind: page by page, the same rows as one page per search', async () => {
  const two = [...all, { resourceType: 'MedicationRequest', id: 'a2', status: 'active', authoredOn: '2026-02-02', medicationReference: { reference: 'Medication/m1' }, ...seen(T0) }] as Resource[];
  // Each type's matches one per page, a referenced Medication included in that page.
  const pages = (t: string) => two.filter((r) => r.resourceType === t).map((r) => [r, ...((r as { medicationReference?: unknown }).medicationReference ? [all[0]] : [])]);
  const page = (t: string, i: number) => ({ resourceType: 'Bundle', entry: (pages(t)[i] ?? []).map((resource) => ({ resource })), link: i + 1 < pages(t).length ? [{ relation: 'next', url: `http://h/fhir/R4/${t}?p=${i + 1}` }] : [] });
  const client = {
    search: async (t: string) => page(t, 0), get: async (url: string) => page(url.split('?')[0].split('/').at(-1)!, Number(url.split('p=')[1])),
    readResource: async () => ({ resourceType: 'Patient', extension: [{ url: NEWEST_IMPORT, valueDateTime: T0 }] }),
  } as unknown as MedplumClient;
  const got = await listsByKind(client, 'p1', [ep]);
  expect(got).toEqual(await lists(two));
  expect(got.medications.map((r) => r.name)).toContain('Metformin 500 mg');
});
