import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getStatus, MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { ClientApplication, Patient } from '@medplum/fhirtypes';
import { defaultConfigPath, GaError, type GaConfig, loadConfig, notRunning } from './config.ts';

const ADMIN = 'admin@example.com';
const DEFAULT_PASSWORD = 'medplum_admin'; // Medplum's seeded admin password; setup rotates it away on first run

// Logs in as admin with the stored rotated password, else the seeded default; rotates the default away.
export async function setup(
  baseUrl = 'http://localhost:8103/',
  converterUrl = 'http://localhost:8104/',
): Promise<GaConfig> {
  const path = defaultConfigPath();
  let stored: string | undefined;
  try {
    stored = loadConfig(path).adminPassword;
  } catch {
    // first run: no config yet
  }
  const medplum = new MedplumClient({ baseUrl });
  let login;
  let password = '';
  for (const p of [stored, DEFAULT_PASSWORD]) {
    if (!p) continue;
    try {
      login = await medplum.startLogin({ email: ADMIN, password: p });
      password = p;
      break;
    } catch (e) {
      if (notRunning(e)) throw new GaError('GA is not running: run docker compose up');
      if (!(e instanceof OperationOutcomeError) || getStatus(e.outcome) !== 400) throw e;
    }
  }
  if (!login) throw new GaError(`admin login failed: the password in ${path} does not match and the default was already changed (restore your backup of that file)`);
  if (!login.code) throw new GaError('admin login did not return a code');
  await medplum.processCode(login.code);
  const projectId = medplum.getActiveLogin()?.project.reference?.split('/')[1];
  if (!projectId) throw new GaError('could not determine admin project');

  const client =
    (await medplum.searchOne('ClientApplication', { name: 'ga-server-cli' })) ??
    ((await medplum.post(`admin/projects/${projectId}/client`, { name: 'ga-server-cli' })) as ClientApplication);

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
    converterUrl,
    adminPassword: rotate ? randomBytes(24).toString('base64url') : password,
  };
  // Saved before the change: if the change fails, the next run falls back to the default and rotates again.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  if (rotate) await medplum.post('auth/changepassword', { oldPassword: DEFAULT_PASSWORD, newPassword: cfg.adminPassword });
  return cfg;
}
