// Medplum 5.2.14 packages/server/src/fhir/repo.test.ts, ported side by side (see harness.ts): each repository call becomes
// its HTTP request (readResource GET, updateResource PUT, patchResource PATCH, conditionalUpdate PUT Type?query, ifMatch
// If-Match). Medplum's systemRepo powers that HTTP cannot have (custom meta.lastUpdated, meta.author, SQL reads) are left out
// where the test says so.
import type { Bundle, OperationOutcome, Patient, Questionnaire, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, paritySides, q, same, search, type Side } from './harness.ts';

const ifMatch = (v?: string) => ({ 'if-match': `W/"${v}"` });
const text = (o: OperationOutcome | undefined) => o?.issue?.[0]?.details?.text;

describe.skipIf(SQLITE)('Medplum repo.test.ts (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);
  const patient = (s: Side, r: Partial<Patient> = {}) => s.create<Patient>({ resourceType: 'Patient', ...r });
  const put = (s: Side, r: Resource, headers?: Record<string, string>) => s.call('PUT', `${r.resourceType}/${r.id}`, r, headers);

  // An undefined id, as a client that formats it into the path sends it.
  test('FHIR Repo › Read resource with undefined id [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const g = await s.call('GET', `Patient/${undefined}`);
    expect(g.status).toBeGreaterThanOrEqual(400);
    return g.status;
  }));

  test('FHIR Repo › Read resource with invalid id [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const g = await s.call('GET', 'Patient/x');
    expect(g.status).toBeGreaterThanOrEqual(400);
    return g.status;
  }));

  // readHistory options as _count (limit) and _offset. A negative _count or _offset is 400 in the store; Medplum clamps it.
  test('differs on purpose: FHIR Repo › Read history › options: %s [server/src/fhir/repo.test.ts]', async () => {
    const cases = [
      ['no options', '', ['v2', 'v1']], ['limit', '_count=1', ['v2']], ['offset', '_offset=1', ['v1']], ['limit and offset', '_count=1&_offset=1', ['v1']],
      ['negative offset', '_offset=-1', ['v2', 'v1']], ['large offset', '_offset=10000', []], ['negative limit', '_count=-1', ['v2', 'v1']], ['large limit', '_count=100000', ['v2', 'v1']],
    ] as const;
    const [medplum, store] = await both(sides, async (s) => {
      const v1 = await patient(s);
      const v2 = (await put(s, { ...v1, active: true })).json as Patient;
      expect(v2.meta?.versionId).not.toBe(v1.meta?.versionId);
      const versions: Record<string, string> = { [v1.meta!.versionId!]: 'v1', [v2.meta!.versionId!]: 'v2' };
      const out = [];
      for (const [, query] of cases) {
        const g = await s.call('GET', `Patient/${v1.id}/_history${query ? `?${query}` : ''}`);
        out.push(g.status === 200 ? (g.json as Bundle).entry?.map((e) => versions[e.resource!.meta!.versionId!]) ?? [] : g.status);
      }
      return out;
    });
    expect(medplum).toEqual(cases.map((c) => c[2]));
    expect(store).toEqual(cases.map((c) => (c[1].includes('-1') ? 400 : c[2])));
  });

  // R4 ids are case-sensitive: the store finds no Patient/<ID IN UPPER CASE> (404); Medplum's uuid column folds case and updates it.
  test('differs on purpose: FHIR Repo › Update patient [server/src/fhir/repo.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const patient1 = await patient(s, { name: [{ given: ['Update1'], family: 'Update1' }] });
      const upperId = patient1.id.toUpperCase();
      const upper = await put(s, { ...patient1, id: upperId, gender: 'unknown' });
      const patient2 = (await put(s, { ...patient1, active: true })).json as Patient;
      expect(patient2.id).toBe(patient1.id);
      expect(patient2.meta?.versionId).not.toBe(patient1.meta?.versionId);
      const read = await s.call('GET', `Patient/${upperId}`);
      return [upper.status, read.status, read.json?.meta?.versionId === patient2.meta?.versionId];
    });
    expect(medplum).toEqual([200, 200, true]);
    expect(store).toEqual([404, 404, false]);
  });

  test('FHIR Repo › Update patient remove meta.profile [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const profileUrl = 'http://example.com/patient-profile';
    const patient1 = await patient(s, { meta: { profile: [profileUrl] }, name: [{ given: ['Update1'], family: 'Update1' }] });
    expect(patient1.meta?.profile).toEqual([profileUrl]);
    const { profile: _p, ...meta } = patient1.meta!;
    const patient2 = (await put(s, { ...patient1, meta })).json as Patient;
    expect('profile' in patient2.meta!).toBe(false);
  }));

  test('FHIR Repo › Update patient no changes [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const patient1 = await patient(s, { name: [{ given: ['Update1'], family: 'Update1' }] });
    const patient2 = (await put(s, patient1)).json as Patient;
    expect(patient2.id).toBe(patient1.id);
    expect(patient2.meta?.versionId).toBe(patient1.meta?.versionId);
  }));

  test('FHIR Repo › Update patient multiple names [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const patient1 = await patient(s, { name: [{ given: ['Suzy'], family: 'Smith' }] });
    const patient2 = (await put(s, { ...patient1, name: [{ given: ['Suzy'], family: 'Smith' }, { given: ['Suzy'], family: 'Jones' }] })).json as Patient;
    expect(patient2.id).toBe(patient1.id);
    expect(patient2.meta?.versionId).not.toBe(patient1.meta?.versionId);
    expect(patient2.name?.map((n) => n.family)).toEqual(['Smith', 'Jones']);
  }));

  // Medplum's repository throws not-found; over HTTP its route answers before the repository (both sides compared).
  test('FHIR Repo › Create Patient with custom ID [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const id = crypto.randomUUID();
    const g = await s.call('PUT', `Patient/${id}`, { resourceType: 'Patient', id, name: [{ given: ['Alice'], family: 'Smith' }] });
    expect(g.status).toBeGreaterThanOrEqual(400);
    expect((await s.call('GET', `Patient/${id}`)).status).toBe(404);
    return g.status;
  }));

  test('FHIR Repo › Create Patient ignores submitted meta.deleted [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ given: ['Alice'], family: 'Smith' }], meta: { deleted: true } as Patient['meta'] });
    expect((p.meta as { deleted?: boolean }).deleted).toBeUndefined();
    const searchResult = await search(s, q('Patient', ['_id', p.id]));
    expect(searchResult.entry?.length).toBe(1);
    expect((searchResult.entry?.[0]?.resource as Patient).name?.[0]?.family).toBe('Smith');
  }));

  test('FHIR Repo › Update Patient ignores submitted meta.deleted [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ given: ['Alice'], family: 'Smith' }] });
    const updated = (await put(s, { ...p, name: [{ given: ['Alice'], family: 'Jones' }], meta: { ...p.meta, deleted: true } as Patient['meta'] })).json as Patient;
    expect((updated.meta as { deleted?: boolean }).deleted).toBeUndefined();
    const searchResult = await search(s, q('Patient', ['_id', p.id]));
    expect(searchResult.entry?.length).toBe(1);
    expect((searchResult.entry?.[0]?.resource as Patient).name?.[0]?.family).toBe('Jones');
  }));

  // Medplum's authored Repository and long descriptions: each one is stored.
  test('FHIR Repo › Create ResearchDefinition with long description (%s) [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const fourByteChars = '𓃒𓃔𓃕𓃖𓃗𓃘𓃙𓃚𓃛𓃜𓃝𓃞𓃟𓃠𓃡𓃢𓃥𓃦𓃧𓃩𓃪𓃭𓃮𓃯𓃰𓃱𓃲𓄁𓅂𓅃𓅠𓅚';
    const random = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64');
    for (const description of [random(2050), random(5000), [...fourByteChars.repeat(100)].sort(() => Math.random() - 0.5).join('')]) {
      const r = await s.create({ resourceType: 'ResearchDefinition', status: 'active', population: { reference: '123' }, description });
      expect(r.description).toBe(description);
    }
  }));

  // The server sets lastUpdated on an update, whatever the request says.
  test('FHIR Repo › Update resource with lastUpdated [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const lastUpdated = '2020-01-01T12:00:00Z';
    const patient1 = await patient(s, { name: [{ given: ['Alice'], family: 'Smith' }] });
    const patient2 = (await put(s, { ...patient1, active: true, meta: { lastUpdated } })).json as Patient;
    expect(patient2.meta?.lastUpdated).not.toBe(lastUpdated);
  }));

  test('FHIR Repo › Update resource with missing id [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const { id, ...rest } = await patient(s, { name: [{ family: 'Test' }] });
    const g = await s.call('PUT', `Patient/${id}`, rest);
    expect(g.status).toBe(400);
    return g.status;
  }));

  test('FHIR Repo › Update resource with matching versionId [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await put(s, { ...p, name: [{ family: 'TestUpdated' }] }, ifMatch(p.meta?.versionId));
    expect([g.status, g.json.name[0].family]).toEqual([200, 'TestUpdated']);
  }));

  test('FHIR Repo › Update resource with different versionId [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await put(s, p, ifMatch('bad-id'));
    expect(g.status).toBe(412);
    return g.json.id;
  }));

  const jsonPatch = (s: Side, p: { id: string }, ops: unknown, headers: Record<string, string> = {}) => s.call('PATCH', `Patient/${p.id}`, ops, { 'content-type': 'application/json-patch+json', ...headers });
  test('FHIR Repo › Patch resource with matching versionId [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await jsonPatch(s, p, [{ op: 'replace', path: '/name/0/family', value: 'TestUpdated' }], ifMatch(p.meta?.versionId));
    expect([g.status, g.json.name[0].family]).toEqual([200, 'TestUpdated']);
  }));

  test('FHIR Repo › Patch resource with different versionId [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await jsonPatch(s, p, [{ op: 'add', path: '/birthDate', value: '1993-09-14' }], ifMatch('bad-id'));
    expect(g.status).toBe(412);
    return g.json.id;
  }));

  // Medplum's tail (a cache-only Subscription) is about its resource cache and is left out.
  test('FHIR Repo › Delete resource with ifMatch [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s);
    const updated = (await put(s, { ...p, active: true })).json as Patient;
    expect((await s.call('DELETE', `Patient/${p.id}`, undefined, ifMatch(p.meta?.versionId))).status).toBe(412);
    expect((await s.call('GET', `Patient/${p.id}`)).json.active).toBe(true);
    expect((await s.call('DELETE', `Patient/${p.id}`, undefined, ifMatch(updated.meta?.versionId))).status).toBe(200);
    expect((await s.call('DELETE', `Patient/${p.id}`, undefined, ifMatch(updated.meta?.versionId))).status).toBe(412);
    expect((await s.call('DELETE', `Patient/${p.id}`)).status).toBe(200);
  }));

  test('FHIR Repo › Patch resource with implicit array creation [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await jsonPatch(s, p, [{ op: 'add', path: '/identifier/-', value: { system: 'https://example.com', value: '123' } }]);
    expect(g.json.identifier).toEqual([{ system: 'https://example.com', value: '123' }]);
  }));

  const fhirPatch = (s: Side, p: { id: string }, body: unknown) => s.call('PATCH', `Patient/${p.id}`, body);
  test('FHIR Repo › Patch resource with FHIRPath Patch body [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await fhirPatch(s, p, { resourceType: 'Parameters', parameter: [{ name: 'operation', part: [
      { name: 'type', valueCode: 'add' }, { name: 'path', valueString: `Patient.name.where(family = 'Test')` }, { name: 'name', valueString: 'given' }, { name: 'value', valueString: 'Jan' }] }] });
    expect(g.json.name[0].given).toEqual(['Jan']);
  }));

  test('FHIR Repo › Patch resource with empty FHIRPath Patch body [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await fhirPatch(s, p, { resourceType: 'Parameters', parameter: [{ name: 'operation', part: [{ name: 'type', valueCode: 'unsupported' }, { name: 'path', valueString: 'Patient' }] }] });
    expect(g.json.meta.versionId).toBe(p.meta?.versionId);
  }));

  test('FHIR Repo › Patch resource with invalid FHIRPath Patch body [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s, { name: [{ family: 'Test' }] });
    const g = await fhirPatch(s, p, { resourceType: 'Parameters' });
    expect(g.json.meta.versionId).toBe(p.meta?.versionId);
  }));

  // The history half as Medplum; its SQL read of the tombstone row is internal and left out. The restore (a PUT of the
  // deleted Patient) is 410 in the store (README: PUT or PATCH of a deleted record).
  test('differs on purpose: FHIR Repo › Read history after delete [server/src/fhir/repo.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const p = await patient(s, { name: [{ given: ['Alice'], family: 'Smith' }] });
      const history = async () => (await s.call('GET', `Patient/${p.id}/_history`)).json as Bundle;
      expect((await history()).entry?.length).toBe(1);
      await s.call('DELETE', `Patient/${p.id}`);
      const history2 = await history();
      expect(history2.entry?.length).toBe(2);
      expect([history2.entry?.[0]?.request?.method, history2.entry?.[0]?.request?.url]).toEqual(['DELETE', `Patient/${p.id}`]);
      expect(history2.entry?.[0]?.response?.status).toBe('410');
      expect(text(history2.entry?.[0]?.response?.outcome as OperationOutcome)).toMatch(/Deleted on /);
      expect(history2.entry?.[0]?.resource).toBeUndefined();
      const restored = await s.call('PUT', `Patient/${p.id}`, { ...p, meta: undefined });
      return [restored.status, (await history()).entry?.map((e) => e.response?.status)];
    });
    expect(medplum).toEqual([200, ['200', '410', '200']]);
    expect(store).toEqual([410, ['410', '200']]);
  });

  test('differs on purpose: FHIR Repo › Restore deleted resource [server/src/fhir/repo.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const p = await patient(s, { name: [{ given: ['Alice'], family: 'Smith' }] });
      await s.call('DELETE', `Patient/${p.id}`);
      const history = (await s.call('GET', `Patient/${p.id}/_history`)).json as Bundle<Patient>;
      expect(history.entry?.some((e) => e.response?.status === '410' && (e.response.outcome as OperationOutcome)?.issue?.some((i) => i.code === 'deleted'))).toBe(true);
      const latest = history.entry?.find((e) => e.response?.status === '200' && e.resource)?.resource as Patient;
      const restored = await s.call('PUT', `Patient/${p.id}`, latest);
      return [restored.status, restored.json?.name?.[0]?.family, (await s.call('GET', `Patient/${p.id}`)).status,
        (await search(s, q('Patient', ['_id', p.id]))).entry?.length ?? 0, (await s.call('GET', `Patient/${p.id}/_history`)).json.entry.length];
    });
    expect(medplum).toEqual([200, 'Smith', 200, 1, 3]);
    expect(store).toEqual([410, undefined, 410, 0, 2]);
  });

  test('FHIR Repo › Remove property [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const value = crypto.randomUUID();
    const patient1 = await patient(s, { name: [{ given: ['Identifier'], family: 'Test' }], identifier: [{ system: 'https://example.com/', value }] });
    expect((await search(s, q('Patient', ['identifier', value]))).entry?.length).toBe(1);
    const { identifier: _i, ...rest } = patient1;
    const patient2 = (await put(s, rest)).json as Patient;
    expect(patient2.identifier).toBeUndefined();
    expect((await search(s, q('Patient', ['identifier', value]))).entry?.length ?? 0).toBe(0);
  }));

  test('FHIR Repo › Delete Questionnaire.subjectType [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const nonce = crypto.randomUUID();
    const resource1 = await s.create<Questionnaire>({ resourceType: 'Questionnaire', status: 'active', subjectType: [nonce as 'Patient'] });
    expect((await search(s, q('Questionnaire', ['subject-type', nonce]))).entry?.length).toBe(1);
    delete resource1.subjectType;
    expect((await put(s, resource1)).status).toBe(200);
    expect((await search(s, q('Questionnaire', ['subject-type', nonce]))).entry?.length ?? 0).toBe(0);
  }));

  test('FHIR Repo › Empty objects [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const patient1 = await patient(s, { contact: [{ name: { given: ['Test'] } }] });
    const patient2 = (await put(s, { resourceType: 'Patient', id: patient1.id, contact: [{ name: { given: ['Test'] } }] })).json as Patient;
    expect(patient2.id).toBe(patient1.id);
  }));

  // Medplum ids must be UUIDs (400 Invalid id); R4 allows the id 123, so the store looks it up and finds no Patient/123 (404).
  test('differs on purpose: FHIR Repo › Malformed client assigned ID [server/src/fhir/repo.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => (await s.call('PUT', 'Patient/123', { resourceType: 'Patient', id: '123' })).status);
    expect([medplum, store]).toEqual([400, 404]);
  });

  test('FHIR Repo › Conditional update [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const mrn = crypto.randomUUID();
    const query = `identifier=${encodeURIComponent(`http://example.com/mrn|${mrn}`)}`;
    const p: Patient = { resourceType: 'Patient', identifier: [{ system: 'http://example.com/mrn', value: mrn }] };
    const out: unknown[] = [];
    const cu = async (r: Patient, type = 'Patient') => { const g = await s.call('PUT', `${type}?${query}`, r); out.push([g.status, text(g.json)]); return g; };
    expect((await cu(p, 'Observation')).status).toBe(400); // search type must match the resource type
    expect((await cu({ ...p, id: crypto.randomUUID() })).status).toBe(400); // create with a client-assigned id
    const create = await cu(p);
    expect(create.status).toBe(201);
    const update = await cu({ ...p, gender: 'unknown' });
    expect([update.status, update.json.id, update.json.gender]).toEqual([200, create.json.id, 'unknown']);
    expect((await cu({ ...p, gender: 'unknown', id: crypto.randomUUID() })).status).toBe(400); // id differs from the match
    const duplicate = await s.create({ ...p, gender: 'unknown' });
    expect(duplicate.id).not.toBe(create.json.id);
    const ambiguous = await cu({ ...p, gender: 'unknown' });
    expect([ambiguous.status, text(ambiguous.json)]).toEqual([412, 'Multiple resources found matching condition']);
    return out.slice(2).map((x) => (x as unknown[])[0]);
  }));

  test('FHIR Repo › Double DELETE [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const p = await patient(s);
    expect((await s.call('DELETE', `Patient/${p.id}`)).status).toBe(200);
    expect((await s.call('DELETE', `Patient/${p.id}`)).status).toBe(200);
  }));

  const npi = (v: string) => ({ reference: `Practitioner?identifier=http://hl7.org.fhir/sid/us-npi|${v}` });
  // meta.account and meta.accounts are Medplum's (project accounts, not R4): the port resolves generalPractitioner only.
  test('FHIR Repo › Conditional reference resolution [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const practitionerIdentifier = crypto.randomUUID();
    const practitioner = await s.create({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org.fhir/sid/us-npi', value: practitionerIdentifier }] });
    const p = await patient(s, { generalPractitioner: [npi(practitionerIdentifier)] });
    expect(p.generalPractitioner?.[0]?.reference).toBe(`Practitioner/${practitioner.id}`);
  }));

  test('FHIR Repo › Conditional reference resolution failure [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const g = await s.call('POST', 'Patient', { resourceType: 'Patient', generalPractitioner: [npi(crypto.randomUUID())] });
    expect(g.status).toBe(400);
    expect(text(g.json)).toMatch(/did not match any resources/);
  }));

  test('FHIR Repo › Conditional reference resolution multiple matches [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const practitionerIdentifier = crypto.randomUUID();
    for (let i = 0; i < 2; i++) await s.create({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org.fhir/sid/us-npi', value: practitionerIdentifier }] });
    const g = await s.call('POST', 'Patient', { resourceType: 'Patient', generalPractitioner: [npi(practitionerIdentifier)] });
    expect(g.status).toBe(400);
    expect(text(g.json)).toMatch(/matched multiple resources/);
  }));

  test('FHIR Repo › Conditional reference replaced before validation [server/src/fhir/repo.test.ts]', () => same(sides, async (s) => {
    const mrn = crypto.randomUUID();
    await patient(s, { identifier: [{ value: mrn }] });
    const g = await s.call('POST', 'ServiceRequest', {
      resourceType: 'ServiceRequest', status: 'active', intent: 'order',
      code: { coding: [{ system: 'http://snomed.info/sct', code: '308471005', display: 'Referral to cardiologist' }] },
      subject: { reference: 'Patient?identifier=' + mrn },
      performerType: [{ coding: [{ system: 'http://snomed.info/sct', code: '17561000', display: 'Cardiologist' }] }],
    });
    // Medplum's repository error is the text with its expression in parentheses; over HTTP they are two fields.
    expect([g.status, text(g.json), g.json.issue[0].expression]).toEqual([400, 'Expected single value for property', ['ServiceRequest.performerType']]);
  }));
});
