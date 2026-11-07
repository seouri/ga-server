import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getStatus, MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { AccessPolicy, ClientApplication, Patient, ProjectMembership } from '@medplum/fhirtypes';
import { defaultConfigPath, GaError, type GaConfig, loadConfig, notRunning } from './config.ts';
import { PATIENT_COMPARTMENT } from './share/scope.ts';

const ADMIN = 'admin@example.com';
const DEFAULT_PASSWORD = 'medplum_admin'; // Medplum's seeded admin password; setup rotates it away on first run

// GA's own ordinary project: Medplum gives every login in the Super Admin project super-admin powers.
const PROJECT = 'GA';
// What the GA client may touch: the patient compartment plus the shared records the importers and sync write.
// Everything else (ClientApplication, User, Login, Project, ProjectMembership, AccessPolicy, Bot...) is denied.
const GA_TYPES = [...PATIENT_COMPARTMENT, 'Medication', 'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Device', 'Binary', 'Endpoint'];

// Logs in as admin with the stored rotated password, else the seeded default; rotates the default away.
// out: where the config is written (ga migrate writes config.next.json); projectName: tests use throwaway projects.
export async function setup(
  baseUrl = 'http://localhost:8103/',
  converterUrl = 'http://localhost:8104/',
  { out = defaultConfigPath(), projectName = PROJECT }: { out?: string; projectName?: string } = {},
): Promise<GaConfig> {
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
  const medplum = new MedplumClient({ baseUrl });
  let login;
  let password = '';
  for (const p of [stored?.adminPassword, DEFAULT_PASSWORD]) {
    if (!p) continue;
    try {
      login = await medplum.startLogin({ email: ADMIN, password: p, projectId: known });
      password = p;
      break;
    } catch (e) {
      if (notRunning(e)) throw new GaError('GA is not running: run docker compose up');
      if (!(e instanceof OperationOutcomeError) || getStatus(e.outcome) !== 400) throw e;
    }
  }
  if (!login) throw new GaError(`admin login failed: the password in ${path} does not match and the default was already changed (restore your backup of that file)`);
  // One membership (Super Admin only) logs straight in; several list memberships to pick from.
  const named = (login.memberships ?? []).filter((m) => m.project?.display === projectName);
  if (named.length > 1) throw new GaError(`the admin account has several Medplum projects named ${projectName}`);
  const existing = named[0]?.project?.reference?.split('/')[1];
  const code = known
    ? login.code
    : existing
      ? (await medplum.startLogin({ email: ADMIN, password, projectId: existing })).code
      : (await medplum.startNewProject({ login: (await medplum.startLogin({ email: ADMIN, password, projectId: 'new' })).login, projectName })).code;
  if (!code) throw new GaError('admin login did not return a code');
  await medplum.processCode(code);
  const projectId = medplum.getActiveLogin()?.project.reference?.split('/')[1];
  if (!projectId) throw new GaError('could not determine the GA project');

  const policy = await medplum.upsertResource<AccessPolicy>(
    { resourceType: 'AccessPolicy', name: 'ga-server-cli', resource: GA_TYPES.map((resourceType) => ({ resourceType })) },
    { name: 'ga-server-cli' },
  );
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

  const patient = await medplum.createResourceIfNoneExist<Patient>(
    { resourceType: 'Patient', identifier: [{ system: 'urn:ga-server:id:patient', value: 'self' }] },
    'identifier=urn:ga-server:id:patient|self',
  );

  const rotate = password === DEFAULT_PASSWORD;
  const cfg: GaConfig = {
    baseUrl,
    clientId: client.id as string,
    clientSecret: client.secret as string,
    patientId: patient.id as string,
    projectId,
    converterUrl,
    adminPassword: rotate ? randomBytes(24).toString('base64url') : password,
  };
  // Saved before the change: if the change fails, the next run falls back to the default and rotates again.
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(out, 0o600);
  if (rotate) await medplum.post('auth/changepassword', { oldPassword: DEFAULT_PASSWORD, newPassword: cfg.adminPassword });
  return cfg;
}
