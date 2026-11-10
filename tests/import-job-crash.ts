// Preload for tests/import-jobs.test.ts: SIGKILL this process (a gateway crash) right after the GA_TEST_KILL_CREATES-th
// create made while the job's lastBatch is GA_TEST_KILL_AT.
import { readFileSync } from 'node:fs';
import { MedplumClient } from '@medplum/core';

const create = MedplumClient.prototype.createResource;
let n = 0;
MedplumClient.prototype.createResource = async function (this: MedplumClient, ...args: Parameters<typeof create>) {
  const r = await create.apply(this, args);
  const job = JSON.parse(readFileSync(process.env.GA_TEST_JOB!, 'utf8')) as { lastBatch: number };
  if (job.lastBatch === Number(process.env.GA_TEST_KILL_AT) && ++n >= Number(process.env.GA_TEST_KILL_CREATES)) process.kill(process.pid, 'SIGKILL');
  return r;
} as typeof create;
