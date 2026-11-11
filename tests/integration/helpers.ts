import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import { defaultConfigPath, type GaConfig, getClient, loadConfig, storeKind } from '../../src/config.ts';
import { convertCcdaLocal } from '../../src/ccda.ts';
import { COMPARTMENT } from '../../src/engine.ts';
import { searchAll } from '../../src/labs.ts';
import { binaryIds } from '../../src/migrate.ts';
import { setup } from '../../src/setup.ts';
import type { Bundle, DocumentReference, Patient, Resource } from '@medplum/fhirtypes';

// GA_STORE=sqlite: each file has its own temp store (store-setup.ts); no Medplum logins or ga-test projects.
export const SQLITE = storeKind() === 'sqlite';

// A patient's compartment (minus the Patient), the first 1000 by $everything (Medplum and the store alike).
export async function compartmentOf(client: MedplumClient, patientId: string): Promise<Resource[]> {
  const bundle = await client.get<Bundle>(`fhir/R4/Patient/${patientId}/$everything?_count=1000`, { cache: 'no-cache' });
  return (bundle.entry ?? []).flatMap((e) => (e.search?.mode === 'match' && e.resource && e.resource.resourceType !== 'Patient' ? [e.resource] : []));
}

// A config for a CLI child process on patientId: the Medplum login fields, or on the store its URL plus a copy of the token
// (the child reads it next to its config).
export function childConfig(dir: string, patientId: string): string {
  const real = loadConfig();
  const path = join(dir, 'config.json');
  const cfg = SQLITE ? { store: 'sqlite', storeUrl: real.storeUrl, patientId }
    : { baseUrl: real.baseUrl, clientId: real.clientId, clientSecret: real.clientSecret, patientId };
  if (SQLITE) { mkdirSync(join(dir, 'store'), { recursive: true }); copyFileSync(join(dirname(defaultConfigPath()), 'store', 'token'), join(dir, 'store', 'token')); }
  writeFileSync(path, JSON.stringify(cfg), { mode: 0o600 });
  return path;
}

// Medplum's local login limit (5 a minute) answers 429; wait out its _msBeforeNext and retry. Any other error is rethrown at once.
export async function retryLimited<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? `${e.message} ${JSON.stringify((e as { outcome?: unknown }).outcome ?? '')}` : '';
      if (attempt >= 3 || !/Too Many Requests/.test(msg)) throw e;
      const wait = Number(/_msBeforeNext"?\s*[:=]\s*(\d+)/.exec(msg)?.[1] ?? 60_000);
      await new Promise((r) => setTimeout(r, wait + 1000));
    }
  }
}

// Medplum mode: every helper that writes first checks, once per client, that the client is in a ga-test* project
// (global-setup.ts points the run at one). The store (GA_STORE=sqlite) is a per-file temp store already.
const checked = new WeakMap<MedplumClient, Promise<void>>();
export function assertTestProject(client: MedplumClient): Promise<void> {
  if (SQLITE) return Promise.resolve();
  let p = checked.get(client);
  if (!p) {
    p = (async () => {
      const me = (await client.get('auth/me', { cache: 'no-cache' })) as { project?: { name?: string; display?: string } };
      if (!/^ga-test/.test(me.project?.name ?? me.project?.display ?? '')) throw new Error('refusing to run integration tests against a non-test project');
    })();
    p.catch(() => checked.delete(client));
    checked.set(client, p);
  }
  return p;
}

// Each Binary a record's attachments point at (Binary/<id> as written, or Medplum's presigned storage/<id>/... read back),
// deleted before the record: Medplum cannot search Binary, so once the record is gone the file is unreachable.
async function deleteFiles(client: MedplumClient, r: Resource): Promise<void> {
  for (const id of binaryIds([r])) await client.deleteResource('Binary', id).catch(() => undefined); // shared by another record, or gone
}

// Tests must never write onto the real Patient (identifier ...|self).
export async function createTestPatient(client: MedplumClient): Promise<string> {
  await assertTestProject(client);
  const p = await client.createResource<Patient>({
    resourceType: 'Patient',
    identifier: [{ system: 'urn:ga-server:id:patient', value: `test-${randomUUID()}` }],
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'ga-test' }] },
  });
  return p.id as string;
}

export async function cleanupTestPatient(client: MedplumClient, patientId: string): Promise<void> {
  await assertTestProject(client);
  // Only compartment matches: $everything also includes referenced shared records (Organization, Practitioner...), which may be real.
  // Repeat until nothing matches, so a compartment larger than one page is fully deleted.
  for (;;) {
    const mine = await compartmentOf(client, patientId);
    if (!mine.length) break;
    for (const r of mine) {
      await deleteFiles(client, r);
      await client.deleteResource(r.resourceType, r.id as string);
    }
  }
  await client.deleteResource('Patient', patientId);
}

// Tests that pointed GA_CONFIG at another test project put back the run's ga-test config (global-setup.ts), never the live
// one. On the store: the file's temp store config, never the shell's.
const STARTING_CONFIG = process.env.GA_INT_RUN_CONFIG ?? process.env.GA_CONFIG;
export function restoreConfig(): void {
  if (SQLITE) { if (process.env.GA_INT_STORE_CONFIG) process.env.GA_CONFIG = process.env.GA_INT_STORE_CONFIG; }
  else if (STARTING_CONFIG === undefined) delete process.env.GA_CONFIG;
  else process.env.GA_CONFIG = STARTING_CONFIG;
}

// A temp GA_CONFIG holding only the admin login and URLs of the running install, for tests that run ga setup against a
// throwaway Medplum project; the user's own config is read, never written. session: one admin login in the Super Admin
// project (found through the user's GA client) for housekeeping on throwaway projects only. Medplum allows 5 password
// logins a minute.
export async function throwawayConfig(): Promise<{ dir: string; baseUrl: string; session: MedplumClient }> {
  const real = loadConfig();
  const me = (await (await getClient(real)).get('auth/me')) as { project: { id: string } };
  const session = new MedplumClient({ baseUrl: real.baseUrl });
  const { code } = await retryLimited(() => session.startLogin({ email: 'admin@example.com', password: real.adminPassword as string, projectId: me.project.id }));
  await session.processCode(code as string);
  const dir = mkdtempSync(join(tmpdir(), 'ga-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ baseUrl: real.baseUrl, adminPassword: real.adminPassword }), { mode: 0o600 });
  process.env.GA_CONFIG = path;
  return { dir, baseUrl: real.baseUrl as string, session };
}

// Tests that need their own project (ga setup's policy, migrate) reuse long-lived ones named ga-test*: ga setup creates
// one the first time and finds it by name after. A project per run leaked: the sandbox admin can't expunge projects.
// On the store: the file's own temp store and its config (setup already ran there).
export async function testProject(name = 'ga-test'): Promise<{ dir: string; baseUrl: string; session: MedplumClient; cfg: GaConfig }> {
  if (SQLITE) return { dir: dirname(defaultConfigPath()), baseUrl: loadConfig().storeUrl as string, session: undefined as unknown as MedplumClient, cfg: loadConfig() };
  const t = await throwawayConfig();
  const cfg = { ...(await retryLimited(() => setup(t.baseUrl, { projectName: name }))), terminologyLookup: false };
  writeFileSync(join(t.dir, 'config.json'), JSON.stringify(cfg), { mode: 0o600 }); // lookup off, as in the run's config (ga setup wrote a fresh one)
  return { ...t, cfg };
}

// Everything GA clients wrote into a ga-test* project (records, files, maps, Provenance, logs), read and deleted through
// that project's own GA client, so nothing outside it is reachable. GA setup's self Patient and the admin's profile (not
// written by a client) stay, so the next run reuses them.
const DOOMED = [...Object.keys(COMPARTMENT), 'Basic', 'Patient', 'Medication', 'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Device', 'Endpoint', 'ConceptMap', 'Provenance', 'AuditEvent']; // Binary can't be searched: deleted through its DocumentReference
export async function emptyTestProject(client: MedplumClient): Promise<void> {
  if (SQLITE) {
    // Only the temp store store-setup.ts started; everything but the self Patient (Binaries go with their DocumentReference).
    const path = process.env.GA_INT_STORE_CONFIG ?? ''; // GA_CONFIG may be deleted by now (afterAll)
    const cfg = loadConfig(path);
    if (!cfg.storeUrl?.startsWith('http://127.0.0.1:') || !path.includes('ga-int-store-') || client.getBaseUrl() !== cfg.storeUrl) throw new Error('not a test store');
    for (const t of DOOMED) {
      for (const r of await client.searchResources(t as 'Patient', { _count: '1000' }, { cache: 'no-cache' })) {
        if (r.id === cfg.patientId) continue;
        const files = t === 'DocumentReference' ? (r as unknown as DocumentReference).content.flatMap((c) => /^Binary\/([\w-]+)$/.exec(c.attachment.url ?? '')?.[1] ?? []) : [];
        for (const id of files) await client.deleteResource('Binary', id).catch(() => undefined);
        await client.deleteResource(t as 'Patient', r.id as string);
      }
    }
    return;
  }
  await assertTestProject(client);
  for (const t of DOOMED) {
    for (;;) {
      const rs = (await client.searchResources(t as 'Patient', { _count: '1000' }, { cache: 'no-cache' }))
        .filter((r) => r.meta?.author?.reference?.startsWith('ClientApplication/') && !(t === 'Patient' && (r as Patient).identifier?.some((i) => i.value === 'self')));
      if (!rs.length) break;
      for (const r of rs) {
        await deleteFiles(client, r);
        await client.deleteResource(t as 'Patient', r.id as string);
      }
    }
  }
  // The self Patient stays, but back to what ga setup made: imports onto it merge in fixture identifiers and demographics
  // (a C-CDA's fake MRN), which a later file's identifier search would find.
  for (const p of await client.searchResources('Patient', { identifier: 'urn:ga-server:id:patient|self' }, { cache: 'no-cache' })) {
    const { resourceType, id, meta: _m, identifier, ...rest } = p;
    if (identifier?.length === 1 && !Object.keys(rest).length) continue;
    await client.updateResource<Patient>({ resourceType, id, identifier: [{ system: 'urn:ga-server:id:patient', value: 'self' }] });
  }
}

// Every record a C-CDA fixture import wrote, of the types its conversion makes: found by GA's C-CDA identifier system and the
// fixture's path (identifier search is global; the owner's records never carry a test fixture's path), so shared records
// (Practitioner, Organization...) that cleanupTestPatient does not reach go too.
export async function cleanupCcda(client: MedplumClient, file: string): Promise<void> {
  await assertTestProject(client);
  const types = new Set(convertCcdaLocal(readFileSync(file, 'utf8')).resources.map((r) => r.resourceType).filter((t) => t !== 'Patient'));
  for (const t of types) {
    for (const r of await searchAll(client, t, { identifier: 'urn:ga-server:id:ccda|' })) if (r.meta?.source === file) await client.deleteResource(t, r.id as string);
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
  await assertTestProject(client);
  for (const m of await client.searchResources('ConceptMap', { _count: '1000' }, { cache: 'no-cache' })) {
    if (TEST_MAP.test(decodeURI(m.url ?? ''))) await client.deleteResource('ConceptMap', m.id as string);
  }
}
