// Medplum mode: the whole integration run uses the long-lived ga-test project, never the live one. Runs once in the main
// process before the workers start, so the GA_CONFIG set here (a temp copy of the ga-test project's GA config) is what every
// file's loadConfig() reads. The live config (GA_CONFIG at start, else the checkout's .ga/config.json) is only read, for
// baseUrl, the admin password and the live patient id; nothing logs in to the live project. The test project is emptied before and after the run.
// GA_STORE=sqlite: nothing to do here; store-setup.ts gives each file its own temp store.
// The GA work runs in a child node (Node runs the sources directly): vitest's global-setup runner lacks import.meta.resolve.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, type GaConfig, storeKind } from '../../src/config.ts';

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
  const cfg = await retryLimited(() => setup(baseUrl, { projectName: 'ga-test', noRotate: true, out: process.env.GA_CONFIG }));
  const client = await getClient(cfg);
  await assertTestProject(client);
  await emptyTestProject(client); // what a run that stopped half-way left`;
const EMPTY = `const { getClient, loadConfig } = await import(${url('../../src/config.ts')});
  const { emptyTestProject } = await import(${url('./helpers.ts')});
  await emptyTestProject(await getClient(loadConfig()));`;

export default function globalSetup(): (() => void) | undefined {
  if (storeKind() === 'sqlite') return undefined;
  const livePath = defaultConfigPath();
  const need = `integration tests need baseUrl and adminPassword in ${livePath} to make the ga-test project`;
  let live: GaConfig;
  try {
    live = JSON.parse(readFileSync(livePath, 'utf8')) as GaConfig;
  } catch {
    throw new Error(need);
  }
  // A killed run leaves its temp config (it holds the admin password): remove this user's leftovers. Runs are one at a time.
  for (const d of readdirSync(tmpdir())) {
    if (!d.startsWith('ga-int-run-')) continue;
    const p = join(tmpdir(), d);
    try { if (lstatSync(p).isDirectory() && lstatSync(p).uid === process.getuid?.()) rmSync(p, { recursive: true, force: true }); } catch { /* gone or not ours */ }
  }
  // Without the stored password ga setup would try the seeded default and rotate the admin password away from the live config.
  if (!live.baseUrl || !live.adminPassword) throw new Error(need);
  const dir = mkdtempSync(join(tmpdir(), 'ga-int-run-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ baseUrl: live.baseUrl, adminPassword: live.adminPassword }), { mode: 0o600 });
  process.env.GA_INT_LIVE_PATIENT_ID = live.patientId ?? ''; // stack.test.ts: another project's record must be invisible
  process.env.GA_CONFIG = process.env.GA_INT_RUN_CONFIG = path;
  try {
    child(SETUP, process.env);
    // Lookup off (ga setup writes a fresh config): no fixture name reaches the terminology services; tests that want it pass a stub fetch and turn it on.
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), terminologyLookup: false }), { mode: 0o600 });
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
