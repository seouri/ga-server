// `ga` CLI against a store (or Medplum) that is not running: one line, exit 1, never a stack trace.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { writeSources } from '../src/smart/store.ts';
import { tempStore } from './temp-store.ts';

let dir: string;
// A port that was just free: nothing listens there.
const server = createServer();
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const DOWN = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
await new Promise((ok) => server.close(ok));
const cli = (env: Record<string, string>, ...args: string[]) =>
  spawnSync('node', ['src/cli.ts', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, GA_CONFIG: join(dir, 'config.json'), ...env } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ga-cli-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ baseUrl: DOWN, clientId: 'c', clientSecret: 's', patientId: 'p', converterUrl: DOWN }));
  mkdirSync(join(dir, 'store'));
  writeFileSync(join(dir, 'store', 'token'), 'x'.repeat(43));
  writeSources(join(dir, 'smart'), [{ key: 'fhir-example-org', name: 'Example', fhirBase: 'https://fhir.example.org/api/FHIR/R4' }]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.each([
  ['sqlite', { GA_STORE: 'sqlite', GA_STORE_URL: DOWN }],
  ['medplum', { GA_STORE: 'medplum' }],
])('ga status with the %s store down prints only the not-running message and exits 1', (_, env) => {
  const r = cli(env, 'status');
  expect(r.stderr).toBe('GA is not running: start it with docker compose up -d\n');
  expect(r.stdout).toBe('');
  expect(r.status).toBe(1);
});

test('ga whats-new with the store down prints only the not-running message', () => {
  const r = cli({ GA_STORE: 'sqlite', GA_STORE_URL: DOWN }, 'whats-new');
  expect(r.stderr).toBe('GA is not running: start it with docker compose up -d\n');
  expect(r.stdout).toBe('');
  expect(r.status).toBe(1);
});

test('a failing fetch to another host (a hospital) with the store running is not "GA is not running"', async () => {
  rmSync(join(dir, 'store'), { recursive: true });
  const store = await tempStore(dir); // the CLI finds its token next to GA_CONFIG
  try {
    const env = { GA_STORE: 'sqlite', GA_STORE_URL: store.base };
    // async spawn: the store answers from this process meanwhile
    const r = await new Promise<{ status: number | null; stderr: string }>((ok) => {
      const c = spawn('node', ['src/cli.ts', 'connect', `${DOWN}fhir`, '--client-id', 'x'], { env: { PATH: process.env.PATH!, GA_CONFIG: join(dir, 'config.json'), ...env } });
      let stderr = '';
      c.stderr.on('data', (d) => (stderr += d));
      c.on('close', (status) => ok({ status, stderr }));
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain('GA is not running');
  } finally { await store.close(); }
});

test('ga migrate-store --file needs a path, not another flag', () => {
  for (const args of [['--file', '--yes'], ['--file'], ['--yes', '--file', '--services-stopped']]) {
    const r = cli({ GA_STORE: 'medplum' }, 'migrate-store', ...args);
    expect(r.stderr, args.join(' ')).toMatch(/^usage: /);
    expect(r.status).toBe(1);
  }
});

test('ga migrate-store --yes refuses to switch before touching services (full FHIR spec support first)', () => {
  const r = cli({ GA_STORE: 'medplum' }, 'migrate-store', '--yes', '--file', join(dir, 'x.db'));
  expect(r.stderr).toContain('The SQLite store switches once full FHIR spec support is done');
  expect(r.status).toBe(1);
});

test('fhir-export import needs --fhir-base', () => {
  const json = join(dir, 'ehr-data.json');
  writeFileSync(json, '{}');
  expect(cli({}, 'import', json).stderr).toMatch('usage: ga import <fhir-export.json> --fhir-base <FHIR base URL>');
});

test('rejects a --fhir-base that is not a URL', () => {
  const json = join(dir, 'ehr-data.json');
  writeFileSync(json, '{}');
  expect(cli({}, 'import', json, '--fhir-base', 'nope').stderr).toMatch('--fhir-base needs an http(s) URL');
});

test('rejects a --fhir-base that is not http(s) with a host', () => {
  const json = join(dir, 'ehr-data.json');
  writeFileSync(json, '{}');
  for (const bad of ['file:///etc/fhir', 'urn:example:fhir', 'ftp://fhir.example.org/R4']) {
    expect(cli({}, 'import', json, '--fhir-base', bad).stderr, bad).toMatch('--fhir-base needs an http(s) URL');
  }
});
