// ga setup with GA_STORE=sqlite: the self Patient in the store, a config without Medplum credentials, no Medplum calls.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setup } from '../src/setup.ts';
import { tempStore, type TempStore } from './temp-store.ts';

let store: TempStore, dir: string, base: string;
beforeEach(async () => {
  store = await tempStore();
  ({ dir, base } = store);
  vi.stubEnv('GA_STORE', 'sqlite');
  vi.stubEnv('GA_STORE_URL', base);
  vi.stubEnv('GA_CONFIG', join(dir, 'config.json'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await store.close();
});

test('setup on the store creates exactly one self Patient (twice) and writes a config without Medplum credentials', async () => {
  const medplum = 'http://127.0.0.1:9/'; // never contacted: a Medplum call would fail the test
  const first = await setup(medplum);
  const again = await setup(medplum);
  expect(again.patientId).toBe(first.patientId);
  const patients = await store.client.searchResources('Patient', {});
  expect(patients.map((p) => p.id)).toEqual([first.patientId]);
  expect(patients[0].identifier).toEqual([{ system: 'urn:ga-server:id:patient', value: 'self' }]);
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  expect(cfg).toEqual({ patientId: first.patientId, store: 'sqlite' });
  expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
});

test('a setup re-run on the store keeps the other config keys (Medplum rollback, storeUrl); only patientId changes (a leftover converterUrl stays as written)', async () => {
  const before = { baseUrl: 'http://localhost:8103/', clientId: 'c', clientSecret: 's', patientId: 'old', projectId: 'pr', converterUrl: 'http://old:8104/', storeUrl: 'http://store:8120/', adminPassword: 'pw' };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(before));
  const cfg = await setup('http://127.0.0.1:9/');
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({ ...before, patientId: cfg.patientId, store: 'sqlite' });
  expect(cfg.patientId).not.toBe('old');
});

test('setup on the store refuses to overwrite a config it cannot parse', async () => {
  writeFileSync(join(dir, 'config.json'), '{"clientSecret": "s",');
  await expect(setup('http://127.0.0.1:9/')).rejects.toThrow(/cannot read/);
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{"clientSecret": "s",');
});
