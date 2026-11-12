// ga share / shares / revoke / share export end to end on a test patient, plus the audit log and Binary download against real Medplum.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { logAccess, readLog } from '../../src/share/audit.ts';
import { binaryFetcher } from '../../src/share/cli.ts';
import type { Share } from '../../src/share/store.ts';
import { childConfig, cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let dir: string;
let pid: string;
const binaries: string[] = [];
const shareIds: string[] = [];

const cli = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) =>
    execFile(
      'node',
      ['src/cli.ts', ...args],
      // GA_PATIENT_ID keeps the share on the test patient; GA_SHARE_URL skips the tailscale lookup.
      { encoding: 'utf8', env: { PATH: process.env.PATH!, GA_CONFIG: join(dir, 'config.json'), GA_PATIENT_ID: pid, GA_SHARE_URL: 'http://localhost:1' } },
      (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );

const deleteEvents = async (id: string): Promise<void> => {
  for (const a of await client.searchResources('AuditEvent', { _tag: `urn:ga-server:share|${id}`, _count: '1000' }, { cache: 'no-cache' }))
    await client.deleteResource('AuditEvent', a.id as string);
};

beforeAll(async () => {
  const cfg = loadConfig();
  client = await getClient(cfg);
  pid = await createTestPatient(client);
  dir = mkdtempSync(join(tmpdir(), 'ga-share-cli-int-'));
  // The store connection only, and the test patient: never the real patient id.
  childConfig(dir, pid);
  await client.createResource<Observation>({
    resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${pid}` }, code: { text: 'test lab' },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
    effectiveDateTime: '2025-01-01', valueQuantity: { value: 1, unit: 'mg/dL' },
  });
});

afterAll(async () => {
  for (const id of shareIds) await deleteEvents(id);
  for (const b of binaries) await client.deleteResource('Binary', b).catch(() => undefined);
  if (pid) await cleanupTestPatient(client, pid);
  rmSync(dir, { recursive: true, force: true });
});

test('share, list, export, revoke', async () => {
  const c = await cli('share', '--for', 'doctor', '--label', 'T');
  expect(c.stderr).not.toMatch(/error/i);
  expect(c.code).toBe(0);
  expect(c.stdout).toMatch(/http:\/\/localhost:1\/s\/[A-Za-z0-9_-]{43}/);
  expect(c.stdout).toMatch(/labs, medications/);
  const [{ id }] = JSON.parse(readFileSync(join(dir, 'share', 'shares.json'), 'utf8')) as Share[];
  shareIds.push(id);

  const l = await cli('shares');
  expect(l.code).toBe(0);
  expect(l.stdout).toMatch(new RegExp(`${id}\\s+T\\s+doctor.*active`));

  const out = mkdtempSync(join(tmpdir(), 'ga-share-export-'));
  try {
    const x = await cli('share', 'export', id, '--out', out);
    expect(x.stderr).not.toMatch(/error/i);
    expect(x.code).toBe(0);
    const [json, pdf] = readdirSync(out).sort();
    expect(pdf).toMatch(/^patient_health-summary_\d{4}-\d{2}-\d{2}_\d{4}\.pdf$/); // test patient has no name
    expect(json).toMatch(/^patient_health-records-FHIR_\d{4}-\d{2}-\d{2}_\d{4}\.json$/);
    expect(readFileSync(join(out, pdf)).subarray(0, 4).toString()).toBe('%PDF');
    const b = JSON.parse(readFileSync(join(out, json), 'utf8'));
    expect(b.resourceType).toBe('Bundle');
    expect(b.entry.some((e: { resource: Observation }) => e.resource.code?.text === 'test lab')).toBe(true);
    expect(statSync(join(out, pdf)).mode & 0o777).toBe(0o600);
    expect(statSync(join(out, json)).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  expect((await cli('share', '--scope', 'labs,bogus')).stderr).toMatch(/unknown group bogus.*labs, vitals/);

  expect((await cli('revoke', id)).code).toBe(0);
  expect((await cli('shares')).stdout).toMatch(new RegExp(`${id}\\s+T.*revoked`));
});

test('logAccess writes an AuditEvent that readLog finds by share and system-wide', async () => {
  const id = `test-${randomUUID()}`;
  shareIds.push(id);
  const share: Share = {
    id, label: 'audit test', audience: 'doctor', groups: ['labs'], layout: 'A', questionsPerDay: 20,
    tokenHash: 'h', patientId: pid, baseUrl: 'http://x', created: new Date().toISOString(),
  };
  await logAccess(client, share, { kind: 'question', detail: 'q?', ip: '192.0.2.1', ua: 'test-agent', answerLength: 3 });
  const mine = await readLog(client, id);
  expect(mine).toEqual([expect.objectContaining({ label: 'audit test', kind: 'question', detail: 'q?', ip: '192.0.2.1' })]);
  const all = await readLog(client);
  expect(all.some((e) => e.label === 'audit test' && e.detail === 'q?')).toBe(true);
});

test('binaryFetcher returns the Binary bytes and content type', async () => {
  const b = await client.createBinary({ data: 'test note bytes', contentType: 'text/plain', securityContext: { reference: `Patient/${pid}` } });
  binaries.push(b.id as string);
  const got = (await binaryFetcher(client)(`Binary/${b.id}`, pid))!;
  expect(got.data.toString('utf8')).toBe('test note bytes');
  expect(got.contentType).toMatch(/^text\/plain/);
});
