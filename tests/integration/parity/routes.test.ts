// Medplum 5.2.14 packages/server/src/fhir/routes.test.ts, ported side by side (see harness.ts): the same HTTP requests to
// both servers. Medplum's reader/writer pool spies (On %s: which database pool served a search) are internal and left out;
// the On writer and On reader runs are one port. Error texts are compared where Medplum's test checks them.
import type { Patient } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { paritySides, same, type Side } from './harness.ts';

const FHIR = { 'content-type': 'application/fhir+json' };
const TEXT = { 'content-type': 'text/plain' };
const JSON_PATCH = { 'content-type': 'application/json-patch+json' };
const status = async (s: Side, method: string, path: string, body?: unknown, headers?: Record<string, string>) => (await s.call(method, path, body, headers)).status;

describe.skipIf(SQLITE)('Medplum routes.test.ts (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);
  // Medplum's beforeAll test patient, once per side.
  const made = new Map<string, Promise<Patient & { id: string }>>();
  const testPatient = (s: Side) => {
    if (!made.has(s.name)) made.set(s.name, s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }] }));
    return made.get(s.name)!;
  };
  const newPatient = async (s: Side, r: Patient = { resourceType: 'Patient' }) => s.create<Patient>(r);

  // Added (not a Medplum test): R4 JSON has no empty values. An empty array item ('' or {}) is 400; other empty values,
  // an empty array included, are dropped.
  test('empty array items are refused, other empty values dropped', () => same(sides, async (s) => {
    const out = [];
    for (const r of [{ name: [{ given: ['', ''] }] }, { identifier: [{ value: 'x' }, {}] }, { contact: [{ name: { given: [''] } }] }]) {
      const g = await s.call('POST', 'Patient', { resourceType: 'Patient', ...r });
      out.push([g.status, g.json?.issue]);
    }
    const p = await newPatient(s, { resourceType: 'Patient', identifier: [], name: [{ given: ['A'], _given: [{}] }], managingOrganization: {} } as unknown as Patient);
    out.push([p.identifier, p.name, p.managingOrganization]);
    return out;
  }));

  test('FHIR Routes › Invalid JSON [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'POST', '', 'not-json', FHIR)).toBe(400);
  }));

  // The legacy run (Medplum's legacyFhirJsonResponseFormat project setting) is Medplum's own: only the standard format.
  test('FHIR Routes › Create resource success with %s FHIR JSON response format [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const res = await s.call('POST', 'Patient', { resourceType: 'Patient', identifier: [] });
    expect(res.status).toBe(201);
    expect(res.json.resourceType).toBe('Patient');
    expect(res.headers.get('location')).toContain('Patient');
    expect(res.headers.get('location')).toContain(res.json.id);
    const res2 = await s.call('GET', `Patient/${res.json.id}`);
    expect(res2.status).toBe(200);
    expect(res.json.identifier).toBeUndefined();
  }));

  test('FHIR Routes › Create resource invalid resource type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'POST', 'Patientx', { resourceType: 'Patientx' })).toBe(400);
  }));

  test('FHIR Routes › Create resource incorrect resource type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'POST', 'Patient', { resourceType: 'Patientx' })).toBe(400);
  }));

  test('FHIR Routes › Create resource invalid content type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'POST', 'Patient', 'hello', TEXT)).toBe(400);
  }));

  test('FHIR Routes › Read resource [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', `Patient/${(await testPatient(s)).id}`)).toBe(200);
  }));

  test('FHIR Routes › Read resource _pretty [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const res = await s.call('GET', `Patient/${(await testPatient(s)).id}?_pretty=true`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(JSON.stringify(res.json, undefined, 2));
  }));

  test('FHIR Routes › Read resource invalid UUID [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', 'Patient/123')).toBe(404);
  }));

  test('FHIR Routes › Read resource invalid resource type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', `Patientx/${(await testPatient(s)).id}`)).toBe(400);
  }));

  test('FHIR Routes › Read resource not found [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', 'Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12c')).toBe(404);
  }));

  test('FHIR Routes › Read resource minimal [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const res = await s.call('GET', `Patient/${(await testPatient(s)).id}`, undefined, { prefer: 'return=minimal' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  }));

  test('FHIR Routes › Read resource history [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const res = await s.call('GET', `Patient/${(await testPatient(s)).id}/_history?_count=2&_offset=0`);
    expect(res.status).toBe(200);
    expect(res.json.entry).toHaveLength(1);
  }));

  test('FHIR Routes › Read resource history invalid UUID [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', 'Patient/123/_history')).toBe(404);
  }));

  test('FHIR Routes › Read resource history invalid resource type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', `xyz/${(await testPatient(s)).id}/_history`)).toBe(400);
  }));

  test('FHIR Routes › Read resource version [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const p = await testPatient(s);
    const res = await s.call('GET', `Patient/${p.id}/_history/${p.meta?.versionId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toContain('W/');
  }));

  test('FHIR Routes › Read resource version invalid UUID [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', `Patient/123/_history/${(await testPatient(s)).meta?.versionId}`)).toBe(404);
  }));

  test('FHIR Routes › Read resource version invalid version UUID [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', `Patient/${(await testPatient(s)).id}/_history/123`)).toBe(404);
  }));

  test('FHIR Routes › Read resource version invalid resource type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const p = await testPatient(s);
    expect(await status(s, 'GET', `xyz/${p.id}/_history/${p.meta?.versionId}`)).toBe(400);
  }));

  test('FHIR Routes › Read resource version not found [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', `Patient/${(await testPatient(s)).id}/_history/${crypto.randomUUID()}`)).toBe(404);
  }));

  test('FHIR Routes › Update resource [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    expect(await status(s, 'PUT', `Patient/${patient.id}`, { ...patient, active: true })).toBe(200);
  }));

  test('FHIR Routes › Update resource not modified [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    const res2 = await s.call('PUT', `Patient/${patient.id}`, patient);
    expect(res2.status).toBe(200);
    expect(res2.json.meta.versionId).toBe(patient.meta?.versionId);
  }));

  test('FHIR Routes › Update resource not modified with empty strings [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s, { resourceType: 'Patient', managingOrganization: { reference: 'Organization/125' } });
    const res2 = await s.call('PUT', `Patient/${patient.id}`, { ...patient, managingOrganization: { reference: 'Organization/125', display: '' } });
    expect(res2.status).toBe(200);
    expect(res2.json.meta.versionId).toBe(patient.meta?.versionId);
  }));

  test('FHIR Routes › Update resource invalid [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'PUT', `Patient/${(await testPatient(s)).id}`, {})).toBe(400);
  }));

  test('FHIR Routes › Update resource wrong content-type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'PUT', `Patient/${(await testPatient(s)).id}`, 'hello', TEXT)).toBe(400);
  }));

  test('FHIR Routes › Update resource missing ID [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'PUT', `Patient/${(await testPatient(s)).id}`, { resourceType: 'Patient' })).toBe(400);
  }));

  test('FHIR Routes › Update resource not found [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'PUT', `Patient/${crypto.randomUUID()}`, { resourceType: 'Patient' })).toBe(400);
  }));

  test('FHIR Routes › Update resource with precondition [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    expect(await status(s, 'PUT', `Patient/${patient.id}`, { ...patient, active: true }, { 'if-match': `W/"${patient.meta?.versionId}"` })).toBe(200);
  }));

  test('FHIR Routes › Update resource with failed precondition [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    expect(await status(s, 'PUT', `Patient/${patient.id}`, { ...patient, active: true }, { 'if-match': 'W/"bad-id"' })).toBe(412);
  }));

  test('FHIR Routes › Delete resource [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    expect(await status(s, 'DELETE', `Patient/${patient.id}`)).toBe(200);
    expect(await status(s, 'GET', `Patient/${patient.id}`)).toBe(410);
  }));

  test('FHIR Routes › Delete resource with failed precondition [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    expect(await status(s, 'DELETE', `Patient/${patient.id}`, undefined, { 'if-match': 'W/"bad-id"' })).toBe(412);
    expect(await status(s, 'GET', `Patient/${patient.id}`)).toBe(200);
  }));

  test('FHIR Routes › Delete resource invalid UUID [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'DELETE', 'Patient/123')).toBe(404);
  }));

  test('FHIR Routes › Delete resource invalid resource type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'DELETE', `xyz/${(await testPatient(s)).id}`)).toBe(400);
  }));

  test('FHIR Routes › Patch resource not found [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'PATCH', `Patient/${crypto.randomUUID()}`, [{ op: 'add', path: '/generalPractitioner', value: [{ reference: 'Practitioner/123' }] }], JSON_PATCH)).toBe(404);
  }));

  test('FHIR Routes › Patch resource wrong content type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'PATCH', `Patient/${(await testPatient(s)).id}`, 'hello', TEXT)).toBe(400);
  }));

  test('FHIR Routes › Patch resource invalid resource type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const res = await s.call('PATCH', `Foo/${(await testPatient(s)).id}`, { resourceType: 'Parameters' });
    expect(res.status).toBe(400);
    expect(res.json.issue[0].details.text).toBe('Unknown resource type');
  }));

  test('FHIR Routes › Patch resource invalid result [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'PATCH', `Patient/${(await testPatient(s)).id}`, [{ op: 'remove', path: '/resourceType' }], JSON_PATCH)).toBe(400);
  }));

  // Its own patient (Medplum's patches the shared one; the next test checks that one's given names).
  test('FHIR Routes › Patch resource success [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    expect(await status(s, 'PATCH', `Patient/${patient.id}`, [{ op: 'add', path: '/generalPractitioner', value: [{ reference: 'Practitioner/123' }] }], JSON_PATCH)).toBe(200);
  }));

  test('FHIR Routes › FHIRPath Patch resource success [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const p = await newPatient(s, { resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }] });
    const res = await s.call('PATCH', `Patient/${p.id}`, {
      resourceType: 'Parameters',
      parameter: [{ name: 'operation', part: [{ name: 'type', valueCode: 'add' }, { name: 'path', valueString: `Patient.name.where(family = 'Smith')` }, { name: 'name', valueString: 'given' }, { name: 'value', valueString: 'Jan' }] }],
    });
    expect(res.status).toBe(200);
    const res2 = await s.call('GET', `Patient/${p.id}`);
    expect(res2.status).toBe(200);
    expect(res2.json.name[0].given).toEqual(['Alice', 'Jan']);
  }));

  test('FHIR Routes › On %s › Search [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', 'Patient')).toBe(200);
  }));

  // Medplum's test makes a new project; here the shared one is scoped by _compartment. '../R4?' is fhir/R4 without the slash.
  test('FHIR Routes › On %s › Search multiple resource types with _type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const patient = await newPatient(s);
    const obs = await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: { reference: `Patient/${patient.id}` } });
    for (const path of [`../R4?_type=Patient,Observation&_compartment=Patient/${patient.id}`, `?_type=Patient,Observation&_compartment=Patient/${patient.id}`]) {
      const res = await s.call('GET', path);
      expect(res.status).toBe(200);
      expect(res.json.entry?.length).toBe(2);
      expect(res.json.entry.map((e: { resource: { id: string } }) => e.resource.id).sort()).toEqual([patient.id, obs.id].sort());
    }
  }));

  test('FHIR Routes › On %s › Search by POST [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    await testPatient(s);
    const res = await s.call('POST', 'Patient/_search', '', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(200);
    expect(res.json.type).toBe('searchset');
    expect(res.json.entry?.length).toBeGreaterThan(0);
  }));

  test('FHIR Routes › On %s › Search by POST with multiple includes [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    await testPatient(s);
    const res = await s.call('POST', 'Patient/_search', '_include=Patient:general-practitioner&_include=Patient:organization', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(200);
    expect(res.json.type).toBe('searchset');
    expect(res.json.entry?.length).toBeGreaterThan(0);
  }));

  test('FHIR Routes › Search invalid resource [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'GET', 'Patientx')).toBe(400);
  }));

  test('FHIR Routes › Search invalid search parameter [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const res = await s.call('GET', 'ServiceRequest?basedOn=ServiceRequest/123');
    expect(res.status).toBe(400);
    expect(res.json.issue[0].details.text).toBe('Unknown search parameter: basedOn');
  }));

  test('FHIR Routes › Validate create success [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'POST', 'Patient/$validate', { resourceType: 'Patient' })).toBe(200);
  }));

  test('FHIR Routes › Validate create failure [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'POST', 'Patient/$validate', { resourceType: 'Patient', badProperty: 'bad' })).toBe(400);
  }));

  test('FHIR Routes › Validate unwraps the resource parameter of a Parameters body [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const validate = (resource: Record<string, unknown>) => s.call('POST', 'Patient/$validate', { resourceType: 'Parameters', parameter: [{ name: 'resource', resource }] });
    expect((await validate({ resourceType: 'Patient' })).status).toBe(200);
    const res = await validate({ resourceType: 'Patient', name: 'x' });
    expect(res.status).toBe(400);
    expect(res.json.issue[0].expression).toEqual(['Patient.name']);
  }));

  test('FHIR Routes › Validate rejects a Parameters body without a resource parameter [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    const res = await s.call('POST', 'Patient/$validate', { resourceType: 'Parameters', parameter: [] });
    expect(res.status).toBe(400);
    expect(res.json.issue[0].details.text).toBe('Missing resource parameter');
  }));

  test('FHIR Routes › Validate wrong content type [server/src/fhir/routes.test.ts]', () => same(sides, async (s) => {
    expect(await status(s, 'POST', 'Patient/$validate', 'hello', TEXT)).toBe(400);
  }));
});
