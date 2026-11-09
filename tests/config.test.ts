import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { getClient, loadConfig, medplumOnly, MOVED, storeKind } from '../src/config.ts';
import { MedplumClient } from '@medplum/core';
import { onStore } from './temp-store.ts';

afterEach(() => vi.unstubAllEnvs());

test('config missing gives clear error', () => {
  expect(() => loadConfig('/nonexistent/config.json')).toThrow('run ga setup first');
});

test.skipIf(process.getuid?.() === 0)('an unreadable config names UID/GID (the ga-sync container user)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ga-cfg-')), 'config.json');
  writeFileSync(f, '{}');
  chmodSync(f, 0o000);
  expect(() => loadConfig(f)).toThrow('cannot read .ga/config.json: set UID/GID');
});

test('GA_BASE_URL overrides baseUrl (the ga-sync container reaches Medplum by service name)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ga-cfg-')), 'config.json');
  writeFileSync(f, JSON.stringify({ baseUrl: 'http://localhost:8103/', patientId: 'p' }));
  expect(loadConfig(f).baseUrl).toBe('http://localhost:8103/');
  vi.stubEnv('GA_BASE_URL', 'http://medplum-server:8103/');
  expect(loadConfig(f)).toMatchObject({ baseUrl: 'http://medplum-server:8103/', patientId: 'p' });
});

test('the store comes from config.store; GA_STORE overrides it; Medplum by default', () => {
  vi.stubEnv('GA_STORE', '');
  expect(storeKind({ patientId: 'p', store: 'sqlite' })).toBe('sqlite');
  expect(storeKind({ patientId: 'p' })).toBe('medplum');
  vi.stubEnv('GA_STORE', 'medplum');
  expect(storeKind({ patientId: 'p', store: 'sqlite' })).toBe('medplum');
  vi.stubEnv('GA_STORE', 'sqlite');
  expect(storeKind({ patientId: 'p' })).toBe('sqlite');
});

test('getClient on a config with store: sqlite talks to the store, without GA_STORE', async () => {
  vi.stubEnv('GA_STORE', '');
  await onStore(async ({ dir, base }) => {
    vi.stubEnv('GA_CONFIG', join(dir, 'config.json'));
    const c = await getClient({ patientId: 'p', store: 'sqlite', storeUrl: base });
    expect((await c.createResource({ resourceType: 'Patient' })).id).toBeTruthy();
  });
});

test('a Medplum client refuses every request once the config on disk says "store": "sqlite" (a stale stdio MCP after the switch)', async () => {
  vi.stubEnv('GA_STORE', ''); // the store choice comes from the file here
  const dir = mkdtempSync(join(tmpdir(), 'ga-moved-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ baseUrl: 'http://medplum.invalid/', patientId: 'p' }));
  let calls = 0;
  const f = medplumOnly(async () => { calls++; return new Response(JSON.stringify({ resourceType: 'Patient', id: 'p' }), { headers: { 'content-type': 'application/fhir+json' } }); }, path);
  const client = new MedplumClient({ baseUrl: 'http://medplum.invalid/', fetch: f });
  await client.readResource('Patient', 'p');
  expect(calls).toBe(1);
  writeFileSync(path, JSON.stringify({ baseUrl: 'http://medplum.invalid/', patientId: 'p', store: 'sqlite' }));
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // a new mtime even on a coarse clock
  await expect(client.readResource('Patient', 'p', { cache: 'no-cache' })).rejects.toThrow(MOVED);
  expect(calls).toBe(1);
  vi.stubEnv('GA_STORE', 'medplum'); // an explicit Medplum override still works (tests, rollback)
  utimesSync(path, new Date(), new Date(Date.now() + 10000));
  await client.readResource('Patient', 'p', { cache: 'no-cache' });
  expect(calls).toBe(2);
  vi.unstubAllEnvs();
});
