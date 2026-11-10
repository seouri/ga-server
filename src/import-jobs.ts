// import_file jobs. A record per job at <gateway dir>/imports/<id>/job.json; jobs run one at a time, each attempt in a worker
// thread with a capped heap (an out-of-memory import ends the worker, never the gateway). The worker saves a checkpoint after
// each committed batch, so a retry or a gateway restart (resumeJobs) carries on from there with the same report.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { isMainThread, type ResourceLimits, Worker, workerData } from 'node:worker_threads';
import type { MedplumClient } from '@medplum/core';
import { BATCH_SIZE, type Pending } from './batches.ts';
import { addNotImported } from './ccda.ts';
import type { MapEntry } from './conceptmap.ts';
import { GaError, type GaConfig, getClient, loadConfig } from './config.ts';
import { addReport, type ImportReport } from './engine.ts';
import { detectKind, importAny, type ImportKind } from './import.ts';
import { IMPORT_WORKER_HEAP_MB, IMPORT_WORKER_YOUNG_MB } from './limits.ts';
import { freeThreadLock, IMPORT_BUSY, takeLock } from './lock.ts';
import { unzipSafe } from './gateway/uploads.ts';

type Report = ImportReport & { unchanged?: number; skips?: Record<string, number> }; // skips: counted per batch (EHI)
export type JobRecord = {
  id: string;
  kind?: ImportKind; // known once unzipped
  upload: string;
  root?: string;
  tz?: string; // an EHI export's zone: import_file's, else GA_EHI_TZ, else this machine's (as ga import), fixed at the start
  timeZone: string; // where Apple Health days are cut: this machine's zone at the start, so every attempt cuts the same batches
  batchSize: number;
  patientId?: string;
  status: 'running' | 'done' | 'failed';
  started: string;
  lastBatch: number; // the last committed batch; report sums batches 0..lastBatch
  report?: unknown;
  pending?: Pending;
  archived?: string; // the first attempt's archive outcome (a retry finds the archive already present)
  epicOrg?: string | null; // EHI: the first attempt's Epic org number (null: none), which shapes its batches
  learned?: Record<string, MapEntry[]>; // EHI: the concepts the first attempt learned from the whole export
  message?: string;
  note?: string; // why a resumed job is running again, until its next committed batch
  attempts: number; // attempts since the last committed batch
};
export type Run = (dir: string, id: string) => Promise<void>;

const MAX_ATTEMPTS = 3;
export const JOB_BUSY = 'this import job is already running (in ga-gateway or another `ga import-job`): try again later';
const ID = /^[A-Za-z0-9_-]{12}$/;
const jobDir = (dir: string, id: string): string => join(dir, 'imports', id);
const stopMark = (dir: string, id: string): string => join(jobDir(dir, id), 'stopped');

// An unreadable record (save renames without fsync, so a power loss can leave it empty) is skipped, never thrown: resumeJobs
// runs at every gateway start.
export function jobStatus(dir: string, id: string): JobRecord | undefined {
  const f = join(jobDir(dir, id), 'job.json');
  if (!ID.test(id) || !existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as JobRecord;
  } catch (e) {
    console.error(`import job ${id}: job.json unreadable, skipped (${(e as Error).message})`);
    return undefined;
  }
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

// Writes the record, then moves the upload into the job's folder under a fixed name (out of reach of the 24-hour upload
// sweep, never colliding with job.json or root). Not started.
export function recordJob(dir: string, upload: string, opts: { tz?: string; patientId?: string; batchSize?: number } = {}): JobRecord {
  const id = randomBytes(9).toString('base64url');
  mkdirSync(jobDir(dir, id), { recursive: true, mode: 0o700 });
  const j = save(dir, {
    id, upload: join(jobDir(dir, id), `upload${extname(upload)}`), tz: opts.tz || process.env.GA_EHI_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone, patientId: opts.patientId,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, batchSize: opts.batchSize ?? BATCH_SIZE, status: 'running', started: new Date().toISOString(), lastBatch: -1, attempts: 0,
  });
  renameSync(upload, j.upload);
  return j;
}

type Supervision = { run?: Run; busyRetryMs?: number };
export function startJob(dir: string, upload: string, opts: { tz?: string; patientId?: string; batchSize?: number } & Supervision = {}): JobRecord {
  const j = recordJob(dir, upload, opts);
  supervise(dir, j.id, opts);
  return j;
}

// At gateway start: every job still running gets its attempts again. Returns how many. An attempt that a stop (exitOnStop)
// ended is given back; one that a kill ended (out of memory, most likely) still counts.
export function resumeJobs(dir: string, opts: Supervision = {}): number {
  const running = listJobs(dir).filter((j) => j.status === 'running');
  for (const j of running) {
    const stopped = existsSync(stopMark(dir, j.id)), inAttempt = stopped && readFileSync(stopMark(dir, j.id), 'utf8') === 'attempt';
    save(dir, { ...j, attempts: inAttempt ? Math.max(0, j.attempts - 1) : j.attempts, note: stopped
      ? 'GA restarted during the import; it resumes from the last saved batch'
      : 'GA stopped during the import (most likely out of memory) and restarted; it resumes from the last saved batch' });
    rmSync(stopMark(dir, j.id), { force: true });
    supervise(dir, j.id, opts);
  }
  return running.length;
}

// The gateway's SIGTERM/SIGINT (docker restart, a deploy, a reboot): marks every running job as stopped, and the one whose
// attempt is in progress as such, for resumeJobs to give back. Files of their own, so they never race a checkpoint being saved.
let current: string | undefined;
export function exitOnStop(dir: string): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => {
    for (const j of listJobs(dir)) if (j.status === 'running') writeFileSync(stopMark(dir, j.id), j.id === current ? 'attempt' : '');
    process.exit(0);
  });
}

// One job at a time; each attempt is counted before it starts, so a gateway crash mid-attempt counts too. An attempt that
// found the import lock held (a long sync or CLI import, or a lock a dead container left until its 2-hour age) is not
// counted: the job waits busyRetryMs off the queue and tries again.
const BUSY_RETRY_MS = 5 * 60_000;
let queue = Promise.resolve();
function supervise(dir: string, id: string, opts: Supervision): void {
  const run = opts.run ?? inWorker();
  queue = queue.then(async () => {
    for (;;) {
      const j = jobStatus(dir, id);
      if (j?.status !== 'running') return;
      // No message: the last attempt ended with GA itself (a container killed out of memory, most likely), not with an error.
      if (j.attempts >= MAX_ATTEMPTS) {
        // Under the job lock: a `ga import-job` retrying it keeps its files (a killed attempt's lock is stale and taken over).
        const lock = await takeLock(join(jobDir(dir, id), 'import.lock'), 0);
        if (!lock) {
          save(dir, { ...j, note: JOB_BUSY }); // the message stays: it is what the failure will say
          return void setTimeout(() => supervise(dir, id, opts), opts.busyRetryMs ?? BUSY_RETRY_MS).unref();
        }
        // Nothing resumes a failed job: the export (up to 2 GB zipped, 8 GB unzipped) would only fill the disk and the nightly backup.
        // Removed first: a kill midway repeats this at the next start.
        for (const p of [join(jobDir(dir, id), 'root'), j.upload]) rmSync(p, { recursive: true, force: true });
        save(dir, { ...j, status: 'failed', note: undefined, message: j.message ?? `GA stopped during the last attempt, most likely out of memory: too large to import within this server's memory; import it with \`ga import\` on a computer with more memory` });
        return void rmSync(lock, { force: true });
      }
      save(dir, { ...j, attempts: j.attempts + 1, message: undefined }); // a failed attempt saves its own; an earlier one is stale
      current = id;
      try {
        await run(dir, id);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const now = jobStatus(dir, id)!;
        if (message !== IMPORT_BUSY && message !== JOB_BUSY) {
          save(dir, { ...now, message });
          continue;
        }
        save(dir, { ...now, attempts: Math.max(0, now.attempts - 1), message: message === JOB_BUSY ? JOB_BUSY : 'waiting for the import lock: another import or sync is running' });
        setTimeout(() => supervise(dir, id, opts), opts.busyRetryMs ?? BUSY_RETRY_MS).unref();
        return;
      } finally { current = undefined; }
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
    // Out of memory says what to do instead: retrying the same file on this server gets no further.
    w.on('error', (e) => (error = (e as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new Error(`too large to import within this server's import memory (${resourceLimits.maxOldGenerationSizeMb} MB); import it with \`ga import\` on a computer with more memory`)
      : (e as Error)));
    w.on('exit', (code) => {
      freeThreadLock(thread);
      freeThreadLock(thread, jobDir(dir, id));
      if (error || code) no(error ?? new Error(`the import stopped (exit ${code})`));
      else ok();
    });
  });

// The attempt itself (a worker, or `ga import-job <id>`): unzip once, import from after the last committed batch, finish.
export async function runJob(dir: string, id: string, deps: { importAny?: typeof importAny; client?: MedplumClient; cfg?: GaConfig } = {}): Promise<void> {
  let j = jobStatus(dir, id);
  if (!j) throw new Error(`no import job ${id}`);
  if (j.status !== 'running') return; // finished: nothing to redo
  // One attempt per job at a time: two would overwrite each other's checkpoint (and the first done would delete root under the other).
  const lock = await takeLock(join(jobDir(dir, id), 'import.lock'), 0);
  if (!lock) throw new GaError(JOB_BUSY);
  try {
    j = jobStatus(dir, id); // as saved by the attempt before ours, which may have ended since the read above
    if (j?.status !== 'running') return;
    const into = join(jobDir(dir, id), 'root');
    if (!j.root) {
      rmSync(into, { recursive: true, force: true }); // a crash mid-unzip
      j = save(dir, { ...j, root: /\.zip$/i.test(j.upload) ? await unzipSafe(j.upload, into) : j.upload });
    }
    if (/\.zip$/i.test(j.upload)) rmSync(j.upload, { force: true }); // unzipped: the folder is enough to resume
    j = save(dir, { ...j, kind: detectKind(j.root!) });
    const cfg = deps.cfg ?? loadConfig();
    const client = deps.client ?? (await getClient(cfg));
    const result = await (deps.importAny ?? importAny)(client, { ...cfg, patientId: j.patientId ?? cfg.patientId }, j.root!, {
      tz: j.tz, timeZone: j.timeZone, batchSize: j.batchSize, skipThrough: j.lastBatch, redo: j.pending,
      beforeWrite: (pending) => { j = save(dir, { ...j!, pending }); },
      // An earlier attempt's outcome wins. shortcut: a crash between the archive upload and this save reads 'already-present' on
      // the retry; derive it from the archive's own record if that matters.
      onArchived: (archived) => { j = save(dir, { archived, ...j! }); },
      epicOrg: j.epicOrg, onEpicOrg: (epicOrg) => { j = save(dir, { ...j!, epicOrg }); },
      learned: j.learned, onLearned: (learned) => { j = save(dir, { ...j!, learned }); },
      onBatch: (index, r) => { j = save(dir, { ...j!, lastBatch: index, report: sum(j!.report as Report | undefined, r), pending: undefined, attempts: 0, note: undefined }); },
    });
    // The counts are the checkpoint's (every batch once), and so are the skips counted per batch (EHI's linking passes); the rest
    // (other skips, seconds) is this attempt's.
    const r = result as { skips?: object }, c = j.report as Report | undefined;
    const report = c ? { ...r, ...c, ...((r.skips || c.skips) && { skips: { ...r.skips, ...c.skips } }), ...(j.archived && { archived: j.archived }) } : result;
    save(dir, { ...j, status: 'done', report, pending: undefined, message: undefined, note: undefined });
    for (const p of [into, j.upload]) rmSync(p, { recursive: true, force: true });
  } finally {
    rmSync(lock, { force: true });
  }
}

function sum(total: Report | undefined, r: Report): Report {
  if (!total) return structuredClone(r);
  addReport(total, r);
  if (r.unchanged !== undefined) total.unchanged = (total.unchanged ?? 0) + r.unchanged;
  for (const [k, v] of Object.entries(r.skips ?? {})) (total.skips ??= {})[k] = (total.skips[k] ?? 0) + v;
  if (r.notImported) addNotImported((total.notImported ??= []), r.notImported);
  return total;
}

if (!isMainThread && workerData?.importJob) {
  const { dir, id } = workerData.importJob as { dir: string; id: string };
  await runJob(dir, id);
  process.exit(0); // ends this thread only; open sockets would otherwise keep it alive
}
