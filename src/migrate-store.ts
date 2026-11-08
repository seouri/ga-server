// `ga migrate-store`: one-off copy of GA's record from Medplum into GA's own SQLite store, verified before the switch.
// Stops ga-sync and ga-gateway (no writes during the copy) and ga-store (this command opens the file itself), copies every type GA's Medplum client can read (ids, versionIds,
// lastUpdated, tags and extensions kept; full history for the types GA reads history of; every Binary an attachment points
// at, under its own id), checks each record's version and patient compartment against Medplum's, replays GA's read tools on
// both (migrate-store-verify.ts) and writes a report of counts and categories only. "store": "sqlite" goes into
// .ga/config.json only with --yes and a clean gate. The one command that opens the new file directly (before the store owner starts on it). Medplum is only read.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { bearer, GaError, type GaConfig, storeKind, storeUrl } from './config.ts';
import { writeAtomic } from './smart/store.ts';
import { GA_STORE_TYPES, gaStoreError } from './store-serve.ts';
import { serveStore } from './store/server.ts';
import { Store, StoreError } from './store/store.ts';
import { NORMALIZED, type ReplayRow, guard, guardState, patientRefs, replay } from './migrate-store-verify.ts';

const HISTORY = new Set(['MedicationStatement', 'MedicationRequest', 'Condition', 'AllergyIntolerance', 'Patient']);
const COPIED = GA_STORE_TYPES.filter((t) => t !== 'Binary'); // Binaries: through the attachments that point at them

export type MigrateReport = {
  types: Record<string, { copied: number; skipped: number }>; // skipped: failed the store's validation
  uncounted: Record<string, number>; // Medplum's count minus the records paging returned (nonzero: the copy is incomplete)
  historyVersions: Record<string, number>;
  binaries: { copied: number; failed: number; unresolved?: number }; // unresolved: a stored url still signed, or Binary/<id> with no file
  compartmentMismatches: Record<string, number>;
  versionMismatches: Record<string, number>; // id, versionId or lastUpdated differ from Medplum's
  blockedWrites: number; // writes the replayed tools tried (answered with an echo, never sent)
  normalized: string[];
  replay: ReplayRow[];
  gate?: { pass: boolean; problems: string[] };
  switched?: boolean;
};

export type Services = { stop(): Promise<void>; start(switched: boolean): Promise<void>; commands: { stop: string; start: (switched: boolean) => string } };

// docker compose in the install's directory; after a switch `up -d` (start keeps the old environment).
export function dockerServices(root: string): Services {
  const run = (args: string[]) => new Promise<void>((resolve, reject) => execFile('docker', ['compose', ...args], { cwd: root }, (e) => (e ? reject(e) : resolve())));
  // ga-store too: this command opens the file itself, and host and container locks on one file are not reliable under Docker Desktop.
  // ga-store runs only with the sqlite profile: not switched, GA stays on Medplum and needs only the other two back.
  const stopArgs = ['--profile', 'sqlite', 'stop', 'ga-sync', 'ga-gateway', 'ga-store'];
  const startArgs = (switched: boolean) => (switched ? ['--profile', 'sqlite', 'up', '-d'] : ['start', 'ga-sync', 'ga-gateway']);
  return {
    stop: () => run(stopArgs), start: (s) => run(startArgs(s)),
    commands: { stop: `docker compose ${stopArgs.join(' ')}`, start: (s) => `docker compose ${startArgs(s).join(' ')}` },
  };
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const byType = (o: Record<string, number>) => Object.entries(o).filter(([, n]) => n).map(([t, n]) => `${t}: ${n}`).join(', ');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// What blocks the switch, one line each; empty: the copy is complete and gives the same answers.
export function gate(r: MigrateReport): string[] {
  const skipped = Object.fromEntries(Object.entries(r.types).map(([t, c]) => [t, c.skipped]));
  const out: string[] = [];
  const unc = Object.entries(r.uncounted ?? {}).filter(([, n]) => n);
  if (unc.length) out.push(`Medplum's count differs from the records read (${unc.map(([t, n]) => `${t}: ${n > 0 ? 'missing' : 'extra'} ${Math.abs(n)}`).join(', ')})`);
  if (sum(skipped)) out.push(`${plural(sum(skipped), 'record failed validation and was', 'records failed validation and were')} not copied (${byType(skipped)})`);
  if (sum(r.compartmentMismatches)) out.push(`${plural(sum(r.compartmentMismatches), 'compartment mismatch', 'compartment mismatches')} with Medplum (${byType(r.compartmentMismatches)})`);
  if (sum(r.versionMismatches)) out.push(`${plural(sum(r.versionMismatches), 'id/version mismatch', 'id/version mismatches')} with Medplum (${byType(r.versionMismatches)})`);
  if (r.binaries.failed) out.push(`${plural(r.binaries.failed, 'Binary', 'Binaries')} could not be copied`);
  if (r.binaries.unresolved) out.push(`${plural(r.binaries.unresolved, 'attachment url does', 'attachment urls do')} not resolve to a copied Binary`);
  const bad = r.replay.filter((x) => x.result === 'unexplained');
  if (bad.length) out.push(`${plural(bad.length, 'unexplained replay difference', 'unexplained replay differences')} (${[...new Set(bad.map((x) => `${x.category} ${x.name}`))].join(', ')})`);
  return out;
}

// Attachment urls pointing at this Medplum's Binaries (as stored, or presigned /storage/ links) become Binary/<id>; the ids are collected.
function ownBinaries(base: string) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(?:Binary/|${esc}(?:storage/|fhir/R4/Binary/))([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)`);
  const ids = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      const m = k === 'url' && typeof v === 'string' ? re.exec(v) : null;
      if (m) { o[k] = `Binary/${m[1]}`; ids.add(m[1]); } else walk(v);
    }
  };
  return { ids, walk };
}

async function allHistory(c: MedplumClient, type: string, id: string): Promise<Resource[]> {
  const out: Resource[] = [];
  let b: Bundle = await c.readHistory(type as 'Condition', id);
  for (;;) {
    for (const e of b.entry ?? []) if (e.resource) out.push(e.resource); // entries without one are deletes
    const next = b.link?.find((l) => l.relation === 'next')?.url;
    if (!next) return out;
    b = await c.get(next, { cache: 'no-cache' });
  }
}

// Copies every type (Medplum is only read) into `store`, filling the report's counts. Returns per record the expected
// "versionId|lastUpdated|Patient compartment refs" (Medplum also lists Project/), and the Binary ids attachments point at.
export async function copyRecord(medplum: MedplumClient, store: Store, report: MigrateReport): Promise<{ want: Map<string, string>; ids: Set<string> }> {
  const own = ownBinaries(medplum.getBaseUrl());
  const want = new Map<string, string>();
  for (const type of COPIED) {
    const counts = { copied: 0, skipped: 0 };
    for await (const page of medplum.searchResourcePages(type as 'Observation', { _sort: '_lastUpdated', _count: '1000' }, { cache: 'no-cache' })) {
      const hist = new Map<string, Resource[]>();
      if (HISTORY.has(type)) for (const r of page) hist.set(r.id!, await allHistory(medplum, type, r.id!));
      own.walk(page);
      own.walk([...hist.values()]);
      store.transaction(() => {
        for (const r of page as Resource[]) {
          try { store.put(r, { history: hist.get(r.id!) }); } catch (e) {
            if (!(e instanceof StoreError)) throw e;
            counts.skipped++;
            continue;
          }
          counts.copied++;
          want.set(`${type}/${r.id}`, `${r.meta?.versionId}|${r.meta?.lastUpdated}|${patientRefs(r.meta?.compartment)}`);
          if (hist.has(r.id!)) report.historyVersions[type] = (report.historyVersions[type] ?? 0) + hist.get(r.id!)!.length;
        }
      });
    }
    // Completeness: paging must have seen every record Medplum counts (services are stopped, so nothing changes meanwhile).
    const total = (await medplum.search(type as 'Observation', { _summary: 'count' }, { cache: 'no-cache' })).total ?? 0;
    if (total !== counts.copied + counts.skipped) report.uncounted[type] = total - counts.copied - counts.skipped;
    if (counts.copied || counts.skipped) report.types[type] = counts;
  }
  return { want, ids: own.ids };
}

// "store": "sqlite" into the config as written (no env overrides), every other key kept, 0600, atomically.
export function switchConfig(file: string): void {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as GaConfig;
  writeAtomic(file, `${JSON.stringify({ ...raw, store: 'sqlite' }, null, 2)}\n`, 0o600);
}

export type MigrateOptions = {
  file: string; configFile: string; reportFile: string; yes: boolean; servicesStopped: boolean; services: Services; cfg: GaConfig;
  log?: (s: string) => void;
  hooks?: { afterCopy?: (store: Store) => void }; // tests: tamper with the copy before it is checked
  storeUp?: () => Promise<boolean>; // default: the configured store answers /healthz
  allowSwitch?: boolean; // tests and development: --yes switches even while SWITCH_READY is false
};

// --yes is refused until the store has full FHIR spec support (owner's decision): the dry run still copies, checks and reports.
export const SWITCH_READY = false;
export const SWITCH_REFUSED = 'The SQLite store switches once full FHIR spec support is done (docs/superpowers/specs/2026-11-08-sqlite-store-design.md, Next phase)';

// Whether a store server answers at GA's store URL (any status: something holds the port, likely ga-store with the file open).
async function storeAnswers(cfg: GaConfig): Promise<boolean> {
  const base = storeUrl(cfg);
  try { await fetch(new URL('healthz', base), { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; }
}

export async function migrateStore(o: MigrateOptions): Promise<{ report: MigrateReport; switched: boolean }> {
  const log = o.log ?? ((s: string) => console.log(s));
  if (storeKind(o.cfg) === 'sqlite') throw new GaError('GA already runs on its own store: nothing to migrate');
  const { baseUrl, clientId, clientSecret } = o.cfg;
  if (!baseUrl || !clientId || !clientSecret) throw new GaError('migrate-store reads from Medplum: this config has no Medplum login');
  if (o.yes && !(o.allowSwitch ?? SWITCH_READY)) throw new GaError(SWITCH_REFUSED);
  let store: Store | undefined;
  let switched = false, stopped = false;
  try {
    // Stop first: ga-store must not hold the file open while this process opens it (Store's constructor writes).
    if (o.servicesStopped) {
      // The user said the services are stopped: a store still serving would hold the file this command opens.
      if (await (o.storeUp ?? (() => storeAnswers(o.cfg)))()) throw new GaError('ga-store is still running: run docker compose stop ga-store first');
      log('--services-stopped: not stopping ga-sync, ga-gateway and ga-store');
    }
    else {
      try { await o.services.stop(); stopped = true; } catch {
        log(`Could not stop the services that write to GA. Run this in the GA folder:\n  ${o.services.commands.stop}`);
        throw new GaError('then run ga migrate-store --services-stopped');
      }
    }
    mkdirSync(dirname(o.file), { recursive: true, mode: 0o700 });
    try { store = new Store(o.file, { types: GA_STORE_TYPES }); } catch (e) { throw gaStoreError(e); }
    if ((store.db.prepare('select count(*) n from resources').get() as { n: number }).n) throw new GaError(`${o.file} already holds records: move it aside to migrate again`);

    const mstate = guardState();
    const medplum = new MedplumClient({ baseUrl, fetch: guard((i, n) => fetch(i, n), mstate, true), storage: new ClientStorage(new MemoryStorage()), cacheTime: 0 });
    await medplum.startClientLogin(clientId, clientSecret);
    const report: MigrateReport = { types: {}, uncounted: {}, historyVersions: {}, binaries: { copied: 0, failed: 0 }, compartmentMismatches: {}, versionMismatches: {}, blockedWrites: 0, normalized: NORMALIZED, replay: [] };

    const { want, ids } = await copyRecord(medplum, store, report);
    await medplum.startClientLogin(clientId, clientSecret); // a fresh token: the copy may have outlived the first
    for (const id of ids) {
      try {
        const res = await fetch(medplum.fhirUrl('Binary', id), { headers: { authorization: `Bearer ${medplum.getAccessToken()}`, accept: '*/*' } });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        await store.putBinaryStream(res.headers.get('content-type') ?? 'application/octet-stream', res.body, id);
        report.binaries.copied++;
      } catch { report.binaries.failed++; }
    }
    o.hooks?.afterCopy?.(store);

    // Check each record as stored (read back) against Medplum's; every Medplum attachment url must now be a copied Binary/<id>.
    report.binaries.unresolved = 0;
    for (const [key, w] of want) {
      const [type, id] = key.split('/');
      const json = store.readRow(type, id)?.json;
      const got = json ? (JSON.parse(json) as Resource) : undefined;
      for (const [, u] of json?.matchAll(/"url":"([^"]*)"/g) ?? []) {
        const rel = /^Binary\/([0-9a-f-]{36})$/.exec(u)?.[1];
        if (/\/storage\/[0-9a-f-]{36}/.test(u) || (rel && !store.openBinary(rel))) report.binaries.unresolved++;
      }
      const [vid, lu, refs] = w.split('|');
      if (!got || got.meta?.versionId !== vid || got.meta?.lastUpdated !== lu) report.versionMismatches[type] = (report.versionMismatches[type] ?? 0) + 1;
      if (got && patientRefs(got.meta?.compartment) !== refs) report.compartmentMismatches[type] = (report.compartmentMismatches[type] ?? 0) + 1;
    }
    store.close();
    store = undefined;

    // Replay through the store server, as GA will use it (a private token, a free port).
    const tmp = mkdtempSync(join(tmpdir(), 'ga-migrate-'));
    const server = await serveStore({ file: o.file, host: '127.0.0.1', port: 0, tokenFile: join(tmp, 'token'), types: GA_STORE_TYPES });
    try {
      const token = readFileSync(join(tmp, 'token'), 'utf8').trim();
      const local = new MedplumClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, fetch: guard(bearer(token), mstate), storage: new ClientStorage(new MemoryStorage()), cacheTime: 0 });
      report.replay = await replay(medplum, local, o.cfg, mstate, (s) => console.error(s));
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(tmp, { recursive: true, force: true });
    }
    report.blockedWrites = mstate.blocked;

    const problems = gate(report);
    report.gate = { pass: !problems.length, problems };
    report.switched = false;
    const writeReport = () => { mkdirSync(dirname(o.reportFile), { recursive: true, mode: 0o700 }); writeFileSync(o.reportFile, JSON.stringify(report, null, 1), { mode: 0o600 }); };
    writeReport();

    const eq = report.replay.filter((x) => x.result === 'equal').length, allowed = report.replay.filter((x) => x.result === 'allowed').length;
    log(`Copied ${Object.values(report.types).reduce((n, c) => n + c.copied, 0)} records (${Object.keys(report.types).length} types), ` +
      `${sum(report.historyVersions)} history versions, ${report.binaries.copied} Binaries. Replay: ${eq} equal, ${allowed} allowed differences, ` +
      `${report.replay.length - eq - allowed} unexplained. Report: ${o.reportFile}`);
    if (problems.length) log(`Not switched:\n${problems.map((p) => `  - ${p}`).join('\n')}\nGA stays on Medplum. To try again, move ${o.file} aside first.`);
    else if (!o.yes) log(o.allowSwitch ?? SWITCH_READY ? `The copy checks out; GA stays on Medplum. Read the report, then move ${o.file} aside and run ga migrate-store --yes to switch.`
      : `The copy checks out; GA stays on Medplum. ${SWITCH_REFUSED}.`);
    if (o.yes && !problems.length) {
      switchConfig(o.configFile);
      switched = report.switched = true;
      writeReport();
      log(`${o.configFile}: "store": "sqlite" (was Medplum). New ga commands and the restarted services use it. A running MCP server (an agent session) keeps its old connection and now refuses requests: restart your agent sessions (Claude Code, Codex, Hermes).`);
    }
    return { report, switched };
  } finally {
    store?.close();
    if (o.servicesStopped) log(`Start GA's services again: ${o.services.commands.start(switched)}`);
    else if (stopped) {
      try { await o.services.start(switched); } catch { log(`Could not restart GA's services. Run this in the GA folder:\n  ${o.services.commands.start(switched)}`); }
    }
  }
}
