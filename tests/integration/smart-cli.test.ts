// ga connect / sync / status / disconnect end to end: the CLI against the synthetic mock and the local Medplum, on a test patient.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { defaultConfigPath, getClient, loadConfig } from '../../src/config.ts';
import { sourceKey } from '../../src/smart/auth.ts';
import { ensureKeys, readSources } from '../../src/smart/store.ts';
import { serveFixtures, startMock } from '../smart/mock-server.ts';
import type { MockSmart } from '../smart/mock-server.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let dir: string;
let pid: string;
let m: MockSmart;
let key: string;

// Async: the mock answers from this process's event loop, which spawnSync would block.
const cli = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) =>
    execFile(
      'node',
      ['src/cli.ts', ...args],
      // GA_OPEN=fetch is the test-only browser stand-in; GA_PATIENT_ID keeps every write on the test patient.
      { encoding: 'utf8', env: { PATH: process.env.PATH!, GA_CONFIG: join(dir, 'config.json'), GA_PATIENT_ID: pid, GA_OPEN: 'fetch' } },
      (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
const compartment = async (): Promise<Resource[]> =>
  ((await client.get<Bundle>(`fhir/R4/Patient/${pid}/$everything?_count=1000`, { cache: 'no-cache' })).entry ?? [])
    .filter((e) => e.search?.mode === 'match' && e.resource?.resourceType !== 'Patient')
    .map((e) => e.resource as Resource);
const endpoint = async () =>
  (await client.searchResources('Endpoint', { identifier: `urn:ga-server:id:smart-source|${key}` }, { cache: 'no-cache' })).find(
    (e) => e.extension?.some((x) => x.valueReference?.reference === `Patient/${pid}`),
  );

beforeAll(async () => {
  const cfg = loadConfig();
  client = await getClient(cfg);
  pid = await createTestPatient(client);
  dir = mkdtempSync(join(tmpdir(), 'ga-smart-cli-int-'));
  // Medplum connection fields only, and the test patient (also passed as GA_PATIENT_ID): never the real patient id.
  const { baseUrl, clientId, clientSecret, converterUrl } = JSON.parse(readFileSync(defaultConfigPath(), 'utf8'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ baseUrl, clientId, clientSecret, patientId: pid, converterUrl }), { mode: 0o600 });
  const { publicJwks } = await ensureKeys(join(dir, 'smart'));
  m = await startMock({ clientId: 'synthetic-client', jwks: publicJwks });
  serveFixtures(m);
  key = sourceKey(m.fhirBase);
});

afterAll(async () => {
  const ep = await endpoint();
  if (ep) await client.deleteResource('Endpoint', ep.id as string);
  if (pid) await cleanupTestPatient(client, pid);
  await m?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('connect dry-runs, sync --enable writes, status reports, disconnect turns the source off', async () => {
  const c = await cli('connect', m.fhirBase, '--client-id', 'synthetic-client', '--name', 'Test Hospital');
  expect(c.stderr).not.toMatch(/smart sync|error/i);
  expect(c.code).toBe(0);
  expect(c.stdout).toMatch(/dry run/);
  expect(c.stdout).toMatch(/^ {2}Condition: fetched 2, created 2, linked 0, updated 0, flagged 0$/m);
  expect(c.stdout).toMatch(/created on a type GA already holds from Epic \(C-CDA\/EHI\) = likely duplicates/);
  expect(c.stdout).not.toMatch(/^ {2}Patient:/m);
  expect(c.stdout).toContain(`ga sync --enable <Type,...> ${key}`);
  expect(c.stdout).not.toContain('synthetic-patient-1');
  expect(await compartment()).toEqual([]); // a dry run writes no patient data
  expect((await endpoint())?.status).toBe('off'); // only the status entry: not_enabled

  const d = await cli('sync', '--dry-run');
  expect(d.code).toBe(0);
  expect(d.stdout).toMatch(/^ {2}Condition: fetched 2, created 2/m);
  expect(await compartment()).toEqual([]);

  expect((await cli('status')).stdout).toMatch(/Test Hospital \(127-0-0-1\): off \(not_enabled\), last success never, STALE, types: none \(dry run only\)/);

  const s = await cli('sync', '--enable', 'Condition', key);
  expect(s.code).toBe(0);
  expect(s.stdout).toMatch(/^127-0-0-1: active/m);
  expect(readSources(join(dir, 'smart'))[0].enabledTypes).toEqual(['Condition']);
  const types = new Set((await compartment()).map((r) => r.resourceType));
  expect(types.has('Condition')).toBe(true);
  expect(types.has('Observation')).toBe(false);
  expect((await cli('status')).stdout).toMatch(/Test Hospital \(127-0-0-1\): active, last success \S+Z, types: Condition/);

  // connect again with types enabled: a real sync, not a dry run
  const again = await cli('connect', m.fhirBase);
  expect(again.code).toBe(0);
  expect(again.stdout).toMatch(/^127-0-0-1: active created 0, updated 0/m);

  const x = await cli('disconnect', key);
  expect(x.code).toBe(0);
  const ep = await endpoint();
  expect(ep?.status).toBe('off');
  expect(ep?.extension?.find((e) => e.url === 'urn:ga-server:ext:smart-last-error')?.valueCode).toBe('disconnected');
  expect((await compartment()).length).toBeGreaterThan(0); // fetched records stay
  // The source stays listed (enabled types kept for a reconnect); sync skips it and leaves the Endpoint as disconnect wrote it.
  expect((await cli('status')).stdout).toMatch(/Test Hospital \(127-0-0-1\): off \(disconnected\), last success \S+Z, STALE, types: Condition/);
  const after = await cli('sync');
  expect(after.stdout).toMatch(/^127-0-0-1: off error not_connected: run ga connect/m);
  expect((await endpoint())?.extension?.find((e) => e.url === 'urn:ga-server:ext:smart-last-error')?.valueCode).toBe('disconnected');
});
