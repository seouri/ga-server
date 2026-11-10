// An import_file job killed inside batch 3 resumes on Medplum to an uninterrupted run's records and report, in the ga-test project.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { defaultConfigPath, getClient } from '../../src/config.ts';
import { recordJob, resumeJobs, startJob } from '../../src/import-jobs.ts';
import { appleZip, crash, report, settled, snapshot, upload } from '../import-jobs-helpers.ts';
import { SQLITE, emptyTestProject, restoreConfig, testProject } from './helpers.ts';

let work: string;
let zip: string;
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'ga-jobs-int-'));
  zip = await appleZip(work, 10);
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  restoreConfig();
});

test.skipIf(SQLITE)('a job killed inside batch 3 resumes on Medplum like an uninterrupted run', { timeout: 900_000 }, async () => {
  const { cfg, dir } = await testProject(); // GA_CONFIG now points at the ga-test project's config, which workers inherit
  const client = await getClient(cfg);
  const pid = cfg.patientId as string;
  const gw = join(dir, 'gateway');
  try {
    await emptyTestProject(client);
    const job = recordJob(gw, upload(gw, zip), { patientId: pid, batchSize: 50 });
    await crash(defaultConfigPath(), gw, job.id, { at: 2, creates: 1 });
    expect(resumeJobs(gw)).toBe(1);
    const done = await settled(gw, job.id, 600_000);
    expect(done.status, done.message).toBe('done');
    const resumed = await snapshot(client, pid);

    await emptyTestProject(client);
    const whole = await settled(gw, startJob(gw, upload(gw, zip), { patientId: pid, batchSize: 50 }).id, 600_000);
    expect(whole.status, whole.message).toBe('done');
    expect(report(done.report)).toEqual(report(whole.report));
    expect(resumed).toEqual(await snapshot(client, pid));
  } finally { await emptyTestProject(client); }
});
