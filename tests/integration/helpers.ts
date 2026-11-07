import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import { getClient, loadConfig } from '../../src/config.ts';
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
  // Only compartment matches: $everything also includes referenced shared records (Organization, Practitioner...), which may be real.
  // Repeat until nothing matches, so a compartment larger than one page is fully deleted.
  for (;;) {
    const bundle = await client.get<Bundle>(`fhir/R4/Patient/${patientId}/$everything?_count=1000`, { cache: 'no-cache' });
    const mine = (bundle.entry ?? []).flatMap((e) => (e.search?.mode === 'match' && e.resource && e.resource.resourceType !== 'Patient' ? [e.resource] : []));
    if (!mine.length) break;
    for (const r of mine) await client.deleteResource(r.resourceType, r.id as string);
  }
  await client.deleteResource('Patient', patientId);
}

// A temp GA_CONFIG holding only the admin login and URLs of the running install, for tests that run ga setup against a
// throwaway Medplum project; the user's own config is read, never written. session: one admin login in the Super Admin
// project (found through the user's GA client) for housekeeping on throwaway projects only. Medplum allows 5 password
// logins a minute.
export async function throwawayConfig(): Promise<{ dir: string; baseUrl: string; session: MedplumClient }> {
  const real = loadConfig();
  const me = (await (await getClient(real)).get('auth/me')) as { project: { id: string } };
  const session = new MedplumClient({ baseUrl: real.baseUrl });
  const { code } = await session.startLogin({ email: 'admin@example.com', password: real.adminPassword as string, projectId: me.project.id });
  await session.processCode(code as string);
  const dir = mkdtempSync(join(tmpdir(), 'ga-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ baseUrl: real.baseUrl, converterUrl: real.converterUrl, adminPassword: real.adminPassword }), { mode: 0o600 });
  process.env.GA_CONFIG = path;
  return { dir, baseUrl: real.baseUrl, session };
}

export async function expungeProject(session: MedplumClient, projectId: string): Promise<void> {
  await session.post(`${session.fhirUrl('Project', projectId, '$expunge')}?everything=true`, {});
}

// ConceptMaps the importers learned from test sources (synthetic orgs, uuid source keys, the engine test's portal host). The
// maps live in the user's own project, outside any patient compartment, so cleanupTestPatient doesn't reach them.
const TEST_MAP = /^urn:ga-server:conceptmap:(.*synthetic.*|.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*|smart:fhir-example-org|test-.*)$/i;
export async function cleanupTestMaps(client: MedplumClient): Promise<void> {
  for (const m of await client.searchResources('ConceptMap', { _count: '1000' }, { cache: 'no-cache' })) {
    if (TEST_MAP.test(decodeURI(m.url ?? ''))) await client.deleteResource('ConceptMap', m.id as string);
  }
}
