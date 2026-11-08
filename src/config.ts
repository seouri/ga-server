import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import { countingFetch } from './perf.ts';

export class GaError extends Error {}

export type GaConfig = {
  // Medplum only: absent from a config written by ga setup on the SQLite store.
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  patientId: string;
  projectId?: string; // GA's own Medplum project; absent on installs from before it (ga migrate)
  converterUrl: string;
  // C-CDA converter: 'medplum' in process (set by ga ccda replace); absent: in process unless the record holds Microsoft-era C-CDA records.
  // 'microsoft' forces the converter container (tests and the comparison).
  ccdaConverter?: 'medplum' | 'microsoft';
  store?: 'medplum' | 'sqlite'; // which store GA uses (default medplum); the GA_STORE environment variable overrides it
  storeUrl?: string; // GA's SQLite store; default http://127.0.0.1:8120/
  adminPassword?: string; // rotated by ga setup; also the Medplum app (http://localhost:3000) login for admin@example.com
};

// Resolved from this module, not cwd: agents spawn `ga` from arbitrary directories.
export const defaultConfigPath = (): string =>
  process.env.GA_CONFIG || join(dirname(fileURLToPath(import.meta.url)), '..', '.ga', 'config.json');

export function loadConfig(path = defaultConfigPath()): GaConfig {
  let cfg: GaConfig;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as GaConfig;
  } catch (e) {
    // EACCES: the ga-sync container runs as a uid that cannot read the host's 0600 config.
    if ((e as NodeJS.ErrnoException).code === 'EACCES') throw new GaError('cannot read .ga/config.json: set UID/GID');
    throw new GaError('run ga setup first');
  }
  // The ga-sync container reaches Medplum by service name, not localhost.
  if (process.env.GA_BASE_URL) cfg.baseUrl = process.env.GA_BASE_URL;
  return cfg;
}

const DEFAULT_STORE_URL = 'http://127.0.0.1:8120/';
// Where GA's own store is, for its clients and its server alike: GA_STORE_URL, else the config's storeUrl, else the default.
export const storeUrl = (cfg?: Partial<GaConfig>, env: Record<string, string | undefined> = process.env): string => env.GA_STORE_URL || cfg?.storeUrl || DEFAULT_STORE_URL;

// `ga store serve`'s file, token and address: .ga/store next to the config; binds 127.0.0.1 unless GA_STORE_HOST says otherwise
// (0.0.0.0 inside the ga-store container); the port is storeUrl's. An unreadable config (another uid) leaves the defaults.
export function storeServeOptions(env: Record<string, string | undefined> = process.env, cfgPath = defaultConfigPath()) {
  const dir = join(dirname(cfgPath), 'store');
  let cfg: Partial<GaConfig> = {};
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* none or unreadable */ }
  return { file: join(dir, 'ga.db'), host: env.GA_STORE_HOST || '127.0.0.1', port: Number(new URL(storeUrl(cfg, env)).port || 80), tokenFile: join(dir, 'token') };
}

// Every GA process reads the config (host CLI, stdio MCP, containers via GA_CONFIG), so the store is chosen in one place.
export const storeKind = (cfg?: Partial<GaConfig>): 'medplum' | 'sqlite' =>
  process.env.GA_STORE === 'sqlite' || process.env.GA_STORE === 'medplum' ? process.env.GA_STORE : cfg?.store === 'sqlite' ? 'sqlite' : 'medplum';

export const NOT_RUNNING = 'GA is not running: start it with docker compose up -d';
// The store or Medplum refused the connection (MedplumClient may wrap the fetch error: the cause chain is walked).
export function isGaNotRunning(e: unknown): boolean {
  for (let x = e, depth = 0; x && depth < 5; x = (x as Error).cause, depth++) {
    if ((x as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (x as Error).message === 'fetch failed' || String(x).includes('ECONNREFUSED')) return true;
  }
  return false;
}
// No localStorage in Node: an explicit memory store, so Node prints no warning ahead of GA's own output.
const storage = () => new ClientStorage(new MemoryStorage());
// Fetch for GA's own store or Medplum only: a refused connection there is "GA is not running" (a GaError, so the CLI
// prints just the message). Outbound fetches (hospitals, LLM APIs) never go through this, so their errors keep their own text.
const ownFetch = (f: typeof fetch): typeof fetch => async (input, init) => {
  try {
    return await f(input, init);
  } catch (e) {
    throw isGaNotRunning(e) ? new GaError(NOT_RUNNING, { cause: e }) : e;
  }
};

export const MOVED = 'GA moved to its own store: restart this agent session';
// A long-lived process (the stdio MCP server an agent launched) built its Medplum client before `ga migrate-store --yes`:
// once the config on disk says "store": "sqlite", every request is refused instead of writing to Medplum. The config is
// re-read only when its mtime changes.
export function medplumOnly(f: typeof fetch, path = defaultConfigPath()): typeof fetch {
  let seen = -1, moved = false;
  return (input, init) => {
    let m = seen;
    try { m = statSync(path).mtimeMs; } catch { /* no config file (tests, a config passed in memory): nothing to check */ }
    if (m !== seen) {
      seen = m;
      try { moved = storeKind(JSON.parse(readFileSync(path, 'utf8')) as GaConfig) === 'sqlite'; } catch { /* unreadable mid-write: keep the last answer */ }
    }
    return moved ? Promise.reject(new GaError(MOVED)) : f(input, init);
  };
}

// Fetch through inner with GA's store token on every request (the store's only credential).
export const bearer = (token: string, inner: typeof fetch = fetch): typeof fetch => (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  return inner(input, { ...init, headers });
};

export async function getClient(cfg: GaConfig): Promise<MedplumClient> {
  // GA's own store: no login, the owner process's token from .ga/store/token on every request.
  if (storeKind(cfg) === 'sqlite') {
    let token: string;
    try { token = readFileSync(storeServeOptions().tokenFile, 'utf8').trim(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EACCES') throw new GaError('cannot read .ga/store/token: set UID/GID');
      throw new GaError(NOT_RUNNING);
    }
    const client = new MedplumClient({ baseUrl: storeUrl(cfg), fetch: ownFetch(bearer(token, countingFetch)), storage: storage() });
    // One cheap read in place of Medplum's login: a store that is down fails here, before any command's own error handling.
    await client.search('Patient', { _count: '1' }, { cache: 'no-cache' });
    return client;
  }
  if (!cfg.baseUrl || !cfg.clientId || !cfg.clientSecret) throw new GaError('this config has no Medplum login: for GA\'s own store set "store": "sqlite" in .ga/config.json');
  const client = new MedplumClient({ baseUrl: cfg.baseUrl, fetch: medplumOnly(ownFetch(countingFetch)), storage: storage() });
  await client.startClientLogin(cfg.clientId, cfg.clientSecret);
  return client;
}

// `ga ccda replace`: "ccdaConverter": "medplum" into the config as written (no env overrides), every other key kept, 0600, atomically.
export function setCcdaConverter(file = defaultConfigPath()): void {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as GaConfig;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...raw, ccdaConverter: 'medplum' }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
