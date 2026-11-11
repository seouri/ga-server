// Medplum mode: the whole integration run uses the long-lived ga-test project, never the live one. Runs once in the main
// process before the workers start, so the GA_CONFIG set here (a temp copy of the ga-test project's GA config) is what every
// file's loadConfig() reads. The live config (GA_CONFIG at start, else the checkout's .ga/config.json) is only read, for
// baseUrl, the admin password and the live patient id; nothing logs in to the live project. The test project is emptied before and after the run.
// GA_STORE=sqlite: nothing to do here; store-setup.ts gives each file its own temp store.
// The GA work runs in a child node (Node runs the sources directly): vitest's global-setup runner lacks import.meta.resolve.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = (f: string) => JSON.stringify(new URL(f, import.meta.url).href);
const child = (code: string, env: NodeJS.ProcessEnv): void => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`integration global setup: child exited ${r.status ?? r.signal}`);
};
// setup() writes the ga-test project's GA config to GA_CONFIG (the temp file); then the guard, and the project is emptied.
const SETUP = `const { getClient, loadConfig } = await import(${url('../../src/config.ts')});
  const { setup } = await import(${url('../../src/setup.ts')});
  const { assertTestProject, emptyTestProject, retryLimited } = await import(${url('./helpers.ts')});
  const { baseUrl } = loadConfig();
  const cfg = await retryLimited(() => setup(baseUrl, { projectName: 'ga-test', out: process.env.GA_CONFIG }));
  const client = await getClient(cfg);
  await assertTestProject(client);
  await emptyTestProject(client); // what a run that stopped half-way left`;
const EMPTY = `const { getClient, loadConfig } = await import(${url('../../src/config.ts')});
  const { emptyTestProject } = await import(${url('./helpers.ts')});
  await emptyTestProject(await getClient(loadConfig()));`;

export default function globalSetup(): (() => void) | undefined {
  if (process.env.GA_STORE === 'sqlite') return undefined;
  const livePath = process.env.GA_CONFIG || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.ga', 'config.json');
  const live = JSON.parse(readFileSync(livePath, 'utf8')) as { baseUrl?: string; adminPassword?: string; patientId?: string; store?: string };
  if (live.store === 'sqlite') return undefined;
  // Without the stored password ga setup would try the seeded default and rotate the admin password away from the live config.
  if (!live.baseUrl || !live.adminPassword) throw new Error(`integration tests need baseUrl and adminPassword in ${livePath} to make the ga-test project`);
  const dir = mkdtempSync(join(tmpdir(), 'ga-int-run-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ baseUrl: live.baseUrl, adminPassword: live.adminPassword }), { mode: 0o600 });
  process.env.GA_INT_LIVE_PATIENT_ID = live.patientId ?? ''; // stack.test.ts: another project's record must be invisible
  process.env.GA_CONFIG = process.env.GA_INT_RUN_CONFIG = path;
  try {
    child(SETUP, process.env);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return () => {
    try {
      child(EMPTY, { ...process.env, GA_CONFIG: path });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
