import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MedplumClient } from '@medplum/core';
import type { ClientApplication, Patient } from '@medplum/fhirtypes';
import { defaultConfigPath, GaError, type GaConfig } from './config.ts';

// shortcut: seeded admin password left unchanged, safe only while bound to localhost; change before the sharing milestone.
export async function setup(
  baseUrl = 'http://localhost:8103/',
  converterUrl = 'http://localhost:8104/',
): Promise<GaConfig> {
  const medplum = new MedplumClient({ baseUrl });
  let login;
  try {
    login = await medplum.startLogin({ email: 'admin@example.com', password: 'medplum_admin' });
  } catch (e) {
    if ((e as Error)?.message === 'fetch failed') throw new GaError('GA is not running: run docker compose up');
    throw e;
  }
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

  const cfg: GaConfig = {
    baseUrl,
    clientId: client.id as string,
    clientSecret: client.secret as string,
    patientId: patient.id as string,
    converterUrl,
  };
  const path = defaultConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return cfg;
}
