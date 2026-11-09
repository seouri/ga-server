// Medplum 5.2.14 packages/fhir-router/src/batch.test.ts, ported side by side (see harness.ts): Medplum runs processBatch over an
// in-memory repository with transactions on; here each bundle is POSTed to both servers. Medplum's live ga-test-parity project
// lacks the `transaction-bundles` feature, so where a test expects a transaction to fail as a whole, Medplum answers the failed
// entry and keeps the rest; the store's transactions are always atomic (README, "Deliberate differences"): `differs on purpose`.
import type { Bundle, BundleEntry, Patient, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, marker, paritySides, ref, same, type Side } from './harness.ts';

const tx = (s: Side, type: 'batch' | 'transaction', entry: BundleEntry[]) => s.call('POST', '', { resourceType: 'Bundle', type, entry });
// The entries' statuses of a 200 batch or transaction answer (anything else throws with the body).
async function statuses(s: Side, type: 'batch' | 'transaction', entry: BundleEntry[]): Promise<{ status?: string; text?: string; resource?: any; location?: string }[]> {
  const g = await tx(s, type, entry);
  if (g.status !== 200) throw new Error(`${s.name} ${type}: ${g.status} ${g.text}`);
  return (g.json as Bundle).entry!.map((e) => ({ status: e.response?.status, text: e.response?.outcome?.issue?.[0]?.details?.text, resource: e.resource, location: e.response?.location }));
}
const only = (es: { status?: string; text?: string }[]) => es.map((e) => [e.status, e.text]);
const answer = async (s: Side, body: unknown) => { const g = await s.call('POST', '', body); return [g.status, g.json?.issue?.[0]?.details?.text]; };
const jsonPatch = (ops: unknown) => ({ resourceType: 'Binary', contentType: 'application/json-patch+json', data: Buffer.from(JSON.stringify(ops), 'utf8').toString('base64') }) as Resource;
const birthDatePatch = { resourceType: 'Parameters', parameter: [{ name: 'operation', part: [
  { name: 'type', valueCode: 'add' }, { name: 'path', valueString: 'Patient' }, { name: 'name', valueString: 'birthDate' }, { name: 'value', valueDate: '1990-05-15' }] }] } as Resource;
const read = async (s: Side, location?: string) => (await s.call('GET', location!.replace(/\/_history\/.*$/, ''))).json;

describe.skipIf(SQLITE)('Medplum fhir-router batch.test.ts (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  test('Batch › Process batch with missing bundle type [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(await answer(s, { resourceType: 'Bundle' })).toEqual([400, 'Unrecognized bundle type: undefined']);
  }));

  test('Batch › Process batch with invalid bundle type [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(await answer(s, { resourceType: 'Bundle', type: 'xyz' })).toEqual([400, 'Unrecognized bundle type: xyz']);
  }));

  test('Batch › Process batch with missing entries [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(await answer(s, { resourceType: 'Bundle', type: 'batch' })).toEqual([400, 'Missing bundle entries']);
  }));

  test('Batch › Process batch success [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patientId = crypto.randomUUID(), observationId = crypto.randomUUID();
    const r = await statuses(s, 'batch', [
      { fullUrl: 'urn:uuid:' + patientId, request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', id: patientId } },
      { fullUrl: 'urn:uuid:' + observationId, request: { method: 'POST', url: 'Observation' },
        resource: { resourceType: 'Observation', status: 'final', id: observationId, subject: { reference: 'urn:uuid:' + patientId }, code: { text: 'test' } } },
      { request: { method: 'GET', url: 'Patient?_count=1' } },
      { request: { method: 'GET', url: 'Patient/' + crypto.randomUUID() } },
      { request: { method: 'DELETE', url: 'Patient/' + crypto.randomUUID() } },
    ]);
    expect(r.map((e) => e.status)).toEqual(['201', '201', '200', '404', '404']);
    expect(r[2].resource.entry).toHaveLength(1);
    const patient = await read(s, r[0].location);
    expect((await read(s, r[1].location)).subject.reference).toBe(`Patient/${patient.id}`);
  }));

  test('Batch › Process batch create success [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect((await statuses(s, 'batch', [{ request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient' } }])).map((e) => e.status)).toEqual(['201']);
  }));

  test('Batch › Process batch create missing resource [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect((await statuses(s, 'batch', [{ request: { method: 'POST', url: 'Patient' } }])).map((e) => e.status)).toEqual(['400']);
  }));

  test('Batch › Process batch create missing resourceType [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect((await statuses(s, 'batch', [{ request: { method: 'POST', url: 'Patient' }, resource: {} as Resource }])).map((e) => e.status)).toEqual(['400']);
  }));

  test('Batch › Process batch create ignore http fullUrl [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect((await statuses(s, 'batch', [{ fullUrl: 'https://example.com/ignore-this', request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient' } }])).map((e) => e.status)).toEqual(['201']);
  }));

  test('Batch › Process batch create does not rewrite identifier [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const id = crypto.randomUUID();
    const r = await statuses(s, 'batch', [{ fullUrl: 'urn:uuid:' + id, request: { method: 'POST', url: 'Patient' },
      resource: { resourceType: 'Patient', id, identifier: [{ system: 'https://github.com/synthetichealth/synthea', value: id }] } }]);
    expect(r.map((e) => e.status)).toEqual(['201']);
    expect((await read(s, r[0].location)).identifier[0].value).toBe(id);
  }));

  const markedPatient = (identifier: string) => ({ resourceType: 'Patient', identifier: [{ system: 'test', value: identifier }] }) as Patient;

  test('Batch › Process batch create ifNoneExist success [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const identifier = marker();
    const entry = { request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=' + identifier }, resource: markedPatient(identifier) } as BundleEntry;
    const r = await statuses(s, 'batch', [entry, entry]);
    expect(r.map((e) => e.status)).toEqual(['201', '200']);
    expect(r[1].location).toBe(r[0].location);
  }));

  test('Batch › Process batch create ifNoneExist multiple matches [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const identifier = marker();
    const r = await statuses(s, 'batch', [
      { request: { method: 'POST', url: 'Patient' }, resource: markedPatient(identifier) },
      { request: { method: 'POST', url: 'Patient' }, resource: markedPatient(identifier) },
      { request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=' + identifier }, resource: markedPatient(identifier) },
    ]);
    expect(r.map((e) => e.status)).toEqual(['201', '201', '412']);
  }));

  test('Batch › Use ifNoneExist result in other reference [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    const identifier = marker();
    const practitionerData = { resourceType: 'Practitioner', name: [{ given: ['Batch'], family: 'Test' }], identifier: [{ system: 'https://example.com', value: identifier }] } as Resource;
    const practitioner = await s.create(practitionerData);
    const urnUuid = 'urn:uuid:' + crypto.randomUUID();
    const r = await statuses(s, 'batch', [
      { fullUrl: urnUuid, request: { method: 'POST', url: 'Practitioner', ifNoneExist: 'identifier=https://example.com|' + identifier }, resource: practitionerData },
      { request: { method: 'POST', url: 'ServiceRequest' }, resource: { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: ref(patient),
        code: { coding: [{ system: 'http://loinc.org', code: '12345-6' }] }, requester: { reference: urnUuid } } },
    ]);
    expect(r[0].status).toBe('200');
    expect(r[1].resource.requester.reference).toBe(`Practitioner/${practitioner.id}`);
  }));

  test('Batch › Process batch update [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    expect((await statuses(s, 'batch', [{ request: { method: 'PUT', url: 'Patient/' + patient.id }, resource: { ...patient, active: true } }])).map((e) => e.status)).toEqual(['200']);
  }));

  test('Batch › Process batch update missing resource [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect((await statuses(s, 'batch', [{ request: { method: 'PUT', url: 'Patient/' + crypto.randomUUID() } }])).map((e) => e.status)).toEqual(['400']);
  }));

  test('Batch › Process batch patch [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    const url = 'Patient/' + patient.id;
    const r = await statuses(s, 'batch', [
      { request: { method: 'PATCH', url }, resource: jsonPatch([{ op: 'add', path: '/active', value: true }]) },
      { request: { method: 'PATCH', url }, resource: jsonPatch(null) },
      { request: { method: 'PATCH', url }, resource: jsonPatch({ foo: 'bar' }) },
    ]);
    expect(only(r)).toEqual([['200', 'All OK'], ['400', 'Decoded PATCH body must be an array'], ['400', 'Decoded PATCH body must be an array']]);
  }));

  test('Batch › Process batch patch Parameters [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', gender: 'unknown' });
    const op = (...part: object[]) => ({ name: 'operation', part });
    const r = await statuses(s, 'batch', [
      { request: { method: 'PATCH', url: 'Patient/' + patient.id }, resource: { resourceType: 'Parameters', parameter: [
        op({ name: 'op', valueCode: 'add' }, { name: 'path', valueString: '/name' }, { name: 'value', valueString: '[{"given":["Dave"],"family":"Smith"}]' }),
        op({ name: 'op', valueCode: 'copy' }, { name: 'from', valueString: '/name/0/family' }, { name: 'path', valueString: '/name/0/given/-' }),
        op({ name: 'op', valueCode: 'remove' }, { name: 'path', valueString: '/gender' }),
      ] } as Resource },
      { request: { method: 'PATCH', url: 'Patient/' + patient.id }, resource: { resourceType: 'Parameters' } },
    ]);
    expect(r.map((e) => e.status)).toEqual(['200', '400']);
    expect([r[0].resource.name[0].given, r[0].resource.gender]).toEqual([['Dave', 'Smith'], undefined]);
    expect(r[1].text).toBe('Decoded PATCH body must be an array');
  }));

  test('Batch › Process batch FHIRPath patch [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', active: false });
    const r = await statuses(s, 'batch', [{ request: { method: 'PATCH', url: 'Patient/' + patient.id }, resource: { resourceType: 'Parameters', parameter: [
      ...(birthDatePatch as any).parameter,
      { name: 'operation', part: [{ name: 'type', valueCode: 'replace' }, { name: 'path', valueString: 'Patient.active' }, { name: 'value', valueBoolean: true }] },
    ] } as Resource }]);
    expect(r.map((e) => e.status)).toEqual(['200']);
    expect([r[0].resource.birthDate, r[0].resource.active]).toEqual(['1990-05-15', true]);
  }));

  test('Batch › Process batch FHIRPath patch rewrites local references [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    const orgUrn = 'urn:uuid:' + crypto.randomUUID();
    const r = await statuses(s, 'batch', [
      { fullUrl: orgUrn, request: { method: 'POST', url: 'Organization' }, resource: { resourceType: 'Organization', name: 'Acme' } },
      { request: { method: 'PATCH', url: 'Patient/' + patient.id }, resource: { resourceType: 'Parameters', parameter: [{ name: 'operation', part: [
        { name: 'type', valueCode: 'add' }, { name: 'path', valueString: 'Patient' }, { name: 'name', valueString: 'managingOrganization' }, { name: 'value', valueReference: { reference: orgUrn } }] }] } as Resource },
    ]);
    expect(r.map((e) => e.status)).toEqual(['201', '200']);
    expect(r[1].resource.managingOrganization.reference).toBe(`Organization/${r[0].resource.id}`);
  }));

  test('Batch › If-Match preconditions › Batch FHIRPath PATCH with matching If-Match succeeds [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', active: false });
    const r = await statuses(s, 'batch', [{ request: { method: 'PATCH', url: 'Patient/' + patient.id, ifMatch: `W/"${patient.meta?.versionId}"` }, resource: birthDatePatch }]);
    expect([r[0].status, r[0].resource.birthDate]).toEqual(['200', '1990-05-15']);
  }));

  test('Batch › If-Match preconditions › Batch FHIRPath PATCH with stale If-Match fails with 412 [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', active: false });
    const r = await statuses(s, 'batch', [{ request: { method: 'PATCH', url: 'Patient/' + patient.id, ifMatch: 'W/"stale-version"' }, resource: birthDatePatch }]);
    expect(r[0].status).toBe('412');
    const unchanged = (await s.call('GET', 'Patient/' + patient.id)).json;
    expect([unchanged.birthDate, unchanged.meta.versionId]).toEqual([undefined, patient.meta?.versionId]);
  }));

  test('Batch › If-Match preconditions › Batch PUT with stale If-Match fails with 412 [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', active: false });
    const r = await statuses(s, 'batch', [{ request: { method: 'PUT', url: 'Patient/' + patient.id, ifMatch: 'W/"stale-version"' }, resource: { resourceType: 'Patient', id: patient.id, active: true } }]);
    expect(r[0].status).toBe('412');
    expect((await s.call('GET', 'Patient/' + patient.id)).json.active).toBe(false);
  }));

  test('differs on purpose: Batch › If-Match preconditions › Transaction PATCH with stale If-Match fails the whole transaction [fhir-router/src/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const patient = await s.create<Patient>({ resourceType: 'Patient', active: false });
      const g = await tx(s, 'transaction', [{ request: { method: 'PATCH', url: 'Patient/' + patient.id, ifMatch: 'W/"stale-version"' }, resource: birthDatePatch }]);
      return [g.status, g.json.resourceType === 'Bundle' ? g.json.entry.map((e: BundleEntry) => e.response?.status) : g.json.resourceType];
    });
    expect(medplum).toEqual([200, ['412']]); // without transaction-bundles: the failed entry is answered
    expect(store).toEqual([412, 'OperationOutcome']); // Medplum's own expectation (with the feature): the transaction fails
  });

  const serviceRequestPatch = async (s: Side, ops: unknown) => {
    const sr = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/' + crypto.randomUUID() } });
    return only(await statuses(s, 'batch', [{ request: { method: 'PATCH', url: 'ServiceRequest/' + sr.id }, resource: jsonPatch(ops) }]));
  };

  test('Batch › JSONPath error messages [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(await serviceRequestPatch(s, [{ op: 'replace', path: 'status', value: 'final' }])).toEqual([['400', 'Invalid JSON Pointer: status']]);
  }));

  test('Batch › JSONPatch error messages [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(await serviceRequestPatch(s, [{ op: 'not-an-op', path: '/status', value: 'final' }])).toEqual([['400', 'Invalid operation: not-an-op']]);
  }));

  // Medplum answers an unknown route `Not found`; the store names the route after it.
  test('Batch › Process batch patch invalid url [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const [e] = await statuses(s, 'batch', [{ request: { method: 'PATCH', url: 'Patient/123/$everything' } }]);
    expect(e.status).toBe('404');
    expect(e.text).toMatch(/^Not found/);
  }));

  test('Batch › Process batch patch missing resource [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(only(await statuses(s, 'batch', [{ request: { method: 'PATCH', url: 'Patient/' + crypto.randomUUID() } }])))
      .toEqual([['400', 'Patch entry must include a Binary or Parameters resource']]);
  }));

  // Medplum has two tests of this title: a Patient as the patch, and a Binary without data.
  test('Batch › Process batch patch wrong patch type [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const url = 'Patient/' + crypto.randomUUID();
    expect(only(await statuses(s, 'batch', [{ request: { method: 'PATCH', url }, resource: { resourceType: 'Patient' } }])))
      .toEqual([['400', 'Patch entry must include a Binary or Parameters resource']]);
    expect(only(await statuses(s, 'batch', [{ request: { method: 'PATCH', url }, resource: { resourceType: 'Binary' } as Resource }])))
      .toEqual([['400', 'Missing entry.resource.data']]);
  }));

  test('Batch › Process batch delete [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    expect((await statuses(s, 'batch', [{ request: { method: 'DELETE', url: 'Patient/' + patient.id } }])).map((e) => e.status)).toEqual(['200']);
  }));

  test('Batch › Process batch delete invalid URL [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect((await statuses(s, 'batch', [{ request: { method: 'DELETE', url: 'Patientx/12' } }])).map((e) => e.status)).toEqual(['404']);
  }));

  test('Batch › Process batch missing request [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(only(await statuses(s, 'batch', [{}]))).toEqual([['400', 'Missing Bundle entry request method']]);
  }));

  test('Batch › Process batch missing request.method [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(only(await statuses(s, 'batch', [{ request: { url: 'Patient' } as any, resource: { resourceType: 'Patient' } }]))).toEqual([['400', 'Missing Bundle entry request method']]);
  }));

  test('Batch › Process batch unsupported request.method [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect((await statuses(s, 'batch', [{ request: { method: 'XXX' as any, url: 'Patient' }, resource: { resourceType: 'Patient' } }])).map((e) => e.status)).toEqual(['404']);
  }));

  test('Batch › Process batch missing request.url [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    expect(only(await statuses(s, 'batch', [{ request: { method: 'POST' } as any, resource: { resourceType: 'Patient' } }]))).toEqual([['400', 'Missing Bundle entry request URL']]);
  }));

  test('Batch › Process batch not found [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const r = await statuses(s, 'batch', ['GET', 'POST', 'PUT'].map((method) => ({ request: { method: method as 'GET', url: 'x/x/x/x/x' } })));
    expect(r.map((e) => e.status)).toEqual(['404', '404', '404']);
  }));

  test('Batch › Process batch read history [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', name: [{ family: 'Foo', given: ['Bar'] }] });
    const r = await statuses(s, 'batch', [{ request: { method: 'GET', url: `Patient/${patient.id}/_history` } }]);
    expect([r[0].status, r[0].resource.type, r[0].resource.entry.length]).toEqual(['200', 'history', 1]);
  }));

  test('Batch › Conditional interactions [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const patientIdentifier = marker();
    const patient = await s.create<Patient>({ resourceType: 'Patient', identifier: [{ value: patientIdentifier }] });
    const newIdentifier = marker();
    const r = await statuses(s, 'batch', [
      { fullUrl: 'urn:uuid:' + crypto.randomUUID(), request: { method: 'PUT', url: `Patient?identifier=${patientIdentifier}` }, resource: patient },
      { fullUrl: 'urn:uuid:' + crypto.randomUUID(), request: { method: 'PUT', url: 'Patient?identifier=' + newIdentifier }, resource: { resourceType: 'Patient', identifier: [{ value: newIdentifier }] } },
      { fullUrl: 'urn:uuid:' + crypto.randomUUID(), request: { method: 'DELETE', url: 'Patient?identifier=' + marker() } },
    ]);
    expect(r.map((e) => e.status)).toEqual(['200', '201', '200']);
  }));

  // A Questionnaire and a Subscription whose criteria names it by its urn, written plain or URL-encoded.
  const questionnaireAndSubscription = async (s: Side, criteria: string) => {
    const r = await statuses(s, 'transaction', [
      { fullUrl: 'urn:uuid:e95d01cf-60ae-43f7-a8fc-0500a8b045bb', request: { method: 'POST', url: 'Questionnaire' },
        resource: { resourceType: 'Questionnaire', status: 'active', name: 'Example Questionnaire', title: 'Example Questionnaire', item: [{ linkId: 'q1', type: 'string', text: 'Question' }] } },
      { fullUrl: 'urn:uuid:14b4f91f-1119-40b8-b10e-3db77cf1c191', request: { method: 'POST', url: 'Subscription' },
        resource: { resourceType: 'Subscription', status: 'active', reason: 'Test', criteria,
          channel: { type: 'rest-hook', endpoint: 'urn:uuid:32178250-67a4-4ec9-89bc-d16f1d619403', payload: 'application/fhir+json' } } },
    ]);
    expect(r.map((e) => e.status)).toEqual(['201', '201']);
    expect((await read(s, r[1].location)).criteria).toMatch(/QuestionnaireResponse\?questionnaire=Questionnaire\/\w{8}-\w{4}-\w{4}-\w{4}-\w{12}/);
  };

  test('Batch › Process Transactions › Embedded urn:uuid [fhir-router/src/batch.test.ts]', () => same(sides, (s) =>
    questionnaireAndSubscription(s, 'QuestionnaireResponse?questionnaire=urn:uuid:e95d01cf-60ae-43f7-a8fc-0500a8b045bb')));

  test('Batch › Process Transactions › Encoded urn:uuid [fhir-router/src/batch.test.ts]', () => same(sides, (s) =>
    questionnaireAndSubscription(s, 'QuestionnaireResponse?questionnaire=urn%3Auuid%3Ae95d01cf-60ae-43f7-a8fc-0500a8b045bb')));

  // A transaction whose entries fail: Medplum (without transaction-bundles) answers 200 with each entry's status; the store
  // fails the transaction with the first failure, as Medplum's own test expects (with transactions on).
  const outcome = async (s: Side, entry: BundleEntry[]) => {
    const g = await tx(s, 'transaction', entry);
    return [g.status, g.json.resourceType === 'Bundle' ? g.json.entry.map((e: BundleEntry) => e.response?.status) : g.json.issue?.[0]?.details?.text];
  };

  test('differs on purpose: Batch › Process Transactions › Transaction update after create [fhir-router/src/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, (s) => outcome(s, [
      { fullUrl: 'urn:uuid:e95d01cf-60ae-43f7-a8fc-0500a8b045bb', request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', status: 'active' } as Resource },
      { fullUrl: 'urn:uuid:e95d01cf-60ae-43f7-a8fc-0500a8b045bb', request: { method: 'PUT', url: 'urn:uuid:e95d01cf-60ae-43f7-a8fc-0500a8b045bb' },
        resource: { id: 'urn:uuid:e95d01cf-60ae-43f7-a8fc-0500a8b045bb', resourceType: 'Patient', status: 'active', name: [{ given: ['Jane'], family: 'Doe' }] } as Resource },
    ]));
    expect(medplum).toEqual([200, ['400', '400']]);
    expect(store[0]).toBe(400);
  });

  // Medplum's in-memory repository does not validate; both servers refuse the AllergyIntolerance for its invariant ait-1
  // (no clinicalStatus), so this checks how the failure is answered.
  test('differs on purpose: Batch › Valid null [fhir-router/src/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, (s) => outcome(s, [{ fullUrl: 'urn:uuid:adf86b3c-c254-47df-9e2d-81c4a922f6e7', request: { method: 'POST', url: 'AllergyIntolerance' },
      resource: { resourceType: 'AllergyIntolerance', category: [null], patient: { display: 'patient' },
        _category: [{ extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unsupported' }] }] } as unknown as Resource }]));
    expect(medplum).toEqual([200, ['400']]);
    expect(store).toEqual([400, expect.stringMatching(/^Constraint ait-1 not met/)]);
  });

  // No Practitioner has the NPI: both conditional references fail (Medplum's in-memory repository leaves them as written).
  test('differs on purpose: Batch › Concurrent conditional create in transactions [fhir-router/src/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, (s) => {
      const [patientIdentifier, encounterIdentifier, conditionIdentifier] = [1, 2, 3].map(() => crypto.randomUUID());
      const practitioner = { reference: 'Practitioner?identifier=http://hl7.org.fhir/sid/us-npi|9941339108' };
      return outcome(s, [
        { fullUrl: 'urn:uuid:' + patientIdentifier, request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=http://example.com|' + patientIdentifier },
          resource: { resourceType: 'Patient', name: [{ given: ['Bobby' + patientIdentifier], family: 'Tables' }], gender: 'unknown', identifier: [{ system: 'http://example.com', value: patientIdentifier }] } },
        { request: { method: 'PUT', url: 'CareTeam?subject=urn:uuid:' + patientIdentifier + '&status=active&category=http://loinc.org|LA28865-6' },
          resource: { resourceType: 'CareTeam', status: 'active', category: [{ coding: [{ system: 'http://loinc.org', code: 'LA28865-6' }], text: 'Holistic Wellness Squad' }],
            subject: { reference: 'urn:uuid:' + patientIdentifier }, participant: [{ member: practitioner }] } },
        { fullUrl: 'urn:uuid:' + encounterIdentifier, request: { method: 'POST', url: 'Encounter' },
          resource: { resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
            subject: { reference: 'urn:uuid:' + patientIdentifier }, diagnosis: [{ condition: { reference: 'urn:uuid:' + conditionIdentifier } }] } },
        { fullUrl: 'urn:uuid:' + conditionIdentifier, request: { method: 'POST', url: 'Condition' },
          resource: { resourceType: 'Condition', verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
            subject: { reference: 'urn:uuid:' + patientIdentifier }, encounter: { reference: 'urn:uuid:' + encounterIdentifier }, asserter: practitioner,
            code: { coding: [{ system: 'http://snomed.info/sct', code: '83157008' }], text: 'FFI' } } },
      ]);
    });
    expect(medplum).toEqual([200, ['201', '400', '201', '400']]);
    expect(store).toEqual([400, expect.stringMatching(/^Conditional reference .* did not match any resources$/)]);
  });

  // Medplum's in-memory repository takes the id 12345 and an empty code; both servers refuse them (README: non-UUID ids).
  test('differs on purpose: Batch › Local reference resolution for update [fhir-router/src/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, (s) => outcome(s, [
      { fullUrl: 'urn:uuid:f1228716-b33c-420d-89ab-46fac9ebcc8b', request: { method: 'PUT', url: 'ServiceRequest/12345' },
        resource: { id: '12345', resourceType: 'ServiceRequest', intent: 'order', status: 'active', subject: { display: 'Test Patient' } } },
      { request: { method: 'POST', url: 'DiagnosticReport' }, resource: { resourceType: 'DiagnosticReport', code: {}, status: 'amended', basedOn: [{ reference: 'urn:uuid:f1228716-b33c-420d-89ab-46fac9ebcc8b' }] } },
    ]));
    expect(medplum).toEqual([200, ['400', '400']]);
    expect(store).toEqual([400, 'Missing required property']);
  });

  test('Batch › No self-assigned ID in upsert [fhir-router/src/batch.test.ts]', () => same(sides, async (s) => {
    const id = crypto.randomUUID();
    const r = await statuses(s, 'batch', [{ request: { method: 'PUT', url: 'Patient?_id=' + id }, resource: { resourceType: 'Patient', id } }]);
    expect([only(r), r[0].resource]).toEqual([[['400', 'Cannot provide ID for create by update']], undefined]);
  }));
});
