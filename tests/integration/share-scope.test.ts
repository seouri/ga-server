// loadScoped against the local Medplum, on two throwaway test patients (A is shared, B must never leak into A).
import type { MedplumClient } from '@medplum/core';
import type { AuditEvent, Binary, DocumentReference, Endpoint, Medication, MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { storeDocument } from '../../src/document.ts';
import { BINARY_URL, loadScoped } from '../../src/share/scope.ts';
import { toBundle } from '../../src/share/summary.ts';
import type { Group, Share } from '../../src/share/store.ts';
import { cleanupTestPatient, compartmentOf, createTestPatient, SQLITE } from './helpers.ts';

const share = (groups: Group[] | 'all'): Share => ({
  id: 'test-scope', label: 't', audience: 'doctor', groups, layout: 'A', questionsPerDay: 20,
  tokenHash: 'h', patientId: pid, baseUrl: 'http://x', created: new Date().toISOString(),
});
const lab = (patient: string): Observation => ({
  resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${patient}` }, code: { text: 'test lab' },
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
  effectiveDateTime: '2025-01-01',
});
const endpoint = (patient: string, key: string): Endpoint => ({
  resourceType: 'Endpoint', status: 'active', address: 'https://test.example/fhir', payloadType: [{ text: 'FHIR R4' }],
  connectionType: { code: 'hl7-fhir-rest' }, identifier: [{ system: 'urn:ga-server:id:smart-source', value: key }],
  extension: [{ url: 'urn:ga-server:ext:smart-patient', valueReference: { reference: `Patient/${patient}` } }],
});
const ids = (rs: Resource[]) => rs.map((r) => `${r.resourceType}/${r.id}`);

let client: MedplumClient;
let pid: string;
let pidB: string;
let med: Medication;
let bin: Binary;
let binB: Binary;
let srcBinId: string | undefined;
let srcDoc: DocumentReference;
const endpoints: Endpoint[] = [];
const bRecords: Resource[] = [];

beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
  pidB = await createTestPatient(client);
  const subject = { reference: `Patient/${pid}` };
  med = await client.createResource<Medication>({ resourceType: 'Medication', code: { text: 'test med' } });
  await client.createResource(lab(pid));
  await client.createResource<MedicationStatement>({
    resourceType: 'MedicationStatement', status: 'active', subject, medicationReference: { reference: `Medication/${med.id}` },
  });
  await client.createResource<DocumentReference>({
    resourceType: 'DocumentReference', status: 'current', subject,
    identifier: [{ system: 'urn:ga-server:id:ehi-archive', value: 'test-archive' }],
    content: [{ attachment: { contentType: 'text/plain', data: 'eA==' } }],
  });
  // An imported source file (as ga_import stores it): never shared, nor its Binary.
  srcDoc = (await storeDocument(client, new URL('../fixtures/labs-synthetic.pdf', import.meta.url).pathname, pid, 'application/pdf')).docRef;
  srcBinId = BINARY_URL.exec(srcDoc.content[0].attachment.url ?? '')?.[1];
  bin = await client.createBinary({ data: 'test note', contentType: 'text/plain' });
  binB = await client.createBinary({ data: 'test note b', contentType: 'text/plain', securityContext: { reference: `Patient/${pidB}` } });
  // A's note also points at B's Binary: it must be dropped by its securityContext.
  await client.createResource<DocumentReference>({
    resourceType: 'DocumentReference', status: 'current', subject, date: '2025-02-01T00:00:00Z',
    content: [{ attachment: { contentType: 'text/plain', url: `Binary/${bin.id}` } }, { attachment: { contentType: 'text/plain', url: `Binary/${binB.id}` } }],
  });
  await client.createResource<AuditEvent>({
    resourceType: 'AuditEvent', type: { code: 'test' }, recorded: new Date().toISOString(),
    agent: [{ requestor: true }], source: { observer: { display: 'test' } }, entity: [{ what: { reference: `Patient/${pid}` } }],
  });
  const subjectB = { reference: `Patient/${pidB}` };
  bRecords.push(
    await client.createResource(lab(pidB)),
    await client.createResource<MedicationStatement>({
      resourceType: 'MedicationStatement', status: 'active', subject: subjectB, medicationReference: { reference: `Medication/${med.id}` },
    }),
    await client.createResource<DocumentReference>({
      resourceType: 'DocumentReference', status: 'current', subject: subjectB, date: '2025-02-01T00:00:00Z',
      content: [{ attachment: { contentType: 'text/plain', url: `Binary/${binB.id}` } }],
    }),
  );
  endpoints.push(await client.createResource(endpoint(pid, 'test-a')), await client.createResource(endpoint(pidB, 'test-b')));
});

afterAll(async () => {
  for (const p of [pid, pidB]) if (p) await cleanupTestPatient(client, p);
  for (const e of endpoints) await client.deleteResource('Endpoint', e.id as string);
  if (med?.id) await client.deleteResource('Medication', med.id);
  for (const b of [bin, binB]) if (b?.id) await client.deleteResource('Binary', b.id);
  if (srcBinId) await client.deleteResource('Binary', srcBinId);
});

test('medications share returns the statement and its Medication, nothing else', async () => {
  // The excluded records really are compartment matches: inScope drops them, not the fetch.
  const types = [...(await compartmentOf(client, pid)).map((r) => r.resourceType), 'Patient'].sort();
  expect(types).toEqual(['AuditEvent', 'DocumentReference', 'DocumentReference', 'DocumentReference', 'MedicationStatement', 'Observation', 'Patient']);

  const s = await loadScoped(client, share(['medications']));
  expect(s.resources.map((r: Resource) => r.resourceType)).toEqual(['MedicationStatement']);
  expect((s.resources[0] as MedicationStatement).subject.reference).toBe(`Patient/${pid}`);
  expect(ids(s.support)).toEqual([`Medication/${med.id}`]);
  expect(s.patient).toEqual({ resourceType: 'Patient', id: pid });
  expect(s.patient.identifier).toBeUndefined();
  expect(ids(s.endpoints)).toEqual([`Endpoint/${endpoints[0].id}`]);
});

test("notes share follows the attachment to its own Binary, not another patient's", async () => {
  const s = await loadScoped(client, share(['notes']));
  expect(s.resources.map((r) => r.resourceType)).toEqual(['DocumentReference']); // the archive stays out
  expect(BINARY_URL.exec((s.resources[0] as DocumentReference).content[0].attachment.url ?? '')?.[1]).toBe(bin.id); // Medplum: a presigned /storage/ url
  // Medplum drops B's Binary by its securityContext. The store does not keep Binary.securityContext (GA never sets it; one
  // patient per store), so there only A's own Binary is checked.
  if (SQLITE) expect(ids(s.support)).toContain(`Binary/${bin.id}`);
  else expect(ids(s.support)).toEqual([`Binary/${bin.id}`]);
  const bundle = JSON.stringify(toBundle(s)); // the note's presigned url is dropped; the support Binary carries no url
  expect(bundle).not.toMatch(/"url":"[^"]*(Binary|storage)\//);
});

test("patient B's records never appear in A's share", async () => {
  const s = await loadScoped(client, share('all'));
  const got = new Set(ids([...s.resources, ...s.support]));
  expect(s.resources.length).toBe(3); // lab, statement, note
  for (const r of bRecords) expect(got.has(`${r.resourceType}/${r.id}`)).toBe(false);
  // Medplum only: GA never sets Binary.securityContext; the store (one patient) keeps none, so this guard is Medplum's.
  if (!SQLITE) expect(got.has(`Binary/${binB.id}`)).toBe(false);
  expect(got.has(`Patient/${pidB}`)).toBe(false);
  for (const r of s.resources) expect(r.meta?.compartment?.map((c) => c.reference)).toContain(`Patient/${pid}`);
});

test('an imported source file and its Binary never appear, even for all', async () => {
  expect(srcBinId).toBeTruthy();
  const s = await loadScoped(client, share('all'));
  const got = new Set(ids([...s.resources, ...s.support]));
  expect(got.has(`DocumentReference/${srcDoc.id}`)).toBe(false);
  expect(got.has(`Binary/${srcBinId}`)).toBe(false);
  expect(s.resources.filter((r) => r.resourceType === 'DocumentReference')).toHaveLength(1); // only the note
});
