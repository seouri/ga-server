// Preload for tests/import-jobs.test.ts: SIGKILL this process (a gateway crash) at a chosen point of an import job.
// GA_TEST_KILL_AT: only while the job's lastBatch is this. Then GA_TEST_KILL_CREATES: right after that many creates; or
// GA_TEST_KILL_TYPE: right after creating that resource type; or GA_TEST_KILL_FILE: right after storing the file of that name;
// or GA_TEST_KILL_UNLOCK: right after the import lock is released (a batch fully written, its checkpoint not yet saved); or
// GA_TEST_KILL_PENDING_FILES: right after a checkpoint lists files a batch is about to store (before the first is stored).
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { MedplumClient } from '@medplum/core';

const env = process.env;
const armed = () => env.GA_TEST_KILL_AT === undefined || (JSON.parse(readFileSync(env.GA_TEST_JOB!, 'utf8')) as { lastBatch: number }).lastBatch === Number(env.GA_TEST_KILL_AT);
const die = () => process.kill(process.pid, 'SIGKILL');

const create = MedplumClient.prototype.createResource;
let n = 0;
MedplumClient.prototype.createResource = async function (this: MedplumClient, ...args: Parameters<typeof create>) {
  const r = await create.apply(this, args);
  if (env.GA_TEST_KILL_TYPE ? args[0].resourceType === env.GA_TEST_KILL_TYPE : env.GA_TEST_KILL_CREATES && armed() && ++n >= Number(env.GA_TEST_KILL_CREATES)) die();
  return r;
} as typeof create;

const once = MedplumClient.prototype.createResourceIfNoneExist;
MedplumClient.prototype.createResourceIfNoneExist = async function (this: MedplumClient, ...args: Parameters<typeof once>) {
  const r = await once.apply(this, args);
  if (env.GA_TEST_KILL_FILE && (args[0] as { content?: { attachment?: { title?: string } }[] }).content?.[0]?.attachment?.title === env.GA_TEST_KILL_FILE) die();
  return r;
} as typeof once;

if (env.GA_TEST_KILL_PENDING_FILES) {
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to);
    if (String(to) === env.GA_TEST_JOB && (JSON.parse(readFileSync(String(to), 'utf8')) as { pending?: { files?: string[] } }).pending?.files?.length) die();
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
}

if (env.GA_TEST_KILL_UNLOCK) {
  const rm = fs.rmSync;
  fs.rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => {
    const kill = String(p).endsWith('import.lock') && armed();
    rm(p, o);
    if (kill) die();
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
}
