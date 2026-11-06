// SMART CLI argument and usage errors: spawns the CLI against a temp GA_CONFIG with no config.json, so nothing reaches Medplum.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readApp, readSources, writeSources } from '../src/smart/store.ts';

let dir: string;
const cli = (...args: string[]) =>
  spawnSync('node', ['src/cli.ts', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, GA_CONFIG: join(dir, 'config.json') } });
const smart = () => join(dir, 'smart');
const src = { key: 'fhir-example-org', name: 'Example', fhirBase: 'https://fhir.example.org/api/FHIR/R4' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ga-smart-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('status with no sources prints "no sources connected" without contacting Medplum', () => {
  const r = cli('status');
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe('no sources connected');
});

test('sync --enable without a connected source is a usage error', () => {
  const r = cli('sync', '--enable', 'Condition');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/no sources connected: run ga connect <fhir-base-url>/);
});

test('sync with no sources prints "no sources connected"', () => {
  const r = cli('sync');
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe('no sources connected');
});

test('unknown option and unknown type are usage errors', () => {
  expect(cli('sync', '--bogus').stderr).toMatch(/^usage: ga sync/);
  writeSources(smart(), [src]);
  const r = cli('sync', '--enable', 'Observations');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/unknown type: Observations/);
  expect(readSources(smart())[0].enabledTypes).toBeUndefined();
});

test('sync --enable needs the source when several are connected; unknown source is an error', () => {
  writeSources(smart(), [src, { ...src, key: 'fhir-other-org', name: 'Other' }]);
  expect(cli('sync', '--enable', 'all').stderr).toMatch(/name the source/);
  const r = cli('sync', 'nope');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/unknown source: nope/);
  expect(cli('disconnect', 'nope').stderr).toMatch(/unknown source: nope/);
});

test('connect needs a URL, and a client id the first time', () => {
  expect(cli('connect').stderr).toMatch(/^usage: ga connect/);
  const r = cli('connect', 'https://fhir.example.org/api/FHIR/R4');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/--client-id/);
  expect(readApp(smart()).clientId).toBeUndefined();
});

test('keys prints the public JWKS and PEM, and keeps the key on a second run', () => {
  const a = cli('keys');
  expect(a.status).toBe(0);
  expect(a.stdout).toContain('"kty": "RSA"');
  expect(a.stdout).toContain('-----BEGIN PUBLIC KEY-----');
  expect(a.stdout).not.toMatch(/"d":/);
  expect(existsSync(join(smart(), 'private.jwk.json'))).toBe(true);
  const b = cli('keys');
  expect(b.stdout.match(/"n": "[^"]+"/)?.[0]).toBe(a.stdout.match(/"n": "[^"]+"/)?.[0]);
});
