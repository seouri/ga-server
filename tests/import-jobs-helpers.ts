// Shared by tests/import-jobs.test.ts and its Medplum run: a zipped synthetic export, an upload, waiting for a job, a store
// snapshot, and a job attempt in a CLI child that kills itself mid-batch (a gateway crash).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { expect } from 'vitest';
import { type JobRecord, jobStatus } from '../src/import-jobs.ts';
import { ARRIVED, sorted } from '../src/identity.ts';
import { writeAppleTestExport } from './fixtures-gen/apple.ts';

export async function appleZip(work: string, days: number): Promise<string> {
  await writeAppleTestExport(join(work, 'apple_health_export'), days);
  expect(spawnSync('zip', ['-qr', 'export.zip', 'apple_health_export'], { cwd: work }).status).toBe(0);
  return join(work, 'export.zip');
}

// An upload as the gateway keeps it: a copy under uploads/<fileId>/.
export function upload(dir: string, from: string): string {
  const to = join(dir, 'uploads', 'f'.repeat(22), from.split('/').pop()!);
  mkdirSync(join(to, '..'), { recursive: true });
  cpSync(from, to, { recursive: true });
  return to;
}
export async function settled(dir: string, id: string, ms = 120_000): Promise<JobRecord> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const j = jobStatus(dir, id)!;
    if (j.status !== 'running') return j;
  }
  throw new Error('job never settled');
}

// Everything the import wrote, without server ids, times and arrival stamps; a reference reads as its target's identifier (a
// shared record outside the patient's compartment, such as a C-CDA's Practitioner, as its type).
export async function snapshot(client: MedplumClient, pid: string): Promise<string[]> {
  const b = await client.get<Bundle>(`fhir/R4/Patient/${pid}/$everything?_count=1000`, { cache: 'no-cache' });
  const every = (b.entry ?? []).map((e) => e.resource as Resource & { identifier?: { system?: string; value?: string }[] });
  const idOf = new Map(every.map((r) => [`${r.resourceType}/${r.id}`, JSON.stringify(r.identifier ?? r.resourceType)]));
  const all = every.filter((r) => r.resourceType !== 'Patient' && r.resourceType !== 'Provenance' && ![r.identifier ?? []].flat().some((i) => i.system?.endsWith('-archive') || i.system === 'urn:ga-server:id:file'));
  return all.map((r) => {
    const { id: _i, meta, extension, ...rest } = r as Resource & { extension?: { url: string }[] };
    const ext = extension?.filter((e) => e.url !== ARRIVED);
    return JSON.stringify({ ...rest, tag: meta?.tag, ...(ext?.length && { extension: ext }) }, (k, v) => (k === 'reference' && typeof v === 'string' ? idOf.get(v) ?? v.replace(/\/[^/]+$/, '') : sorted(k, v)));
  }).map((x) => x.replaceAll(pid, 'PATIENT').replace(/\|[0-9a-f]{64}/g, '|HASH').replace(/"Binary\/[^"]+"/g, '"Binary"')).sort();
}
export const report = (r: unknown) => { const { seconds: _s, ...rest } = r as { seconds?: number }; return rest; };

// A job attempt in a CLI child that SIGKILLs itself at a chosen point (a gateway crash): see tests/import-job-crash.ts.
export async function crash(config: string, dir: string, id: string, kill: { at?: number; creates?: number; type?: string; file?: string; unlock?: boolean }): Promise<void> {
  const env: Record<string, string> = { PATH: process.env.PATH!, GA_CONFIG: config, GA_TEST_JOB: join(dir, 'imports', id, 'job.json') };
  if (kill.at !== undefined) env.GA_TEST_KILL_AT = String(kill.at);
  if (kill.creates) env.GA_TEST_KILL_CREATES = String(kill.creates);
  if (kill.type) env.GA_TEST_KILL_TYPE = kill.type;
  if (kill.file) env.GA_TEST_KILL_FILE = kill.file;
  if (kill.unlock) env.GA_TEST_KILL_UNLOCK = '1';
  const c = spawn('node', ['--import', join(import.meta.dirname, 'import-job-crash.ts'), join(import.meta.dirname, '..', 'src', 'cli.ts'), 'import-job', id], { env });
  let err = '';
  c.stderr.on('data', (d) => (err += d));
  const sig = await new Promise((ok) => c.on('close', (_code, s) => ok(s)));
  expect(sig, err).toBe('SIGKILL');
}
