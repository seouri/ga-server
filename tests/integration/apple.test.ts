import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { AllergyIntolerance, Observation, Patient } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { existing, importAppleHealth } from '../../src/apple/import.ts';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { APPLE } from '../../src/identity.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'apple');
let cfg: GaConfig;
let client: MedplumClient;
let pid: string;
let dir: string;
let firstCreated = 0;

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
  pid = await createTestPatient(client);
  dir = mkdtempSync(join(tmpdir(), 'apple-'));
  cpSync(FIXTURE, dir, { recursive: true });
});

afterAll(async () => {
  await cleanupTestPatient(client, pid);
  rmSync(dir, { recursive: true, force: true });
});

const xml = () => readFileSync(join(dir, 'export.xml'), 'utf8');
const put = (s: string) => writeFileSync(join(dir, 'export.xml'), s);

test('first import', async () => {
  const r = await importAppleHealth(client, cfg, dir, pid);
  firstCreated = r.created;
  expect(r.created).toBeGreaterThan(0);
  expect(r.possibleDuplicates).toBe(0);
  expect(r.archived).toBe('stored');
  const p = await client.readResource('Patient', pid) as Patient;
  expect(p.identifier!.some((i) => i.system !== 'urn:ga-server:id:patient')).toBe(true);
  const a = await client.searchResources('AllergyIntolerance', { patient: `Patient/${pid}`, identifier: `${APPLE}|` }, { cache: 'no-cache' }) as AllergyIntolerance[];
  expect(a.length).toBeGreaterThan(0);
});

test('re-import is a no-op', async () => {
  const r = await importAppleHealth(client, cfg, dir, pid);
  expect(r.created).toBe(0);
  expect(r.updated).toBe(0);
  expect(r.archived).toBe('already-present');
  expect(r.unchanged).toBe(firstCreated);
});

test('renamed source creates nothing', async () => {
  put(xml().replaceAll('Test Watch', 'Renamed Watch'));
  const r = await importAppleHealth(client, cfg, dir, pid);
  expect(r.created).toBe(0);
});

test('newer export updates a partial day', async () => {
  const hr = `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Renamed Watch" unit="count/min" creationDate="2026-03-01 11:00:00 -0500" startDate="2026-03-01 11:00:00 -0500" endDate="2026-03-01 11:00:00 -0500" value="120"/>\n</HealthData>`;
  put(xml().replace('</HealthData>', hr).replace('2026-11-05 13:39:52', '2026-11-06 13:39:52'));
  const r = await importAppleHealth(client, cfg, dir, pid);
  expect(r.updated).toBeGreaterThanOrEqual(1);
  const daily = (await client.searchResources('Observation', { subject: `Patient/${pid}`, 'code:text': 'Heart rate, daily mean' }, { cache: 'no-cache' })) as Observation[];
  expect(daily).toHaveLength(1);
  expect(daily[0].component!.find((c) => c.code.text === 'Maximum')!.valueQuantity!.value).toBe(120);
});

test('cli routes apple folders', () => {
  const r = spawnSync('node', [join(import.meta.dirname, '..', '..', 'src', 'cli.ts'), 'import', dir, 'extra'], { encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('usage: ga import <apple-health-folder>');
});

test('existing pages by lastUpdated windows when a window is too big', async () => {
  const all = await existing(client, pid);
  expect(all.size).toBeGreaterThan(3);
  expect(await existing(client, pid, 2)).toEqual(all);
});
