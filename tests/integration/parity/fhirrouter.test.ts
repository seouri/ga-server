// Medplum 5.2.14 packages/fhir-router/src/fhirrouter.test.ts, ported side by side (see harness.ts): Medplum runs its router over
// an in-memory repository; here the same requests go over HTTP to both servers. Error texts are compared where Medplum's test
// checks them.
import type { Patient } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { paritySides, same, type Side } from './harness.ts';

const JSON_PATCH = { 'content-type': 'application/json-patch+json' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const answer = async (s: Side, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const g = await s.call(method, path, body, headers);
  return { status: g.status, text: g.json?.issue?.[0]?.details?.text as string | undefined };
};

describe.skipIf(SQLITE)('Medplum fhir-router fhirrouter.test.ts (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);
  const mrnPatient = (): Patient => ({ resourceType: 'Patient', identifier: [{ system: 'http://example.com/mrn', value: crypto.randomUUID() }] });

  test(`FHIR Router › Batch success [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const res = await s.call('POST', '', { resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient' } }] });
    expect(res.status).toBe(200);
    expect(res.json.entry.map((e: any) => e.response.status)).toEqual(['201']);
  }));

  test(`FHIR Router › Batch invalid bundle [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    expect(await answer(s, 'POST', '', { resourceType: 'Patient' })).toEqual({ status: 400, text: 'Not a bundle' });
  }));

  test(`FHIR Router › Read resource by ID [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['John'], family: 'Doe' }] });
    expect((await s.call('GET', `Patient/${patient.id}`)).status).toBe(200);
    expect((await s.call('GET', `Patient/${patient.id}/_history/${patient.meta?.versionId}`)).status).toBe(200);
  }));

  test(`FHIR Router › Read resource by ID not found [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    expect((await s.call('GET', `Patient/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await s.call('GET', `Patient/${crypto.randomUUID()}/_history/${crypto.randomUUID()}`)).status).toBe(404);
  }));

  test(`FHIR Router › Update incorrect resource type [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    expect(await answer(s, 'PUT', 'Patient/123', { resourceType: 'ServiceRequest', id: '123' })).toEqual({ status: 400, text: 'Incorrect resource type' });
  }));

  test(`FHIR Router › Update incorrect ID [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    expect(await answer(s, 'PUT', 'Patient/123', { resourceType: 'Patient', id: '456' })).toEqual({ status: 400, text: 'Incorrect resource ID' });
  }));

  // Medplum has two tests of this title: a bare Patient, and one with a name and a changed body.
  test(`FHIR Router › Update incorrect precondition [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    expect((await s.call('PUT', `Patient/${patient.id}`, patient, { 'if-match': 'W/"incorrect"' })).status).toBe(412);
    const named = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['John'], family: 'Doe' }] });
    expect((await s.call('PUT', `Patient/${named.id}`, { ...named, active: true }, { 'if-match': 'W/"test"' })).status).toBe(412);
  }));

  test(`FHIR Router › Update with correct precondition [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['John'], family: 'Doe' }], active: false });
    const res = await s.call('PUT', `Patient/${patient.id}`, { ...patient, active: true }, { 'if-match': `W/"${patient.meta?.versionId}"` });
    expect([res.status, res.json.active]).toEqual([200, true]);
  }));

  test(`FHIR Router › Delete with precondition [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    expect((await s.call('DELETE', `Patient/${patient.id}`, undefined, { 'if-match': 'W/"incorrect"' })).status).toBe(412);
    expect((await s.call('DELETE', `Patient/${patient.id}`, undefined, { 'if-match': `W/"${patient.meta?.versionId}"` })).status).toBe(200);
  }));

  test(`FHIR Router › Search by post [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const res = await s.call('POST', 'Patient/_search', 'name=Simpson', FORM);
    expect([res.status, res.json.resourceType]).toEqual([200, 'Bundle']);
  }));

  test(`FHIR Router › Search multiple types [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const res = await s.call('GET', '?_type=Patient,Observation');
    expect([res.status, res.json.resourceType]).toEqual([200, 'Bundle']);
  }));

  // Medplum's router takes the query parsed or as a string; over HTTP the two tests are the same request.
  const conditionalUpdate = () => same(sides, async (s) => {
    const patient = mrnPatient();
    const res = await s.call('PUT', `Patient?identifier=http://example.com/mrn|${patient.identifier![0].value}`, patient);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject(patient);
  });
  test('FHIR Router › Conditional update [fhir-router/src/fhirrouter.test.ts]', conditionalUpdate);
  test('FHIR Router › Conditional update with unparsed query string [fhir-router/src/fhirrouter.test.ts]', conditionalUpdate);

  test(`FHIR Router › Patch resource [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['John'], family: 'Doe' }] });
    const res = await s.call('PATCH', `Patient/${patient.id}`, [{ op: 'add', path: '/active', value: true }], JSON_PATCH);
    expect([res.status, res.json.active]).toEqual([200, true]);
    // Medplum's JSON body parser refuses a body that is not an object or array before its router sees it.
    expect(await answer(s, 'PATCH', `Patient/${patient.id}`, 'null', JSON_PATCH)).toEqual({ status: 400, text: 'Content could not be parsed' });
    expect(await answer(s, 'PATCH', `Patient/${patient.id}`, '{"foo":"bar"}', JSON_PATCH)).toEqual({ status: 400, text: 'Invalid patch body' });
  }));

  // Medplum's repository holds only its own test records; the live project holds more Patients of gender unknown, so the
  // first request matches several either way.
  test(`FHIR Router › Conditional PATCH [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const patient: Patient = { ...mrnPatient(), gender: 'unknown' };
    const mrn = patient.identifier![0].value!;
    await s.create(patient);
    await s.create({ ...patient, identifier: undefined });
    expect((await s.call('PATCH', 'Patient?gender=unknown', [{ op: 'test', path: '/identifier/0/value', value: mrn }], JSON_PATCH)).status).toBe(412);
    const res = await s.call('PATCH', `Patient?identifier=http://example.com/mrn|${mrn}`, [{ op: 'test', path: '/gender', value: 'unknown' }], JSON_PATCH);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject(patient);
    expect((await s.call('PATCH', `Patient?identifier=http://example.com/mrn|${crypto.randomUUID()}`, [{ op: 'test', path: '/gender', value: 'unknown' }], JSON_PATCH)).status).toBe(404);
  }));

  test(`FHIR Router › Conditional delete [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    const patient: Patient = { ...mrnPatient(), gender: 'unknown' };
    const mrn = patient.identifier![0].value!;
    await s.create(patient);
    await s.create({ ...patient, identifier: undefined });
    expect((await s.call('DELETE', 'Patient?gender=unknown')).status).toBe(412);
    expect((await s.call('DELETE', `Patient?identifier=http://example.com/mrn|${mrn}`)).status).toBe(200);
    expect((await s.call('DELETE', `Patient?identifier=http://example.com/mrn|${crypto.randomUUID()}`)).status).toBe(200);
  }));

  test(`FHIR Router › Custom system-level operation returns not found [fhir-router/src/fhirrouter.test.ts]`, () => same(sides, async (s) => {
    expect((await s.call('POST', '$custom-operation', {})).status).toBe(404);
  }));
});
