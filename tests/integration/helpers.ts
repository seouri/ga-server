import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { COMPARTMENT } from '../../src/engine.ts';
import { setup } from '../../src/setup.ts';
import type { Bundle, DocumentReference, Patient } from '@medplum/fhirtypes';

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

// Tests that need their own project (ga setup's policy, migrate) reuse long-lived ones named ga-test*: ga setup creates
// one the first time and finds it by name after. A project per run leaked: the sandbox admin can't expunge projects.
export async function testProject(name = 'ga-test'): Promise<{ dir: string; baseUrl: string; session: MedplumClient; cfg: GaConfig }> {
  const t = await throwawayConfig();
  return { ...t, cfg: await setup(t.baseUrl, undefined, { projectName: name }) };
}

// Everything GA clients wrote into a ga-test* project (records, files, maps, Provenance, logs), read and deleted through
// that project's own GA client, so nothing outside it is reachable. GA setup's self Patient and the admin's profile (not
// written by a client) stay, so the next run reuses them.
const DOOMED = [...Object.keys(COMPARTMENT), 'Patient', 'Medication', 'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Device', 'Endpoint', 'ConceptMap', 'Provenance', 'AuditEvent']; // Binary can't be searched: deleted through its DocumentReference
export async function emptyTestProject(client: MedplumClient): Promise<void> {
  const me = (await client.get('auth/me', { cache: 'no-cache' })) as { project: { name?: string; display?: string } };
  if (!/^ga-test/.test(me.project.name ?? me.project.display ?? '')) throw new Error('not a ga-test project');
  for (const t of DOOMED) {
    for (;;) {
      const rs = (await client.searchResources(t as 'Patient', { _count: '1000' }, { cache: 'no-cache' }))
        .filter((r) => r.meta?.author?.reference?.startsWith('ClientApplication/') && !(t === 'Patient' && (r as Patient).identifier?.some((i) => i.value === 'self')));
      if (!rs.length) break;
      for (const r of rs) {
        const files = t === 'DocumentReference' ? (r as unknown as DocumentReference).content.flatMap((c) => /^Binary\/([\w-]+)$/.exec(c.attachment.url ?? '')?.[1] ?? []) : [];
        for (const id of files) await client.deleteResource('Binary', id).catch(() => undefined); // shared by another record, or gone
        await client.deleteResource(t as 'Patient', r.id as string);
      }
    }
  }
}

// ConceptMaps the importers learned from test sources: exactly the synthetic orgs and uuid keys the integration files use.
// The maps live in the user's own project, outside any patient compartment, so cleanupTestPatient doesn't reach them.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SPACED = '[0-9a-f]{8} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{12}'; // C-CDA keys are normalised: '-' becomes ' '
const TEST_MAP = new RegExp(
  `^urn:ga-server:conceptmap:(ccda:synthetic clinic|ccda:synthetic (clinic|batch|carry|dup) ${SPACED}|ehi:synthetic(-org|-health|-health-b|-health-docs|-health-dup|-fill-[0-9a-f]{8})?` +
    `|smart:(cut|firstfail|good|link|lock|norefresh|revoked|sync)-${UUID}|smart:fhir-example-org|test-${UUID})$`,
);
export async function cleanupTestMaps(client: MedplumClient): Promise<void> {
  for (const m of await client.searchResources('ConceptMap', { _count: '1000' }, { cache: 'no-cache' })) {
    if (TEST_MAP.test(decodeURI(m.url ?? ''))) await client.deleteResource('ConceptMap', m.id as string);
  }
}
