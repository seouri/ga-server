// import_file jobs: a worker thread per attempt, a checkpoint per batch, resume after a crash or restart (temp SQLite stores).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createGateway } from '../src/gateway/server.ts';
import { inWorker, jobStatus, recordJob, resumeJobs, runJob, startJob } from '../src/import-jobs.ts';
import { registerImportTools } from '../src/tools/imports.ts';
import { appleZip, crash, report, settled, snapshot, upload } from './import-jobs-helpers.ts';
import { type TempStore, tempStore } from './temp-store.ts';

const FX = join(import.meta.dirname, 'fixtures');
const oldConfig = process.env.GA_CONFIG;
let zip: string;
let work: string;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'ga-jobs-fx-'));
  zip = await appleZip(work, 10);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
const stores: TempStore[] = [];
afterEach(async () => {
  process.env.GA_CONFIG = oldConfig;
  for (const s of stores.splice(0)) await s.close();
});

// A temp store with a patient and a config the worker (or a CLI child) finds through GA_CONFIG; gateway dir next to it.
async function store() {
  const s = await tempStore();
  stores.push(s);
  const pid = (await s.client.createResource({ resourceType: 'Patient' })).id as string;
  const config = join(s.dir, 'config.json');
  writeFileSync(config, JSON.stringify({ store: 'sqlite', storeUrl: s.base, patientId: pid }), { mode: 0o600 });
  process.env.GA_CONFIG = config;
  return { s, client: s.client, pid, config, dir: join(s.dir, 'gateway') };
}
test('startJob records the job and the worker imports it to done', async () => {
  const a = await store();
  const job = startJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 });
  expect(statSync(join(a.dir, 'imports', job.id, 'job.json')).mode & 0o777).toBe(0o600);
  const done = await settled(a.dir, job.id);
  expect(done).toMatchObject({ status: 'done', attempts: 0, kind: 'apple' }); // reset by each committed batch
  expect(existsSync(join(a.dir, 'imports', job.id, 'root'))).toBe(false); // removed on success
  expect(existsSync(join(a.dir, 'imports', job.id, 'export.zip'))).toBe(false); // the zip went after the unzip
  // The same export imported directly into another store.
  const b = await store();
  const job2 = startJob(b.dir, upload(b.dir, zip), { patientId: b.pid, batchSize: 1_000_000 });
  const whole = await settled(b.dir, job2.id);
  expect(report(done.report)).toEqual(report(whole.report));
  expect((done.report as { created: number }).created).toBeGreaterThan(200);
  expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
}, 300_000);

test('resume after a crash inside batch 3 writes each record once and reports like an uninterrupted run', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 }); // recorded, not run here
  await crash(a.config, a.dir, job.id, 2);
  const mid = jobStatus(a.dir, job.id)!;
  expect(mid).toMatchObject({ status: 'running', lastBatch: 2, pending: { index: 3 } });
  expect(resumeJobs(a.dir)).toBe(1);
  const done = await settled(a.dir, job.id);
  expect(done.status).toBe('done');

  const b = await store();
  const whole = await settled(b.dir, startJob(b.dir, upload(b.dir, zip), { patientId: b.pid, batchSize: 50 }).id);
  expect(report(done.report)).toEqual(report(whole.report));
  expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
}, 300_000);

test('a worker that runs out of memory is retried and the gateway answers meanwhile; three in a row fail the job and keep root', async () => {
  const a = await store();
  const server = createGateway({
    dir: a.dir, tools: () => new McpServer({ name: 'f', version: '0' }), completeLogin: async () => ({}),
    share: { dir: join(a.dir, 'share'), load: async () => { throw new Error('unused'); }, log: async () => {}, fetchBinary: async () => { throw new Error('unused'); } },
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const job = startJob(a.dir, upload(a.dir, zip), { patientId: a.pid, run: inWorker({ maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 1 }) });
    let answered = 0;
    while (jobStatus(a.dir, job.id)!.status === 'running') {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/s/nothing`);
      expect(r.status).toBeLessThan(500);
      answered++;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    const j = jobStatus(a.dir, job.id)!;
    expect(j).toMatchObject({ status: 'failed', attempts: 3 });
    expect(j.message).toMatch(/memory/i);
    expect(answered).toBeGreaterThan(0);
  } finally { server.close(); }
}, 120_000);

test('three failed attempts mark the job failed with the last error and keep root', async () => {
  const a = await store();
  writeFileSync(a.config, JSON.stringify({ store: 'sqlite', storeUrl: 'http://127.0.0.1:9/', patientId: a.pid })); // the store is down: every attempt fails after the unzip
  const job = startJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  const j = await settled(a.dir, job.id);
  expect(j).toMatchObject({ status: 'failed', attempts: 3, message: expect.stringContaining('GA is not running') });
  expect(existsSync(j.root!)).toBe(true);
});

test('a job that made progress gets three fresh attempts after it', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 });
  const path = join(a.dir, 'imports', job.id, 'job.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), attempts: 2 })); // two attempts already failed
  await crash(a.config, a.dir, job.id, 2);
  expect(jobStatus(a.dir, job.id)!.attempts).toBe(0); // batches 0-2 committed: the count starts again
  expect(resumeJobs(a.dir)).toBe(1);
  expect((await settled(a.dir, job.id)).status).toBe('done');
}, 300_000);

test('import_status reports a job across a gateway restart', async () => {
  const a = await store();
  const job = startJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 });
  await settled(a.dir, job.id);
  // A new gateway instance: a fresh tool server on the same directory.
  const server = new McpServer({ name: 't', version: '0' });
  registerImportTools(server, { client: {} as MedplumClient, cfg: {} as never, patientId: a.pid, remote: { publicUrl: 'https://x', clientName: 'c', dir: a.dir, log: async () => {} } });
  const [x, y] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(x), c.connect(y)]);
  const r = (await c.callTool({ name: 'import_status', arguments: { jobId: job.id } })) as { content: { text: string }[] };
  const s = JSON.parse(r.content[0].text);
  expect(s).toMatchObject({ jobId: job.id, status: 'done', report: { created: expect.any(Number) } });
  expect(JSON.stringify(s)).not.toContain(a.dir); // no paths
  const all = (await c.callTool({ name: 'import_status', arguments: {} })) as { content: { text: string }[] };
  expect(JSON.parse(all.content[0].text).jobs).toContainEqual(expect.objectContaining({ jobId: job.id, status: 'done' }));
  expect(jobStatus(a.dir, '../../x')).toBeUndefined();
}, 120_000);

test('an EHI export and a C-CDA zip run as jobs and resume to the same records', async () => {
  for (const [src, tz, creates] of [[join(FX, 'ehi'), 'America/New_York', 10], [join(FX, 'zips', 'ccda.zip'), undefined, 3]] as const) {
    const a = await store();
    const job = recordJob(a.dir, upload(a.dir, src), { patientId: a.pid, tz });
    await crash(a.config, a.dir, job.id, -1, creates);
    expect(resumeJobs(a.dir)).toBe(1);
    const done = await settled(a.dir, job.id);
    expect(done.status, done.message).toBe('done');
    const b = await store();
    const whole = await settled(b.dir, startJob(b.dir, upload(b.dir, src), { patientId: b.pid, tz }).id);
    expect(whole.status, whole.message).toBe('done');
    // shortcut: one batch, so a kill mid-write is redone whole and its counts are not exact; the records are.
    expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
  }
}, 300_000);

test('runJob in the calling thread (ga import-job) imports a recorded job', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 });
  await runJob(a.dir, job.id);
  expect(jobStatus(a.dir, job.id)).toMatchObject({ status: 'done', lastBatch: expect.any(Number) });
}, 120_000);
