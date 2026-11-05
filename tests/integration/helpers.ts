import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Patient } from '@medplum/fhirtypes';

// Tests must never write onto the real Patient (identifier ...|self).
export async function createTestPatient(client: MedplumClient): Promise<string> {
  const p = await client.createResource<Patient>({
    resourceType: 'Patient',
    identifier: [{ system: 'urn:ga-server:id:patient', value: `test-${randomUUID()}` }],
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'ga-test' }] },
  });
  return p.id as string;
}

export async function cleanupTestPatient(client: MedplumClient, patientId: string): Promise<void> {
  const bundle = await client.get<Bundle>(`fhir/R4/Patient/${patientId}/$everything?_count=1000`, { cache: 'no-cache' });
  for (const e of bundle.entry ?? []) {
    const r = e.resource;
    if (r && r.resourceType !== 'Patient') await client.deleteResource(r.resourceType, r.id as string);
  }
  await client.deleteResource('Patient', patientId);
}
