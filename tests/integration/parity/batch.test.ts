// Medplum 5.2.14 packages/server/src/fhir/batch.test.ts and binary.test.ts, ported side by side (see harness.ts): the same
// HTTP requests to both servers. Medplum's batch metrics (otel histograms) are internal and left out.
// Medplum's test project has its `transaction-bundles` feature (atomic transactions); the live ga-test-parity project does not,
// so where a test checks a rollback, Medplum keeps the entries before the failure. The store's transactions are always atomic
// (README, "Deliberate differences"): those ports are `differs on purpose`.
import { gzipSync, deflateSync } from 'node:zlib';
import type { Bundle, BundleEntry, Patient, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, paritySides, q, ref, same, search, type Side } from './harness.ts';

const idSystem = 'http://example.com/uuid';
const tx = (s: Side, type: 'batch' | 'transaction', entry: BundleEntry[]) => s.call('POST', '', { resourceType: 'Bundle', type, entry });
const statuses = (b: Bundle) => b.entry?.map((e) => e.response?.status);
const genderPatch = (value: string) => ({ resourceType: 'Parameters', parameter: [{ name: 'operation', part: [
  { name: 'type', valueCode: 'add' }, { name: 'path', valueString: 'Patient' }, { name: 'name', valueString: 'gender' }, { name: 'value', valueCode: value }] }] }) as Resource;
const npi = (v: string) => ({ reference: `Practitioner?identifier=http://hl7.org.fhir/sid/us-npi|${v}` });
const B = 'Batch and Transaction processing › ';

describe.skipIf(SQLITE)('Medplum batch.test.ts and binary.test.ts (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  // Six entries (two creates, an empty search, a delete, an update, a missing read) and the start of the transaction tests.
  const sixEntries = async (s: Side) => {
    const practitioner = await s.create({ resourceType: 'Practitioner' });
    const toDelete = await s.create({ resourceType: 'Patient' });
    const id1 = crypto.randomUUID(), id2 = crypto.randomUUID();
    const entry: BundleEntry[] = [
      { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', identifier: [{ system: idSystem, value: id1 }] } },
      { request: { method: 'GET', url: `Patient?identifier=${idSystem}|${crypto.randomUUID()}` } },
      { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', identifier: [{ system: idSystem, value: id2 }] } },
      { request: { method: 'DELETE', url: `Patient/${toDelete.id}` } },
      { request: { method: 'PUT', url: `Practitioner/${practitioner.id}` }, resource: { ...practitioner, gender: 'unknown' } },
    ];
    return { practitioner, toDelete, id1, id2, entry };
  };

  test('Batch and Transaction processing › Batch success [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const { id1, id2, entry } = await sixEntries(s);
    const res = await tx(s, 'batch', [...entry, { request: { method: 'GET', url: 'Practitioner/does-not-exist' } }]);
    expect(res.status).toBe(200);
    const results = res.json as Bundle;
    expect([results.resourceType, results.type, statuses(results)]).toEqual(['Bundle', 'batch-response', ['201', '200', '201', '200', '200', '404']]);
    expect(results.entry?.[0]?.resource).toMatchObject({ resourceType: 'Patient', identifier: [{ system: idSystem, value: id1 }] });
    expect(results.entry?.[1]?.resource).toMatchObject({ resourceType: 'Bundle', type: 'searchset' });
    expect((results.entry?.[1]?.resource as Bundle).entry).toBeUndefined();
    expect(results.entry?.[2]?.resource).toMatchObject({ resourceType: 'Patient', identifier: [{ system: idSystem, value: id2 }] });
    expect(results.entry?.[3]?.resource).toBeUndefined();
    expect(results.entry?.[4]?.resource).toMatchObject({ resourceType: 'Practitioner', gender: 'unknown' });
    expect(results.entry?.[5]?.resource).toBeUndefined();
  }));

  // Medplum's test posts to its project-scoped URL with a client token; here, the same base.
  test('Batch and Transaction processing › FHIRPath Patch in batch [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const res = await tx(s, 'batch', [{ request: { method: 'PATCH', url: `Patient/${patient.id}` }, resource: genderPatch('unknown') }]);
    expect(res.status).toBe(200);
    expect(res.json.entry[0].response.status).toBe('200');
    expect(res.json.entry[0].resource).toMatchObject({ resourceType: 'Patient', gender: 'unknown' });
    expect((await s.call('GET', `Patient/${patient.id}`)).json).toMatchObject({ resourceType: 'Patient', gender: 'unknown' });
  }));

  test('Batch and Transaction processing › Transaction success [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const { toDelete, id1, id2, entry } = await sixEntries(s);
    const relatedPerson = await s.create({ resourceType: 'RelatedPerson', patient: ref(toDelete) });
    const createdPatientIdentity = 'urn:uuid:c5db5c3b-bd41-4c39-aa8e-2d2a9a038167';
    entry[0].fullUrl = createdPatientIdentity;
    const res = await tx(s, 'transaction', [...entry,
      { request: { method: 'GET', url: 'RelatedPerson' } },
      { request: { method: 'PUT', url: `RelatedPerson?patient=Patient/${toDelete.id}` }, resource: { ...relatedPerson, patient: { reference: createdPatientIdentity } } },
    ]);
    expect(res.status).toBe(200);
    const results = res.json as Bundle;
    expect([results.type, statuses(results)]).toEqual(['transaction-response', ['201', '200', '201', '200', '200', '200', '200']]);
    const createdPatient = results.entry?.[0]?.resource as Patient;
    expect(createdPatient).toMatchObject({ resourceType: 'Patient', identifier: [{ system: idSystem, value: id1 }] });
    expect(results.entry?.[1]?.resource).toMatchObject({ resourceType: 'Bundle', type: 'searchset' });
    expect((results.entry?.[1]?.resource as Bundle).entry).toBeUndefined();
    expect(results.entry?.[2]?.resource).toMatchObject({ resourceType: 'Patient', identifier: [{ system: idSystem, value: id2 }] });
    expect(results.entry?.[3]?.resource).toBeUndefined();
    expect(results.entry?.[4]?.resource).toMatchObject({ resourceType: 'Practitioner', gender: 'unknown' });
    expect(results.entry?.[5]?.resource).toMatchObject({ resourceType: 'Bundle', type: 'searchset', entry: [expect.objectContaining({ resource: expect.objectContaining({ resourceType: 'RelatedPerson' }) })] });
    expect(results.entry?.[6]?.resource).toMatchObject({ resourceType: 'RelatedPerson', patient: { reference: `Patient/${createdPatient.id}` } });
  }));

  test('differs on purpose: Batch and Transaction processing › Transaction rollback [server/src/fhir/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const { practitioner, toDelete, entry } = await sixEntries(s);
      const res = await tx(s, 'transaction', [...entry, { request: { method: 'POST', url: 'Practitioner' }, resource: { ...practitioner, gender: ['male', 'female'] } as unknown as Resource }]);
      return [res.status, res.json.resourceType, (await s.call('GET', `Patient/${toDelete.id}`)).status];
    });
    expect(medplum).toEqual([200, 'Bundle', 410]); // without transaction-bundles: the failed entry is answered, the delete kept
    expect(store).toEqual([400, 'OperationOutcome', 200]); // Medplum's own expectation (with the feature)
  });

  test('Batch and Transaction processing › Create batch wrong content type [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    expect((await s.call('POST', '', 'hello', { 'content-type': 'text/plain' })).status).toBe(400);
  }));

  test('Batch and Transaction processing › Conditional create in transaction [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const [patientIdentifier, encounterIdentifier, conditionIdentifier, practitionerIdentifier] = [1, 2, 3, 4].map(() => crypto.randomUUID());
    await s.create({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org.fhir/sid/us-npi', value: practitionerIdentifier }] });
    const res = await tx(s, 'transaction', [
      { fullUrl: 'urn:uuid:' + patientIdentifier, request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=http://example.com|' + patientIdentifier },
        resource: { resourceType: 'Patient', name: [{ given: ['Bobby' + patientIdentifier], family: 'Tables' }], gender: 'unknown', identifier: [{ system: 'http://example.com', value: patientIdentifier }] } },
      { fullUrl: 'urn:uuid:' + encounterIdentifier, request: { method: 'POST', url: 'Encounter' },
        resource: { resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: 'urn:uuid:' + patientIdentifier }, diagnosis: [{ condition: { reference: 'urn:uuid:' + conditionIdentifier } }] } },
      { fullUrl: 'urn:uuid:' + conditionIdentifier, request: { method: 'POST', url: 'Condition' },
        resource: { resourceType: 'Condition', verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
          subject: { reference: 'urn:uuid:' + patientIdentifier }, encounter: { reference: 'urn:uuid:' + encounterIdentifier }, asserter: npi(practitionerIdentifier), code: { coding: [{ system: 'http://snomed.info/sct', code: '83157008' }], text: 'FFI' } } },
      { request: { method: 'POST', url: 'Observation' }, resource: { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '31989-7' }], text: 'Prion test' },
        subject: { reference: 'urn:uuid:' + patientIdentifier }, valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA6576-8', display: 'Positive' }] } } },
      { request: { method: 'POST', url: 'Task' }, resource: { resourceType: 'Task', status: 'requested', intent: 'plan', encounter: { reference: 'urn:uuid:' + encounterIdentifier }, owner: npi(practitionerIdentifier), description: 'Follow up regarding prognosis' } },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.entry[0].response.status).toBe('201');
  }));

  test('Batch and Transaction processing › Conditional update in transaction [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const patientIdentifier = crypto.randomUUID();
    const patient = await s.create({ resourceType: 'Patient', identifier: [{ value: patientIdentifier }] });
    const res = await tx(s, 'transaction', [{ fullUrl: 'urn:uuid:' + patientIdentifier, request: { method: 'PUT', url: 'Patient?identifier=' + patientIdentifier }, resource: patient }]);
    expect(res.status).toBe(200);
    expect(res.json.entry[0].response.status).toBe('200');
  }));

  test('Batch and Transaction processing › Transaction bundle with ifMatch version checking [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const patient1 = await s.create<Patient>({ resourceType: 'Patient', name: [{ family: 'Doe', given: ['Jane'] }] });
    const patient2 = await s.create<Patient>({ resourceType: 'Patient', name: [{ family: 'Johnson', given: ['Bob'] }], active: true });
    const res = await tx(s, 'transaction', [
      { request: { method: 'PUT', url: `Patient/${patient1.id}`, ifMatch: `W/"${patient1.meta?.versionId}"` }, resource: { ...patient1, name: [{ family: 'Smith', given: ['John'] }] } },
      { request: { method: 'PUT', url: `Patient/${patient2.id}`, ifMatch: `W/"${patient2.meta?.versionId}"` }, resource: { ...patient2, active: false } },
    ]);
    expect([res.status, statuses(res.json)]).toEqual([200, ['200', '200']]);
    expect((await s.call('GET', `Patient/${patient1.id}`)).json.name[0]).toEqual({ family: 'Smith', given: ['John'] });
    expect((await s.call('GET', `Patient/${patient2.id}`)).json.active).toBe(false);
  }));

  test('differs on purpose: Batch and Transaction processing › Transaction bundle with ifMatch fails on version mismatch [server/src/fhir/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const patient = await s.create<Patient>({ resourceType: 'Patient', name: [{ family: 'Doe', given: ['Jane'] }] });
      await s.call('PUT', `Patient/${patient.id}`, { ...patient, name: [{ family: 'Changed', given: ['Other'] }] });
      const res = await tx(s, 'transaction', [{ request: { method: 'PUT', url: `Patient/${patient.id}`, ifMatch: `W/"${patient.meta?.versionId}"` }, resource: { ...patient, name: [{ family: 'Smith', given: ['John'] }] } }]);
      return [res.status, res.json.resourceType === 'Bundle' ? statuses(res.json) : res.json.id];
    });
    expect(medplum).toEqual([200, ['412']]); // without transaction-bundles: the failed entry is answered
    expect(store).toEqual([412, 'precondition-failed']); // Medplum's own expectation (with the feature)
  });

  // Its patient made inactive, then active: the captured version is stale.
  const stalePatient = async (s: Side) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', active: false });
    const updated = await s.call('PUT', `Patient/${patient.id}`, { ...patient, active: true });
    expect(updated.status).toBe(200);
    return { patient, updated: updated.json as Patient };
  };

  test('Batch and Transaction processing › Batch FHIRPath PATCH with stale ifMatch fails and does not modify resource [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const { patient } = await stalePatient(s);
    const res = await tx(s, 'batch', [{ request: { method: 'PATCH', url: `Patient/${patient.id}`, ifMatch: `W/"${patient.meta?.versionId}"` }, resource: genderPatch('female') }]);
    expect([res.status, statuses(res.json)]).toEqual([200, ['412']]);
    const reread = await s.call('GET', `Patient/${patient.id}`);
    expect([reread.status, reread.json.gender]).toEqual([200, undefined]);
  }));

  test('Batch and Transaction processing › Batch DELETE with ifMatch [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const { patient, updated } = await stalePatient(s);
    const del = (versionId?: string) => tx(s, 'batch', [{ request: { method: 'DELETE', url: `Patient/${patient.id}`, ifMatch: `W/"${versionId}"` } }]);
    const res1 = await del(patient.meta?.versionId);
    expect([res1.status, statuses(res1.json)]).toEqual([200, ['412']]);
    expect((await s.call('GET', `Patient/${patient.id}`)).status).toBe(200);
    const res2 = await del(updated.meta?.versionId);
    expect([res2.status, statuses(res2.json)]).toEqual([200, ['200']]);
    expect((await s.call('GET', `Patient/${patient.id}`)).status).toBe(410);
  }));

  test('Batch and Transaction processing › Batch FHIRPath PATCH with current ifMatch succeeds and persists [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', active: false });
    const res = await tx(s, 'batch', [{ request: { method: 'PATCH', url: `Patient/${patient.id}`, ifMatch: `W/"${patient.meta?.versionId}"` }, resource: genderPatch('female') }]);
    expect([res.status, statuses(res.json)]).toEqual([200, ['200']]);
    expect((await s.call('GET', `Patient/${patient.id}`)).json.gender).toBe('female');
  }));

  test('differs on purpose: Batch and Transaction processing › Transaction PATCH with stale ifMatch rolls back the whole transaction [server/src/fhir/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const { patient } = await stalePatient(s);
      const orgIdentifier = crypto.randomUUID();
      const res = await tx(s, 'transaction', [
        { request: { method: 'POST', url: 'Organization' }, resource: { resourceType: 'Organization', identifier: [{ value: orgIdentifier }] } },
        { request: { method: 'PATCH', url: `Patient/${patient.id}`, ifMatch: `W/"${patient.meta?.versionId}"` }, resource: genderPatch('female') },
      ]);
      return [res.status, (await search(s, q('Organization', ['identifier', orgIdentifier]))).entry?.length ?? 0];
    });
    expect(medplum).toEqual([200, 1]); // without transaction-bundles: the Organization is kept
    expect(store).toEqual([412, 0]); // Medplum's own expectation (with the feature)
  });

  test('Batch and Transaction processing › Conditional update (create-as-update) in transaction [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const [careTeamIdentifier, encounterIdentifier, conditionIdentifier, practitionerIdentifier] = [1, 2, 3, 4].map(() => crypto.randomUUID());
    await s.create({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org.fhir/sid/us-npi', value: practitionerIdentifier }] });
    const patient = await s.create({ resourceType: 'Patient' });
    const res = await tx(s, 'transaction', [
      { fullUrl: 'urn:uuid:' + careTeamIdentifier, request: { method: 'PUT', url: `CareTeam?subject=Patient/${patient.id}` },
        resource: { resourceType: 'CareTeam', status: 'active', category: [{ coding: [{ system: 'http://loinc.org', code: 'LA28865-6' }], text: 'Holistic Wellness Squad' }], subject: ref(patient), participant: [{ member: npi(practitionerIdentifier) }] } },
      { fullUrl: 'urn:uuid:' + encounterIdentifier, request: { method: 'POST', url: 'Encounter' },
        resource: { resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: ref(patient), diagnosis: [{ condition: { reference: 'urn:uuid:' + conditionIdentifier } }] } },
      { fullUrl: 'urn:uuid:' + conditionIdentifier, request: { method: 'POST', url: 'Condition' },
        resource: { resourceType: 'Condition', verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
          subject: ref(patient), encounter: { reference: 'urn:uuid:' + encounterIdentifier }, asserter: npi(practitionerIdentifier), code: { coding: [{ system: 'http://snomed.info/sct', code: '83157008' }], text: 'FFI' } } },
      { request: { method: 'POST', url: 'Observation' }, resource: { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '31989-7' }], text: 'Prion test' },
        subject: ref(patient), valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA6576-8', display: 'Positive' }] } } },
      { request: { method: 'POST', url: 'Task' }, resource: { resourceType: 'Task', status: 'requested', intent: 'plan', encounter: { reference: 'urn:uuid:' + encounterIdentifier }, owner: { reference: 'urn:uuid:' + careTeamIdentifier }, description: 'Follow up regarding prognosis' } },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.entry[0].response.status).toBe('201');
    expect(res.json.entry.at(-1).resource.owner.reference).toBe(`CareTeam/${res.json.entry[0].resource.id}`);
  }));

  // Medplum's checkReferencesOnWrite project setting does not change this one: every reference resolves inside the Bundle.
  test('Batch and Transaction processing › Resolved intra-Bundle reference cycle with referential integrity validation [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const identity1 = 'urn:uuid:c5db5c3b-bd41-4c39-aa8e-2d2a9a038167', identity2 = 'urn:uuid:f897f22a-c8d0-4e47-911b-1bb82bfbdae6';
    const res = await tx(s, 'transaction', [
      { fullUrl: identity1, request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', link: [{ other: { reference: identity2 }, type: 'seealso' }] } },
      { fullUrl: identity2, request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', link: [{ other: { reference: identity1 }, type: 'seealso' }] } },
    ]);
    expect([res.status, res.json.resourceType]).toEqual([200, 'Bundle']);
  }));

  test('Batch and Transaction processing › Conditional reference resolution [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const practitionerIdentifier = crypto.randomUUID();
    const practitioner = await s.create({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org.fhir/sid/us-npi', value: practitionerIdentifier }] });
    const res = await tx(s, 'transaction', [{ request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', generalPractitioner: [npi(practitionerIdentifier)] } }]);
    expect([res.status, res.json.resourceType]).toEqual([200, 'Bundle']);
    expect(res.json.entry[0].resource.generalPractitioner[0].reference).toBe(`Practitioner/${practitioner.id}`);
  }));

  test('Batch and Transaction processing › Process batch create ifNoneExist invalid resource type [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const res = await tx(s, 'batch', [{ request: { method: 'POST', url: 'XXX', ifNoneExist: 'identifier=' + crypto.randomUUID() }, resource: { resourceType: 'XXX' } as unknown as Resource }]);
    expect([res.status, statuses(res.json)]).toEqual([200, ['400']]);
  }));

  // PUT Patient with no criteria: Medplum's test project is empty (400, create-as-update with a client id); the shared
  // ga-test-parity project holds Patients, so Medplum answers 412 (several match). The store refuses a conditional PUT without
  // criteria (400). Nothing is created either way.
  test('Batch and Transaction processing › Batch create as update with client-assigned ID [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const id = crypto.randomUUID();
    const res = await tx(s, 'batch', [{ request: { method: 'PUT', url: 'Patient' }, resource: { resourceType: 'Patient', id } }]);
    expect([res.status, statuses(res.json)]).toEqual([200, [s.name === 'medplum' ? '412' : '400']]);
    expect((await s.call('GET', `Patient/${id}`)).status).toBe(404);
  }));

  // Medplum's values, made per run (its project is per test file, this one is shared).
  test('Batch and Transaction processing › Repeated batch of related upserts [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const mrn = crypto.randomUUID();
    const P = 'urn:uuid:889474c7-551f-49cb-88d9-548ab1fcdcac', R = 'urn:uuid:726c6c4f-4ca8-425e-870e-e43e569d0c4e';
    const spouse = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'spouse', display: 'Spouse' }] };
    const entry: BundleEntry[] = [
      { fullUrl: P, request: { method: 'PUT', url: `Patient?identifier=${mrn}` }, resource: { resourceType: 'Patient', identifier: [{ value: mrn }], active: true } },
      { fullUrl: R, request: { method: 'PUT', url: `RelatedPerson?patient.identifier=${mrn}` }, resource: { resourceType: 'RelatedPerson', relationship: [spouse], patient: { reference: P } } },
      { fullUrl: 'urn:uuid:f65055bc-5de2-45f5-9f59-ed6adbe77ae0', request: { method: 'PUT', url: `Coverage?beneficiary.identifier=${mrn}` }, resource: {
        resourceType: 'Coverage', status: 'active', identifier: [{ value: '1' }], subscriberId: '1', subscriber: { reference: R }, relationship: spouse,
        beneficiary: { reference: P }, payor: [{ reference: 'Organization/091065a4-070b-4482-a863-76507b61e23a' }] } },
    ];
    const res = await tx(s, 'batch', entry);
    expect([res.status, statuses(res.json)]).toEqual([200, ['201', '201', '201']]);
    const res2 = await tx(s, 'batch', entry);
    expect([res2.status, statuses(res2.json)]).toEqual([200, ['200', '200', '200']]);
  }));

  test('differs on purpose: Batch and Transaction processing › Nested transaction in batch [server/src/fhir/batch.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const res = await tx(s, 'batch', [{ request: { method: 'POST', url: '/' }, resource: { resourceType: 'Bundle', type: 'transaction', entry: [
        { fullUrl: 'urn:uuid:fd801e1f-0788-4920-9609-33ed84c7b39b', request: { method: 'POST', url: 'Organization' }, resource: { resourceType: 'Organization', name: { failing: 'this aint valid' } } as unknown as Resource },
        { fullUrl: 'urn:uuid:fd801e1f-0788-4920-9609-33ed84c7b39b', request: { method: 'POST', url: 'Organization' }, resource: { resourceType: 'Organization', name: 'Valid, but the other is not' } },
      ] } }]);
      expect(res.status).toBe(200);
      return res.json as Bundle;
    });
    const invalid = { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'structure', details: { text: 'Invalid additional property "failing"' }, expression: ['Organization.name.failing'] }] };
    // Without transaction-bundles Medplum runs the nested transaction entry by entry (the valid Organization is created).
    expect(statuses(medplum)).toEqual(['200']);
    expect(statuses(medplum.entry?.[0]?.resource as Bundle)).toEqual(['400', '201']);
    expect((medplum.entry?.[0]?.resource as Bundle).entry?.[0]?.response?.outcome).toEqual(invalid);
    // Medplum's own expectation (with the feature): the nested transaction fails as a whole.
    expect(store).toEqual({ resourceType: 'Bundle', type: 'batch-response', entry: [{ response: { status: '400', outcome: invalid } }] });
    if (medplum.entry?.[0]?.resource) await sides[0].call('DELETE', (medplum.entry[0].resource as Bundle).entry![1].response!.location!);
  });

  test('Batch and Transaction processing › _include regression test [server/src/fhir/batch.test.ts]', () => same(sides, async (s) => {
    const res = await tx(s, 'transaction', [{ request: { method: 'POST', url: 'Observation' }, resource: { resourceType: 'Observation', status: 'final', subject: { display: 'Mr. Patient' }, code: { coding: [{ system: 'http://snomed.info/sct', code: '1234567890' }] } } }]);
    expect([res.status, res.json.type, res.json.entry.length]).toEqual([200, 'transaction-response', 1]);
    const query = await search(s, `Observation?_id=${res.json.entry[0].resource.id}&_include=Observation:subject`);
    expect(query.entry).toHaveLength(1);
  }));

  // binary.test.ts
  const text = { 'content-type': 'text/plain' };
  const bytes = async (s: Side, id: string) => { const g = await s.call('GET', `Binary/${id}`, undefined, { accept: '*/*' }); return [g.status, g.text]; };
  const postBinary = async (s: Side, body: string | Uint8Array = 'Hello world', headers: Record<string, string> = text) => {
    const g = await s.call('POST', 'Binary', body, headers);
    expect(g.status).toBe(201);
    return g.json as { id: string };
  };

  test('Binary › Create and read binary [server/src/fhir/binary.test.ts]', () => same(sides, async (s) => {
    const binary = await postBinary(s);
    expect(await bytes(s, binary.id)).toEqual([200, 'Hello world']);
    const res3 = await s.call('GET', `Binary/${binary.id}`);
    expect([res3.status, res3.json.resourceType]).toEqual([200, 'Binary']);
  }));

  test('Binary › Read binary not found [server/src/fhir/binary.test.ts]', () => same(sides, async (s) => {
    expect((await s.call('GET', 'Binary/2e9dfab6-a3af-4e5b-9324-483b4c333737')).status).toBe(404);
  }));

  test('Binary › Update and read binary [server/src/fhir/binary.test.ts]', () => same(sides, async (s) => {
    const binary = await postBinary(s);
    expect((await s.call('PUT', `Binary/${binary.id}`, 'Hello world 2', text)).status).toBe(200);
    expect(await bytes(s, binary.id)).toEqual([200, 'Hello world 2']);
  }));

  test('Binary › Unsupported content encoding [server/src/fhir/binary.test.ts]', () => same(sides, async (s) => {
    expect((await s.call('POST', 'Binary', 'Hello world', { ...text, 'content-encoding': 'fake' })).status).toBe(400);
  }));

  const zipped = (name: string, zip: (s: string) => Uint8Array) => test(name, () => same(sides, async (s) => {
    const binary = await postBinary(s, zip('Hello world'), { ...text, 'content-encoding': zip === gzipSync ? 'gzip' : 'deflate' });
    expect(await bytes(s, binary.id)).toEqual([200, 'Hello world']);
  }));
  zipped('Binary › Deflate [server/src/fhir/binary.test.ts]', deflateSync);
  zipped('Binary › GZIP [server/src/fhir/binary.test.ts]', gzipSync);

  test('Binary › Update with GZIP [server/src/fhir/binary.test.ts]', () => same(sides, async (s) => {
    const binary = await postBinary(s);
    expect((await s.call('PUT', `Binary/${binary.id}`, gzipSync('Hello world 2'), { ...text, 'content-encoding': 'gzip' })).status).toBe(200);
    expect(await bytes(s, binary.id)).toEqual([200, 'Hello world 2']);
  }));

  test('Binary › Upload binary in batch [server/src/fhir/binary.test.ts]', () => same(sides, async (s) => {
    const res = await tx(s, 'transaction', [
      { fullUrl: 'urn:uuid:a0010b42-02ea-411c-a314-9ec144f6c2b8', request: { method: 'POST', url: 'Binary' }, resource: { resourceType: 'Binary', contentType: 'text/plain', data: 'SGVsbG8gV29ybGQh' } },
      { request: { method: 'POST', url: 'DocumentReference' }, resource: { resourceType: 'DocumentReference', status: 'current', content: [{ attachment: { contentType: 'text/plain', url: 'urn:uuid:a0010b42-02ea-411c-a314-9ec144f6c2b8' } }] } },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.entry).toHaveLength(2);
    const binary = res.json.entry[0].resource, docref = res.json.entry[1].resource;
    expect(docref.content[0].attachment.url).toContain(binary.id);
    expect(await bytes(s, binary.id)).toEqual([200, 'Hello World!']);
    await s.call('DELETE', `Binary/${binary.id}`); // a Binary made in a batch is not in the harness cleanup
  }));

  test('Binary › Handle non-binary JSON [server/src/fhir/binary.test.ts]', () => same(sides, async (s) => {
    const binary = await postBinary(s);
    expect((await s.call('PUT', `Binary/${binary.id}`, { resourceType: 'Patient' })).status).toBe(200);
    expect(await bytes(s, binary.id)).toEqual([200, '{"resourceType":"Patient"}']);
  }));
});
