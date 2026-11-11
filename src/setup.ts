import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ClientStorage, getStatus, MedplumClient, MemoryStorage, OperationOutcomeError } from '@medplum/core';
import type { AccessPolicy, ClientApplication, Patient, ProjectMembership } from '@medplum/fhirtypes';
import { defaultConfigPath, GaError, type GaConfig, getClient, isGaNotRunning, loadConfig, NOT_RUNNING, storeKind } from './config.ts';
import { GA_STORE_TYPES } from './store-types.ts';

const ADMIN = 'admin@example.com';
const DEFAULT_PASSWORD = 'medplum_admin'; // Medplum's seeded admin password; setup rotates it away on first run

// GA's own ordinary project: Medplum gives every login in the Super Admin project super-admin powers.
const PROJECT = 'Guardian Angel'; // Medplum requires 4-72 characters
// What the GA client may touch on Medplum: the types GA's own store keeps (the patient compartment plus the shared records
// the importers and sync write). Everything else (ClientApplication, User, Login, Project, ProjectMembership, AccessPolicy,
// Bot...) is denied.
export const ACCESS_POLICY: AccessPolicy = { resourceType: 'AccessPolicy', name: 'ga-server-cli', resource: GA_STORE_TYPES.map((resourceType) => ({ resourceType })) };

// Logs in as admin with the stored rotated password, else the seeded default; rotates the default away.
// out: where the config is written (ga migrate writes config.next.json); projectName: tests use throwaway projects;
// noRotate: only the stored password is tried, never the seeded default (which would be rotated away): the integration run's guard.
export async function setup(
  baseUrl = 'http://localhost:8103/',
  { out = defaultConfigPath(), projectName = PROJECT, noRotate = false }: { out?: string; projectName?: string; noRotate?: boolean } = {},
): Promise<GaConfig> {
  let written: GaConfig | undefined;
  try {
    written = JSON.parse(readFileSync(out, 'utf8')) as GaConfig; // as written: loadConfig's env overrides must not be saved
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new GaError(`cannot read ${out}: fix or move it before ga setup`); // never overwrite keys we could not read
  }
  if (storeKind(written) === 'sqlite') return setupStore(out, written);
  const path = defaultConfigPath();
  const tryLoad = (f: string) => {
    try {
      return loadConfig(f);
    } catch {
      return undefined; // first run: no config yet
    }
  };
  const stored = tryLoad(path);
  // The project of an earlier run: one login instead of two (Medplum allows 5 password logins a minute).
  const known = (out === path ? stored : tryLoad(out))?.projectId;
  // An install from before GA had its own project: a fresh setup here would point GA at an empty project.
  if (out === path && stored?.clientId && !stored.projectId) throw new GaError('this GA install predates its own Medplum project: run ga migrate');
  // Memory storage: Node's localStorage is experimental (it warns). Our own PKCE pair: Medplum hashes the verifier with window.btoa,
  // which Node lacks, and falls back to a plain challenge with a stack trace; processCode reads the verifier from storage.
  const storage = new ClientStorage(new MemoryStorage());
  const medplum = new MedplumClient({ baseUrl, storage });
  const verifier = randomBytes(32).toString('base64url'); // one pair serves every login of this run
  storage.setString('codeVerifier', verifier);
  const pkce = { codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' as const };
  let login;
  let password = '';
  for (const p of noRotate ? [stored?.adminPassword] : [stored?.adminPassword, DEFAULT_PASSWORD]) {
    if (!p) continue;
    try {
      login = await medplum.startLogin({ email: ADMIN, password: p, projectId: known, ...pkce });
      password = p;
      break;
    } catch (e) {
      if (isGaNotRunning(e)) throw new GaError(NOT_RUNNING);
      if (!(e instanceof OperationOutcomeError) || getStatus(e.outcome) !== 400) throw e;
    }
  }
  if (!login && noRotate) throw new GaError(`admin login failed: the password in ${path} does not match; not trying the default password, which would rotate the admin password away`);
  if (!login) throw new GaError(`admin login failed: the password in ${path} does not match and the default was already changed (restore your backup of that file)`);
  // One membership (Super Admin only) logs straight in; several list memberships to pick from.
  const named = (login.memberships ?? []).filter((m) => m.project?.display === projectName);
  if (named.length > 1) throw new GaError(`the admin account has several Medplum projects named ${projectName}`);
  const existing = named[0]?.project?.reference?.split('/')[1];
  const code = known
    ? login.code
    : existing
      ? (await medplum.startLogin({ email: ADMIN, password, projectId: existing, ...pkce })).code
      : (await medplum.startNewProject({ login: (await medplum.startLogin({ email: ADMIN, password, projectId: 'new', ...pkce })).login, projectName })).code;
  if (!code) throw new GaError('admin login did not return a code');
  await medplum.processCode(code);
  const projectId = medplum.getActiveLogin()?.project.reference?.split('/')[1];
  if (!projectId) throw new GaError('could not determine the GA project');

  const policy = await medplum.upsertResource<AccessPolicy>({ ...ACCESS_POLICY }, { name: 'ga-server-cli' });
  const accessPolicy = { reference: `AccessPolicy/${policy.id}` };
  const client =
    (await medplum.searchOne('ClientApplication', { name: 'ga-server-cli' })) ??
    ((await medplum.post(`admin/projects/${projectId}/client`, { name: 'ga-server-cli', accessPolicy })) as ClientApplication);
  // The client must stay an ordinary member under the policy, also when reused.
  const membership = await medplum.searchOne('ProjectMembership', { profile: `ClientApplication/${client.id}` });
  if (!membership) throw new GaError('GA client has no project membership');
  if (membership.admin || membership.accessPolicy?.reference !== accessPolicy.reference) {
    await medplum.updateResource<ProjectMembership>({ ...membership, admin: false, accessPolicy });
  }

  const patient = await selfPatient(medplum);

  const rotate = !noRotate && password === DEFAULT_PASSWORD; // noRotate never changes the admin password
  const cfg: GaConfig = {
    baseUrl,
    clientId: client.id as string,
    clientSecret: client.secret as string,
    patientId: patient.id as string,
    projectId,
    adminPassword: rotate ? randomBytes(24).toString('base64url') : password,
    terminologyLookup: written?.terminologyLookup ?? true, // written so the person sees it; their off switch survives a re-run
  };
  // Saved before the change: if the change fails, the next run falls back to the default and rotates again.
  writeConfig(out, cfg);
  if (rotate) await medplum.post('auth/changepassword', { oldPassword: DEFAULT_PASSWORD, newPassword: cfg.adminPassword });
  return cfg;
}

const selfPatient = (client: MedplumClient) => client.createResourceIfNoneExist<Patient>(
  { resourceType: 'Patient', identifier: [{ system: 'urn:ga-server:id:patient', value: 'self' }] },
  'identifier=urn:ga-server:id:patient|self',
);

function writeConfig(out: string, cfg: GaConfig): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(out, 0o600);
}

// GA's own store: no logins, so no project, client or admin password; only the self Patient and the config. Keys already in
// the config (Medplum's, for a rollback; storeUrl) are kept.
async function setupStore(out: string, stored: GaConfig | undefined): Promise<GaConfig> {
  const patient = await selfPatient(await getClient({ ...(stored ?? ({} as GaConfig)), store: 'sqlite' }));
  const cfg: GaConfig = { ...stored, patientId: patient.id as string, store: 'sqlite', terminologyLookup: stored?.terminologyLookup ?? true };
  writeConfig(out, cfg);
  return cfg;
}
