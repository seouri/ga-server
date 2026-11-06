// loadScoped against the local Medplum, on a throwaway test patient.
import type { MedplumClient } from '@medplum/core';
import type { AuditEvent, Binary, Bundle, DocumentReference, Medication, MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { loadScoped } from '../../src/share/scope.ts';
import type { Share } from '../../src/share/store.ts';
import type { Group } from '../../src/share/store.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const share = (groups: Group[]): Share => ({
  id: 'test-scope', label: 't', audience: 'doctor', groups, layout: 'A', questionsPerDay: 20,
  tokenHash: 'h', patientId: pid, baseUrl: 'http://x', created: new Date().toISOString(),
});
let client: MedplumClient;
let pid: string;
let med: Medication;
let bin: Binary;

beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
  const subject = { reference: `Patient/${pid}` };
  med = await client.createResource<Medication>({ resourceType: 'Medication', code: { text: 'test med' } });
  await client.createResource<Observation>({
    resourceType: 'Observation', status: 'final', subject, code: { text: 'test lab' },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
    effectiveDateTime: '2025-01-01',
  });
  await client.createResource<MedicationStatement>({
    resourceType: 'MedicationStatement', status: 'active', subject, medicationReference: { reference: `Medication/${med.id}` },
  });
  await client.createResource<DocumentReference>({
    resourceType: 'DocumentReference', status: 'current', subject,
    identifier: [{ system: 'urn:ga-server:id:ehi-archive', value: 'test-archive' }],
    content: [{ attachment: { contentType: 'text/plain', data: 'eA==' } }],
  });
  bin = await client.createBinary({ data: 'test note', contentType: 'text/plain' });
  await client.createResource<DocumentReference>({
    resourceType: 'DocumentReference', status: 'current', subject, date: '2025-02-01T00:00:00Z',
    content: [{ attachment: { contentType: 'text/plain', url: `Binary/${bin.id}` } }],
  });
  await client.createResource<AuditEvent>({
    resourceType: 'AuditEvent', type: { code: 'test' }, recorded: new Date().toISOString(),
    agent: [{ requestor: true }], source: { observer: { display: 'test' } }, entity: [{ what: { reference: `Patient/${pid}` } }],
  });
});

afterAll(async () => {
  if (pid) await cleanupTestPatient(client, pid);
  if (med?.id) await client.deleteResource('Medication', med.id);
  if (bin?.id) await client.deleteResource('Binary', bin.id);
});

test('medications share returns the statement and its Medication, nothing else', async () => {
  // The excluded records really are compartment matches: inScope drops them, not the fetch.
  const raw = await client.get<Bundle>(`fhir/R4/Patient/${pid}/$everything?_count=1000`, { cache: 'no-cache' });
  const types = (raw.entry ?? []).filter((e) => e.search?.mode === 'match').map((e) => e.resource?.resourceType).sort();
  expect(types).toEqual(['AuditEvent', 'DocumentReference', 'DocumentReference', 'MedicationStatement', 'Observation', 'Patient']);

  const s = await loadScoped(client, share(['medications']));
  expect(s.resources.map((r: Resource) => r.resourceType)).toEqual(['MedicationStatement']);
  expect(s.support.map((r) => `${r.resourceType}/${r.id}`)).toEqual([`Medication/${med.id}`]);
  expect(s.patient).toEqual({ resourceType: 'Patient', id: pid });
  expect(s.patient.identifier).toBeUndefined();
  expect(s.endpoints.every((e) => e.resourceType === 'Endpoint')).toBe(true);
});

test('notes share follows the attachment to its Binary (Medplum returns a presigned storage URL)', async () => {
  const s = await loadScoped(client, share(['notes']));
  expect(s.resources.map((r) => r.resourceType)).toEqual(['DocumentReference']); // the archive stays out
  expect((s.resources[0] as DocumentReference).content[0].attachment.url).toContain('/storage/');
  expect(s.support.map((r) => `${r.resourceType}/${r.id}`)).toEqual([`Binary/${bin.id}`]);
});
