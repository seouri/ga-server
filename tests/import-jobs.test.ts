// import_file jobs: a worker thread per attempt, a checkpoint per batch, resume after a crash or restart (temp SQLite stores).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { archiveFolder, manifestHash } from '../src/archive.ts';
import { createGateway } from '../src/gateway/server.ts';
import { unzipSafe } from '../src/gateway/uploads.ts';
import { GaError } from '../src/config.ts';
import { inWorker, JOB_BUSY, type JobRecord, jobStatus, listJobs, recordJob, resumeJobs, runJob, startJob } from '../src/import-jobs.ts';
import { IMPORT_BUSY, takeLock } from '../src/lock.ts';
import { registerImportTools } from '../src/tools/imports.ts';
import { writeEhiExport } from './fixtures-gen/ehi.ts';
import { appleZip, crash, report, settled, snapshot, upload } from './import-jobs-helpers.ts';
import { type TempStore, tempStore } from './temp-store.ts';

const FX = join(import.meta.dirname, 'fixtures');
const oldConfig = process.env.GA_CONFIG;
let zip: string;
let ehi: string;
let ehiDup: string;
let work: string;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'ga-jobs-fx-'));
  zip = await appleZip(work, 10);
  ehi = join(work, 'ehi');
  await writeEhiExport(ehi, 6, { noteKB: 3, plainKB: 2, messageKB: 2 });
  // The same with an IMM_ADMIN dose of another name and lot on an IMMUNE dose's date: a possible duplicate of it (R18).
  ehiDup = join(work, 'ehi-dup');
  cpSync(ehi, ehiDup, { recursive: true });
  const tsv = join(ehiDup, 'EHITables', 'IMM_ADMIN.tsv');
  const [head, row] = readFileSync(tsv, 'utf8').split('\r\n');
  const cols = head.split('\t');
  const dup = row.split('\t').map((v, i) => ({ IMM_TYPE_ID_NAME: '', IMM_TYPE_FREE_TEXT: 'Other name', IMM_DATE: '1/15/2026 12:00:00 AM', IMM_LOT_NUMBER: 'LOT2' })[cols[i]] ?? v);
  writeFileSync(tsv, `${readFileSync(tsv, 'utf8')}${dup.join('\t')}\r\n`);
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
  expect(existsSync(join(a.dir, 'imports', job.id, 'upload.zip'))).toBe(false); // the zip went after the unzip
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
  await crash(a.config, a.dir, job.id, { at: 2, creates: 1 });
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

// The same check as above for a crash at other points of a batch: each resumed job equals an uninterrupted run.
async function resumesExactly(kill: Parameters<typeof crash>[3], check: (mid: JobRecord) => void) {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 });
  await crash(a.config, a.dir, job.id, kill);
  check(jobStatus(a.dir, job.id)!);
  expect(resumeJobs(a.dir)).toBe(1);
  const done = await settled(a.dir, job.id);
  expect(done.status, done.message).toBe('done');
  const b = await store();
  const whole = await settled(b.dir, startJob(b.dir, upload(b.dir, zip), { patientId: b.pid, batchSize: 50 }).id);
  expect(report(done.report)).toEqual(report(whole.report));
  expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
}

test('a crash right after the batch writes the allergy reports like an uninterrupted run', () =>
  resumesExactly({ type: 'AllergyIntolerance' }, (mid) => expect(mid.pending?.created.some((i) => i.startsWith('urn:ga-server:id:apple-health|'))).toBe(true)), 300_000);

test('a crash after batch 3 is fully written but before its checkpoint reports like an uninterrupted run', () =>
  resumesExactly({ at: 2, unlock: true }, (mid) => expect(mid).toMatchObject({ lastBatch: 2, pending: { index: 3 } })), 300_000);

test('a job waiting for the import lock keeps running without spending attempts', async () => {
  const a = await store();
  let calls = 0;
  const run = async (d: string, id: string) => {
    if (++calls <= 4) throw new GaError(IMPORT_BUSY);
    await runJob(d, id);
  };
  const job = startJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50, run, busyRetryMs: 50 });
  await new Promise((r) => setTimeout(r, 20));
  expect(jobStatus(a.dir, job.id)).toMatchObject({ status: 'running', message: expect.stringContaining('import lock') });
  const done = await settled(a.dir, job.id);
  expect(done.status, done.message).toBe('done');
  expect(calls).toBe(5);
}, 120_000);

test('a busy lock after a committed batch leaves attempts at 0', async () => {
  const a = await store();
  const run = async (d: string, id: string) => {
    const path = join(d, 'imports', id, 'job.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), lastBatch: 0, attempts: 0 })); // a batch committed
    throw new GaError(IMPORT_BUSY);
  };
  const job = startJob(a.dir, upload(a.dir, zip), { patientId: a.pid, run, busyRetryMs: 60_000 });
  await new Promise((r) => setTimeout(r, 50));
  expect(jobStatus(a.dir, job.id)).toMatchObject({ status: 'running', attempts: 0, message: expect.stringContaining('import lock') });
});

test('a worker that runs out of memory is retried and the gateway answers meanwhile; three in a row fail the job and free its disk', async () => {
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
    expect(j.message).toBe("too large to import within this server's import memory (8 MB); import it with `ga import` on a computer with more memory");
    expect(answered).toBeGreaterThan(0);
    expect(readdirSync(join(a.dir, 'imports', job.id))).toEqual(['job.json']); // failed: nothing resumes it
  } finally { server.close(); }
}, 120_000);

test('three failed attempts mark the job failed with the last error and remove its upload and unzipped export', async () => {
  const a = await store();
  writeFileSync(a.config, JSON.stringify({ store: 'sqlite', storeUrl: 'http://127.0.0.1:9/', patientId: a.pid })); // the store is down: every attempt fails after the unzip
  const job = startJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  const j = await settled(a.dir, job.id);
  expect(j).toMatchObject({ status: 'failed', attempts: 3, message: expect.stringContaining('GA is not running') });
  expect(existsSync(j.root!)).toBe(false);
  expect(readdirSync(join(a.dir, 'imports', job.id))).toEqual(['job.json']);
});

// A batch too big for the container: the kernel kills the whole gateway each time (no worker error, no message), the restarted
// gateway resumes it on the same batch. Attempts are counted before each start, so it ends failed, with the plain message.
test('a batch that kills the whole process every time ends failed after three restarts, with the out-of-memory message', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  const path = join(a.dir, 'imports', job.id, 'job.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), message: 'waiting for the import lock: another import or sync is running' })); // stale
  const host = `const { resumeJobs, jobStatus } = await import(${JSON.stringify(join(import.meta.dirname, '..', 'src', 'import-jobs.ts'))});
    resumeJobs(process.argv[1], { run: async () => process.kill(process.pid, 'SIGKILL') });
    for (;;) { if (jobStatus(process.argv[1], process.argv[2]).status !== 'running') process.exit(0); await new Promise((r) => setTimeout(r, 20)); }`;
  let kills = 0;
  for (let i = 0; i < 6 && jobStatus(a.dir, job.id)!.status === 'running'; i++) {
    const r = spawnSync('node', ['--input-type=module', '-e', host, a.dir, job.id], { env: { PATH: process.env.PATH!, GA_CONFIG: a.config } });
    if (r.signal === 'SIGKILL') kills++;
  }
  expect(kills).toBe(3);
  expect(jobStatus(a.dir, job.id)).toMatchObject({ status: 'failed', attempts: 3, message: expect.stringMatching(/^GA stopped during the last attempt, most likely out of memory: .*import it with `ga import` on a computer with more memory$/) });
}, 60_000);

// docker restart, a deploy, a reboot: SIGTERM mid-attempt. The attempt is given back, so restarts never fail a healthy job.
test('a gateway stopped with SIGTERM mid-attempt four times keeps its jobs running with the attempt given back', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  const queued = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid }); // waits behind the other
  const host = `const { exitOnStop, resumeJobs } = await import(${JSON.stringify(join(import.meta.dirname, '..', 'src', 'import-jobs.ts'))});
    exitOnStop(process.argv[1]);
    resumeJobs(process.argv[1], { run: () => { console.log('running'); return new Promise(() => {}); } });
    setInterval(() => {}, 1000);`;
  for (let i = 0; i < 4; i++) {
    const c = spawn('node', ['--input-type=module', '-e', host, a.dir, job.id], { env: { PATH: process.env.PATH!, GA_CONFIG: a.config } });
    c.stdout.on('data', (d) => { if (String(d).includes('running')) c.kill('SIGTERM'); });
    const [code, sig] = await new Promise<unknown[]>((ok) => c.on('close', (...x) => ok(x)));
    expect({ i, code, sig }).toEqual({ i, code: 0, sig: null });
    // import_status says why it is running again: the first start found no stop marker (a kill), the later ones a restart
    const note = expect.stringMatching(i ? /^GA restarted/ : /^GA stopped/);
    expect([jobStatus(a.dir, job.id), jobStatus(a.dir, queued.id)].map((j) => j!.attempts).sort()).toEqual([0, 1]);
    for (const j of [job, queued]) expect(jobStatus(a.dir, j.id)).toMatchObject({ status: 'running', note });
  }
}, 60_000);

test('a job that made progress gets three fresh attempts after it', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 });
  const path = join(a.dir, 'imports', job.id, 'job.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), attempts: 2 })); // two attempts already failed
  await crash(a.config, a.dir, job.id, { at: 2, creates: 1 });
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

test('a C-CDA zip runs as a job and resumes to the same records', async () => {
  const src = join(FX, 'zips', 'ccda.zip');
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, src), { patientId: a.pid });
  await crash(a.config, a.dir, job.id, { at: -1, creates: 3 });
  expect(resumeJobs(a.dir)).toBe(1);
  const done = await settled(a.dir, job.id);
  expect(done.status, done.message).toBe('done');
  const b = await store();
  const whole = await settled(b.dir, startJob(b.dir, upload(b.dir, src), { patientId: b.pid }).id);
  expect(whole.status, whole.message).toBe('done');
  // shortcut: one batch, so a kill mid-write is redone whole and its counts are not exact; the records are.
  expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
}, 300_000);

test('a C-CDA folder is a batch per document: a crash in the second resumes from it', async () => {
  const src = join(work, 'ccda-two');
  mkdirSync(src);
  for (const f of ['ccda-synthetic.xml', 'ccda-epic-style.xml']) cpSync(join(FX, f), join(src, f));
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, src), { patientId: a.pid });
  await crash(a.config, a.dir, job.id, { at: 0, creates: 2 });
  expect(jobStatus(a.dir, job.id)).toMatchObject({ lastBatch: 0 }); // the first document committed
  expect(resumeJobs(a.dir)).toBe(1);
  const done = await settled(a.dir, job.id);
  expect(done.status, done.message).toBe('done');
  const b = await store();
  const whole = await settled(b.dir, startJob(b.dir, upload(b.dir, src), { patientId: b.pid }).id);
  expect(whole.status, whole.message).toBe('done');
  expect((done.report as { notImported: unknown }).notImported).toEqual((whole.report as { notImported: unknown }).notImported);
  expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
}, 300_000);

// A sync between attempts can give GA its first Epic records: the resumed job keeps the first attempt's org number (none), so its
// identifiers and batches stay those of the attempt it resumes.
test('an EHI job keeps its first attempt\'s Epic org number when the store gains one before the resume', async () => {
  const seed = (pid: string) => ({ resourceType: 'Condition' as const, subject: { reference: `Patient/${pid}` }, code: { text: 'Seed' }, identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.768076', value: 'seed-1' }] });
  const opts = { tz: 'America/New_York', batchSize: 7 };
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, ehi), { patientId: a.pid, ...opts });
  await crash(a.config, a.dir, job.id, { at: 2, creates: 3 });
  expect(jobStatus(a.dir, job.id)).toMatchObject({ epicOrg: null, learned: expect.any(Object) });
  await a.client.createResource(seed(a.pid));
  expect(resumeJobs(a.dir)).toBe(1);
  const done = await settled(a.dir, job.id);
  expect(done.status, done.message).toBe('done');
  const b = await store();
  const whole = await settled(b.dir, startJob(b.dir, upload(b.dir, ehi), { patientId: b.pid, ...opts }).id);
  await b.client.createResource(seed(b.pid));
  expect(report(done.report)).toEqual(report(whole.report));
  expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
}, 300_000);

// An EHI export resumed after a crash at each kind of point (records, a note batch after its Rich Text files, a message thread, a
// media file, a batch written but not checkpointed) gives the records and the report of an uninterrupted job.
test.each([
  ['the fixture, mid-records', 'fixture', { at: -1, creates: 10 }],
  ['mid-records batch', 'synthetic', { at: 2, creates: 3 }],
  ['a note batch, after its Rich Text files', 'synthetic', { type: 'DocumentReference' }],
  ['mid-thread', 'synthetic', { type: 'Communication' }],
  ['a media file', 'synthetic', { file: 'scan.pdf' }],
  ['after a batch, before its checkpoint', 'synthetic', { at: 2, unlock: true }],
  ['before a note batch stores its (identical) Rich Text files', 'synthetic', { pendingFiles: true }],
  ['between a dose and its IMM_ADMIN possible duplicate', 'duplicate', { type: 'Immunization' }],
] as const)('EHI job: a crash %s resumes exactly', async (_, which, kill) => {
  const src = which === 'fixture' ? join(FX, 'ehi') : which === 'duplicate' ? ehiDup : ehi;
  const batchSize = which === 'fixture' ? undefined : 7;
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, src), { patientId: a.pid, tz: 'America/New_York', batchSize });
  await crash(a.config, a.dir, job.id, kill);
  expect(jobStatus(a.dir, job.id)!.pending).toBeDefined(); // killed inside a batch
  expect(resumeJobs(a.dir)).toBe(1);
  const done = await settled(a.dir, job.id);
  expect(done.status, done.message).toBe('done');
  const b = await store();
  const whole = await settled(b.dir, startJob(b.dir, upload(b.dir, src), { patientId: b.pid, tz: 'America/New_York', batchSize }).id);
  expect(whole.status, whole.message).toBe('done');
  if (which === 'duplicate') expect(whole.report).toMatchObject({ skips: { immAdminPossibleDuplicate: 1 } });
  expect(report(done.report)).toEqual(report(whole.report));
  expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
}, 300_000);

// A kill or restart skips archiveFolder's cleanup; each retry must not add another tarball the size of the export.
test('an archive step cut short leaves no second tarball: the retry reuses its folder', async () => {
  const a = await store();
  const src = join(work, 'apple_health_export');
  const stale = join(a.s.dir, 'tmp', `archive-${await manifestHash(src)}`);
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'apple_health_export.tar.gz'), 'cut short');
  expect(await archiveFolder(a.client, src, a.pid, 'urn:ga-server:id:apple-health-archive')).toBe('stored');
  expect(readdirSync(join(a.s.dir, 'tmp'))).toEqual([]);
});

// save() renames without fsync: a power loss can leave an empty job.json. The gateway must still start.
test('an empty job.json is skipped: the other jobs resume and the list leaves it out', async () => {
  const a = await store();
  const bad = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  writeFileSync(join(a.dir, 'imports', bad.id, 'job.json'), '');
  const good = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  expect(jobStatus(a.dir, bad.id)).toBeUndefined();
  expect(listJobs(a.dir).map((j) => j.id)).toEqual([good.id]);
  expect(resumeJobs(a.dir, { run: async () => {}, busyRetryMs: 60_000 })).toBe(1);
});

test('runJob in the calling thread (ga import-job) imports a recorded job', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid, batchSize: 50 });
  await runJob(a.dir, job.id);
  expect(jobStatus(a.dir, job.id)).toMatchObject({ status: 'done', lastBatch: expect.any(Number) });
}, 120_000);

test('ga import-job refuses a job another process is running, and the gateway waits for it without spending attempts', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  const lock = (await takeLock(join(a.dir, 'imports', job.id, 'import.lock'), 0))!; // held by a running attempt
  await expect(runJob(a.dir, job.id)).rejects.toThrow(JOB_BUSY);
  expect(jobStatus(a.dir, job.id)).toMatchObject({ status: 'running', lastBatch: -1 });
  resumeJobs(a.dir, { run: inWorker(), busyRetryMs: 60_000 });
  for (let i = 0; i < 100 && !jobStatus(a.dir, job.id)!.message; i++) await new Promise((r) => setTimeout(r, 100));
  expect(jobStatus(a.dir, job.id)).toMatchObject({ status: 'running', attempts: 0, message: JOB_BUSY });
  rmSync(lock);
}, 30_000);

test('a crash between the unzip and the zip delete: the next attempt deletes the zip', async () => {
  const a = await store();
  const job = recordJob(a.dir, upload(a.dir, zip), { patientId: a.pid });
  const path = join(a.dir, 'imports', job.id, 'job.json');
  const root = await unzipSafe(job.upload, join(a.dir, 'imports', job.id, 'root'));
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), root }));
  expect(job.upload).toBe(join(a.dir, 'imports', job.id, 'upload.zip')); // a fixed name: never job.json or root
  await runJob(a.dir, job.id, { importAny: async () => ({}), client: {} as MedplumClient, cfg: { patientId: a.pid } as never });
  expect(existsSync(job.upload)).toBe(false);
});
