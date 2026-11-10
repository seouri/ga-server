// Preload for tests/import-jobs.test.ts: SIGKILL this process (a gateway crash) at a chosen point of an import job.
// GA_TEST_KILL_AT: only while the job's lastBatch is this. Then GA_TEST_KILL_CREATES: right after that many creates; or
// GA_TEST_KILL_TYPE: right after creating that resource type; or GA_TEST_KILL_UNLOCK: right after the import lock is released
// (a batch fully written, its checkpoint not yet saved).
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

if (env.GA_TEST_KILL_UNLOCK) {
  const rm = fs.rmSync;
  fs.rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => {
    const kill = String(p).endsWith('import.lock') && armed();
    rm(p, o);
    if (kill) die();
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
}
