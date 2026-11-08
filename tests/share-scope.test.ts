import { afterEach, expect, test, vi } from 'vitest';
import type { Patient, Resource } from '@medplum/fhirtypes';
import { OperationOutcomeError, preconditionFailed, type MedplumClient } from '@medplum/core';
import { COMPARTMENT_TYPES, dateOf, groupOf, inScope, loadScoped, newestEpicImport, scopedCache, selectScoped, storeNewestImport, trimPatient } from '../src/share/scope.ts';
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
  [r({ resourceType: 'Procedure' }), 'procedures'],
  [r({ resourceType: 'FamilyMemberHistory' }), 'family'],
  [r({ resourceType: 'Communication' }), 'messages'],
  [obs('social-history'), undefined],
  [r({ resourceType: 'Observation', code: { text: 'x' }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'extracted-by-llm' }] } }), 'labs'],
  [r({ resourceType: 'Observation', code: { text: 'x' }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-pdf' }] } }), 'labs'],
  [r({ resourceType: 'Observation', code: { text: 'x' }, category: [], meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-pdf' }] } }), 'labs'],
  [obs('social-history', { meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-pdf' }] } }), undefined],
  [r({ resourceType: 'Observation', code: { text: 'x' }, meta: { tag: [{ system: 'other', code: 'src-pdf' }] } }), undefined],
  [r({ resourceType: 'Observation', code: { text: 'x' } }), undefined],
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
  r({ resourceType: 'Basic' }),
  r({ resourceType: 'Provenance' }),
  r({ resourceType: 'AuditEvent' }),
  r({ resourceType: 'Patient', id: 'p' }),
  r({ resourceType: 'Coverage' }),
  r({ resourceType: 'RelatedPerson' }),
  r({ resourceType: 'Account' }),
  r({ resourceType: 'Claim' }),
  r({ resourceType: 'ExplanationOfBenefit' }),
  r({ resourceType: 'Person' }),
  r({ resourceType: 'Group' }),
  r({ resourceType: 'ClaimResponse' }),
  r({ resourceType: 'Invoice' }),
  r({ resourceType: 'ChargeItem' }),
  r({ resourceType: 'CoverageEligibilityRequest' }),
  r({ resourceType: 'CoverageEligibilityResponse' }),
  r({ resourceType: 'EnrollmentRequest' }),
  r({ resourceType: 'Composition', section: [{ title: 'Insurance Providers', text: { status: 'generated', div: '<div>member ID</div>' } }] }), // C-CDA narrative incl. payers
  archive('urn:ga-server:id:ehi-archive'),
  archive('urn:ga-server:id:apple-health-archive'),
  archive('urn:ga-server:id:file'),
])('never shared, even with all: %#', (res) => {
  expect(inScope(res, share())).toBe(false);
  expect(inScope(res, share({ groups: ['notes'] }))).toBe(false);
});

test('a plain note is shared under notes', () => {
  expect(inScope(r({ resourceType: 'DocumentReference', date: '2025-02-01' }), share({ groups: ['notes'] }))).toBe(true);
});

test('recurrence and relapse conditions are standing regardless of date', () => {
  const since = share({ since: '2025-01-01' });
  expect(inScope(cond('recurrence', '2018-01-01'), since)).toBe(true);
  expect(inScope(cond('relapse', '2018-01-01'), since)).toBe(true);
  expect(inScope(cond('remission', '2018-01-01'), since)).toBe(false);
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

const inP = { meta: { compartment: [{ reference: 'Patient/p' }] } };
test('selectScoped follows support references only from in-scope records', () => {
  const ms = r({
    resourceType: 'MedicationStatement', status: 'active', ...inP,
    medicationReference: { reference: 'Medication/m1' },
    informationSource: { reference: 'Practitioner/pr1' },
    recorder: { reference: 'Practitioner/bad id&_id=x' },
    subject: { reference: 'Patient/p' },
    derivedFrom: [{ reference: 'Observation/o9' }],
  });
  const lab = obs('laboratory', { ...inP, performer: [{ reference: 'Practitioner/pr2' }, { reference: 'Organization/o2' }] });
  const note = r({ resourceType: 'DocumentReference', ...inP, content: [{ attachment: { url: 'Binary/00000000-0000-0000-0000-000000000001' } }] });
  const out = selectScoped([r({ resourceType: 'Patient', id: 'p', telecom: [{ value: '1' }], ...inP }), ms, lab, note], share({ groups: ['medications'] }));
  expect(out.resources).toEqual([ms]);
  expect(out.refs.sort()).toEqual(['Medication/m1', 'Practitioner/pr1']);
  const all = selectScoped([note], share());
  expect(all.refs).toEqual(['Binary/00000000-0000-0000-0000-000000000001']);
});

test('C-CDA record kinds: Goal and CareTeam are compartment records, a PractitionerRole is followed as support, RelatedPerson never', () => {
  expect(COMPARTMENT_TYPES).toEqual(expect.arrayContaining(['Goal', 'CareTeam', 'CarePlan']));
  expect(COMPARTMENT_TYPES).not.toContain('RelatedPerson');
  const team = r({ resourceType: 'CareTeam', ...inP, subject: { reference: 'Patient/p' }, participant: [{ member: { reference: 'PractitionerRole/pr3' } }] });
  expect(selectScoped([team], share()).refs).toEqual(['PractitionerRole/pr3']);
});

test("selectScoped drops records not in the share patient's compartment", () => {
  const other = obs('laboratory', { meta: { compartment: [{ reference: 'Patient/q' }] }, performer: [{ reference: 'Practitioner/px' }] });
  const none = obs('laboratory');
  const mine = obs('laboratory', inP);
  const out = selectScoped([other, none, mine], share());
  expect(out.resources).toEqual([mine]);
  expect(out.refs).toEqual([]);
});

test('never-shared types are not even fetched', () => {
  for (const t of ['Endpoint', 'Provenance', 'AuditEvent', 'Patient', 'Coverage', 'RelatedPerson', 'Account', 'Claim', 'ExplanationOfBenefit', 'Person', 'Group', 'ClaimResponse', 'Invoice', 'ChargeItem', 'CoverageEligibilityRequest', 'CoverageEligibilityResponse', 'EnrollmentRequest', 'Composition', 'Binary', 'Medication']) {
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
  await cached(c, share({ tokenHash: 'other' }));
  expect(load).toHaveBeenCalledTimes(4);
  vi.advanceTimersByTime(1001);
  const del = vi.spyOn(Map.prototype, 'delete');
  await cached(c, share());
  expect(load).toHaveBeenCalledTimes(5);
  expect(del.mock.calls.map(([k]) => k).sort()).toEqual(['s1:h', 's1:other', 's2:h']); // every expired entry evicted
  del.mockRestore();
  vi.useRealTimers();
});

test('selectScoped: a source-file DocumentReference is dropped and its Binary never followed; an inline note stays', () => {
  const src = r({ resourceType: 'DocumentReference', ...inP, identifier: [{ system: 'urn:ga-server:id:file', value: 'abc' }],
    content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/00000000-0000-0000-0000-000000000002' } }] });
  const note = r({ resourceType: 'DocumentReference', ...inP, date: '2025-02-01', content: [{ attachment: { contentType: 'text/plain', data: 'eA==' } }] });
  const out = selectScoped([src, note], share());
  expect(out.resources).toEqual([note]);
  expect(out.refs).toEqual([]);
});

test('selectScoped: newestImport covers the whole compartment, not just the share', () => {
  const ehi = (date: string, extra: object = {}) => r({ ...inP, meta: { ...inP.meta, tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] },
    extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: date }], ...extra });
  const med = ehi('2023-01-01T00:00:00Z', { resourceType: 'MedicationStatement', status: 'active' });
  const lab = ehi('2025-01-01T00:00:00Z', { resourceType: 'Observation', category: [{ coding: [{ code: 'laboratory' }] }] });
  const out = selectScoped([med, lab], share({ groups: ['medications'] }));
  expect(out.resources).toEqual([med]);
  expect(out.newestImport).toBe(Date.parse('2025-01-01T00:00:00Z'));
});

test('loadScoped fetches no Apple data for a share without the apple group', async () => {
  const queries = async (groups: Share['groups']) => {
    const qs: Record<string, string>[] = [];
    const client = {
      readResource: async () => ({ resourceType: 'Patient', id: 'p' }),
      searchResourcePages: async function* (_t: string, q: Record<string, string>) { qs.push(q); yield []; },
      searchResources: async () => [],
    } as unknown as MedplumClient;
    await loadScoped(client, share({ groups }));
    return qs;
  };
  for (const q of await queries(['labs', 'vitals'])) expect(q['_tag:not']).toBe('urn:ga-server:tag|src-apple-health');
  for (const g of ['all', ['labs', 'apple']] as Share['groups'][]) for (const q of await queries(g)) expect(q['_tag:not']).toBeUndefined();
});

test('newestEpicImport reads the date stored on the Patient and scans nothing; without it, it scans', async () => {
  let scans = 0;
  const client = (extension?: object[]) => ({
    readResource: async () => ({ resourceType: 'Patient', id: 'p', extension }),
    searchResourcePages: async function* () { scans++; yield []; },
  }) as unknown as MedplumClient;
  expect(await newestEpicImport(client([{ url: 'urn:ga-server:ext:newest-epic-import', valueDateTime: '2025-01-01T00:00:00.000Z' }]), 'p')).toBe(Date.parse('2025-01-01T00:00:00Z'));
  expect(scans).toBe(0);
  expect(await newestEpicImport(client(), 'p')).toBe(-Infinity);
  expect(scans).toBeGreaterThan(0);
});

test('newestEpicImport seeds the Patient after a finding scan; second call reads it; -Infinity writes nothing', async () => {
  let scans = 0;
  type P = { resourceType: 'Patient'; id: string; extension?: { url: string; valueDateTime?: string }[] };
  const writes: P[] = [];
  let patient: P = { resourceType: 'Patient', id: 'p' };
  const page = [{ resourceType: 'Condition', meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] }, extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2025-03-01T00:00:00Z' }] }];
  const mk = (pages: object[]) => ({
    readResource: async () => patient as never,
    searchResourcePages: async function* () { scans++; yield pages; },
    updateResource: async (r: typeof patient) => { writes.push(r); patient = r; return r; },
  }) as unknown as MedplumClient;
  const found = await newestEpicImport(mk(page), 'p');
  if (Number.isFinite(found)) {
    expect(writes).toHaveLength(1);
    expect(writes[0].extension?.[0].url).toBe('urn:ga-server:ext:newest-epic-import');
    scans = 0;
    expect(await newestEpicImport(mk(page), 'p')).toBe(found);
    expect(scans).toBe(0);
    expect(writes).toHaveLength(1);
  }
  expect(Number.isFinite(found)).toBe(true);
  patient = { resourceType: 'Patient', id: 'p' };
  writes.length = 0;
  expect(await newestEpicImport(mk([]), 'p')).toBe(-Infinity);
  expect(writes).toHaveLength(0);
});

test('storeNewestImport never moves the stored date back; a 412 re-reads and retries once', async () => {
  const mk = (stored: string | undefined, failures: number) => {
    const writes: { extension?: { valueDateTime?: string }[]; }[] = [];
    let reads = 0, fails = failures;
    const client = {
      readResource: async () => ({ resourceType: 'Patient', id: 'p', meta: { versionId: String(++reads) }, extension: stored ? [{ url: 'urn:ga-server:ext:newest-epic-import', valueDateTime: stored }] : [] }),
      updateResource: async (r: never, o: { headers: Record<string, string> }) => {
        if (fails-- > 0) throw new OperationOutcomeError(preconditionFailed);
        writes.push(r); expect(o.headers['If-Match']).toBe(`W/"${reads}"`); return r;
      },
    } as unknown as MedplumClient;
    return { client, writes, reads: () => reads };
  };
  const a = mk('2025-06-01T00:00:00.000Z', 0);
  await storeNewestImport(a.client, 'p', Date.parse('2025-01-01'));
  expect(a.writes).toHaveLength(0);
  const b = mk('2025-01-01T00:00:00.000Z', 0);
  await storeNewestImport(b.client, 'p', Date.parse('2025-06-01'));
  expect(b.writes[0].extension?.[0].valueDateTime).toBe('2025-06-01T00:00:00.000Z');
  const c = mk(undefined, 1);
  await storeNewestImport(c.client, 'p', Date.parse('2025-06-01'));
  expect(c.writes).toHaveLength(1);
  expect(c.reads()).toBe(2);
  const d = mk(undefined, 2);
  await expect(storeNewestImport(d.client, 'p', Date.parse('2025-06-01'))).rejects.toThrow();
});
