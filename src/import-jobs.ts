// import_file jobs. A record per job at <gateway dir>/imports/<id>/job.json; jobs run one at a time, each attempt in a worker
// thread with a capped heap (an out-of-memory import ends the worker, never the gateway). The worker saves a checkpoint after
// each committed batch, so a retry or a gateway restart (resumeJobs) carries on from there with the same report.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMainThread, type ResourceLimits, Worker, workerData } from 'node:worker_threads';
import type { MedplumClient } from '@medplum/core';
import { BATCH, type Pending } from './apple/import.ts';
import { type GaConfig, getClient, loadConfig } from './config.ts';
import { addReport, type ImportReport } from './engine.ts';
import { detectKind, importAny, type ImportKind } from './import.ts';
import { IMPORT_WORKER_HEAP_MB, IMPORT_WORKER_YOUNG_MB } from './limits.ts';
import { freeThreadLock } from './lock.ts';
import { unzipSafe } from './gateway/uploads.ts';

type Report = ImportReport & { unchanged?: number };
export type JobRecord = {
  id: string;
  kind?: ImportKind; // known once unzipped
  upload: string;
  root?: string;
  tz?: string; // an EHI export's zone, as import_file got it
  timeZone: string; // where Apple Health days are cut: this machine's zone at the start, so every attempt cuts the same batches
  batchSize: number;
  patientId?: string;
  status: 'running' | 'done' | 'failed';
  started: string;
  lastBatch: number; // the last committed batch; report sums batches 0..lastBatch
  report?: unknown;
  pending?: Pending;
  archived?: string; // the first attempt's archive outcome (a retry finds the archive already present)
  message?: string;
  attempts: number; // attempts since the last committed batch
};
export type Run = (dir: string, id: string) => Promise<void>;

const MAX_ATTEMPTS = 3;
const ID = /^[A-Za-z0-9_-]{12}$/;
const jobDir = (dir: string, id: string): string => join(dir, 'imports', id);

export function jobStatus(dir: string, id: string): JobRecord | undefined {
  const f = join(jobDir(dir, id), 'job.json');
  return ID.test(id) && existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as JobRecord) : undefined;
}
export const listJobs = (dir: string): JobRecord[] =>
  existsSync(join(dir, 'imports')) ? readdirSync(join(dir, 'imports')).flatMap((id) => jobStatus(dir, id) ?? []) : [];

// 0600, written whole then renamed over the old one: a crash never leaves half a record.
function save(dir: string, j: JobRecord): JobRecord {
  const f = join(jobDir(dir, j.id), 'job.json');
  writeFileSync(`${f}.tmp`, JSON.stringify(j), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
  return j;
}

// Writes the record and moves the upload into the job's folder (out of reach of the 24-hour upload sweep). Not started.
export function recordJob(dir: string, upload: string, opts: { tz?: string; patientId?: string; batchSize?: number } = {}): JobRecord {
  const id = randomBytes(9).toString('base64url');
  mkdirSync(jobDir(dir, id), { recursive: true, mode: 0o700 });
  const moved = join(jobDir(dir, id), basename(upload));
  renameSync(upload, moved);
  return save(dir, {
    id, upload: moved, tz: opts.tz, patientId: opts.patientId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    batchSize: opts.batchSize ?? BATCH, status: 'running', started: new Date().toISOString(), lastBatch: -1, attempts: 0,
  });
}

export function startJob(dir: string, upload: string, opts: { tz?: string; patientId?: string; batchSize?: number; run?: Run } = {}): JobRecord {
  const j = recordJob(dir, upload, opts);
  supervise(dir, j.id, opts.run ?? inWorker());
  return j;
}

// At gateway start: every job still running gets its attempts again. Returns how many.
export function resumeJobs(dir: string, run: Run = inWorker()): number {
  const running = listJobs(dir).filter((j) => j.status === 'running');
  for (const j of running) supervise(dir, j.id, run);
  return running.length;
}

// One job at a time; each attempt is counted before it starts, so a gateway crash mid-attempt counts too.
let queue = Promise.resolve();
function supervise(dir: string, id: string, run: Run): void {
  queue = queue.then(async () => {
    for (;;) {
      const j = jobStatus(dir, id);
      if (j?.status !== 'running') return;
      if (j.attempts >= MAX_ATTEMPTS) return void save(dir, { ...j, status: 'failed', message: j.message ?? `stopped ${MAX_ATTEMPTS} times in a row` });
      save(dir, { ...j, attempts: j.attempts + 1 });
      try {
        await run(dir, id);
      } catch (e) {
        save(dir, { ...jobStatus(dir, id)!, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }).catch(() => {}); // a broken record must not stop the queue
}

export const WORKER_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: IMPORT_WORKER_HEAP_MB, maxYoungGenerationSizeMb: IMPORT_WORKER_YOUNG_MB };
// One attempt in a worker thread (this file again, below); it inherits the gateway's environment (GA_CONFIG).
export const inWorker = (resourceLimits = WORKER_LIMITS): Run => (dir, id) =>
  new Promise((ok, no) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { importJob: { dir, id } }, resourceLimits, execArgv: [] });
    const thread = w.threadId;
    let error: Error | undefined;
    w.on('error', (e) => (error = e as Error));
    w.on('exit', (code) => {
      freeThreadLock(thread);
      if (error || code) no(error ?? new Error(`the import stopped (exit ${code})`));
      else ok();
    });
  });

// The attempt itself (a worker, or `ga import-job <id>`): unzip once, import from after the last committed batch, finish.
export async function runJob(dir: string, id: string, deps: { importAny?: typeof importAny; client?: MedplumClient; cfg?: GaConfig } = {}): Promise<void> {
  let j = jobStatus(dir, id);
  if (!j) throw new Error(`no import job ${id}`);
  const into = join(jobDir(dir, id), 'root');
  if (!j.root) {
    rmSync(into, { recursive: true, force: true }); // a crash mid-unzip
    const zip = /\.zip$/i.test(j.upload);
    j = save(dir, { ...j, root: zip ? await unzipSafe(j.upload, into) : j.upload });
    if (zip) rmSync(j.upload, { force: true });
  }
  j = save(dir, { ...j, kind: detectKind(j.root!) });
  const cfg = deps.cfg ?? loadConfig();
  const client = deps.client ?? (await getClient(cfg));
  const result = await (deps.importAny ?? importAny)(client, { ...cfg, patientId: j.patientId ?? cfg.patientId }, j.root!, {
    tz: j.tz, timeZone: j.timeZone, batchSize: j.batchSize, skipThrough: j.lastBatch, redo: j.pending,
    beforeWrite: (pending) => { j = save(dir, { ...j!, pending }); },
    onArchived: (archived) => { j = save(dir, { archived, ...j! }); }, // an earlier attempt's outcome wins
    onBatch: (index, r) => { j = save(dir, { ...j!, lastBatch: index, report: sum(j!.report as Report | undefined, r), pending: undefined, attempts: 0 }); },
  });
  // The counts are the checkpoint's (every batch once); the rest (skips, seconds) is this attempt's.
  const report = j.report ? { ...(result as object), ...(j.report as object), ...(j.archived && { archived: j.archived }) } : result;
  save(dir, { ...j, status: 'done', report, pending: undefined, message: undefined });
  for (const p of [into, j.upload]) rmSync(p, { recursive: true, force: true });
}

function sum(total: Report | undefined, r: Report): Report {
  if (!total) return structuredClone(r);
  addReport(total, r);
  if (r.unchanged !== undefined) total.unchanged = (total.unchanged ?? 0) + r.unchanged;
  return total;
}

if (!isMainThread && workerData?.importJob) {
  const { dir, id } = workerData.importJob as { dir: string; id: string };
  await runJob(dir, id);
  process.exit(0); // ends this thread only; open sockets would otherwise keep it alive
}
