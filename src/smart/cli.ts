// ga keys / connect / sync / status / disconnect. Prints counts, type names and error codes only: never tokens, names of people or content.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GaError, getClient, loadConfig } from '../config.ts';
import { COMPARTMENT } from '../engine.ts';
import { connect } from './auth.ts';
import { deleteSecret, ensureKeys, readApp, readSources, smartDir, writeApp, writeSources } from './store.ts';
import type { SourceRec } from './store.ts';
import { readStatus, syncAll, syncSource, writeEndpoint } from './sync.ts';
import type { SyncResult } from './sync.ts';

const USAGE: Record<string, string> = {
  keys: 'ga keys',
  connect: 'ga connect <fhir-base-url> [--client-id <id>] [--name <label>]',
  sync: 'ga sync [--dry-run] [--enable <Type,...>|all] [source] | ga sync --daemon',
  status: 'ga status',
  disconnect: 'ga disconnect <source>',
};
const OPTIONS = {
  keys: {},
  connect: { 'client-id': { type: 'string' }, name: { type: 'string' } },
  sync: { 'dry-run': { type: 'boolean' }, enable: { type: 'string' }, daemon: { type: 'boolean' } },
  status: {},
  disconnect: {},
} as const;
const HOUR_MS = 3_600_000;
const NO_SOURCES = 'no sources connected';

// Medplum client and patient. GA_PATIENT_ID is for tests only, as in mcp.ts.
async function ga() {
  const cfg = loadConfig();
  return { client: await getClient(cfg), patientId: process.env.GA_PATIENT_ID || cfg.patientId };
}

function pick(sources: SourceRec[], arg: string | undefined): SourceRec[] {
  if (!arg) return sources;
  const s = sources.find((x) => x.key === arg || x.name === arg);
  if (!s) throw new GaError(`unknown source: ${arg} (see ga status)`);
  return [s];
}

function print(r: SyncResult, log: (s: string) => void = console.log): void {
  const c = r.report;
  const dry = r.dryRun ? ' (dry run: nothing written)' : '';
  const counts = c ? ` created ${c.created}, updated ${c.updated}, possible duplicates ${c.possibleDuplicates}, invalid ${c.invalid}${dry}` : '';
  const hint = r.status === 'off' ? ': run ga connect <fhir-base-url>' : '';
  log(`${r.source}: ${r.status}${counts}${r.error ? ` error ${r.error}${hint}` : ''}`);
  const types = [...new Set([...Object.keys(r.fetched ?? {}), ...Object.keys(c?.byType ?? {})])].filter((t) => t !== 'Patient').sort();
  for (const t of types) {
    const n = c?.byType?.[t] ?? { created: 0, linked: 0, updated: 0, flagged: 0 };
    log(`  ${t}: fetched ${r.fetched?.[t] ?? 0}, created ${n.created}, linked ${n.linked}, updated ${n.updated}, flagged ${n.flagged}`);
  }
  if (r.dryRun && c) log('  created on a type GA already holds from Epic (C-CDA/EHI) = likely duplicates — leave that type disabled');
  for (const [t, why] of Object.entries(r.skipped ?? {}).sort()) log(`  skipped ${t}: ${why}`);
}

function browser(url: string): void {
  console.log(`Log in to the patient portal in your browser. Choose the longest access duration offered.\n${url}`);
  // GA_OPEN=fetch: tests only, plays a browser against the auto-approving mock server.
  if (process.env.GA_OPEN === 'fetch') return void fetch(url).catch(() => undefined);
  if (process.platform === 'darwin') execFile('open', [url], () => undefined); // the URL is printed either way
}

// Wakes hourly and syncs once 24 h of wall-clock time has passed (1 h after a failed run), so Mac or VM sleep,
// which pauses timers, never pushes the daily sync out by the hours spent asleep.
async function daemon(): Promise<never> {
  let last = 0;
  let wait = 0; // startup: sync now
  for (;; await new Promise((r) => setTimeout(r, HOUR_MS))) {
    if (Date.now() - last < wait) continue;
    last = Date.now();
    const at = new Date(last).toISOString();
    let failed = false;
    try {
      // Log in before checking sources, so "no sources connected" also proves the container reaches Medplum.
      const { client, patientId } = await ga();
      const dir = smartDir();
      if (!readSources(dir).length) console.log(`${at} ${NO_SOURCES}`);
      for (const r of await syncAll(client, dir, patientId)) {
        print(r, (s) => console.log(`${at} ${s}`));
        failed ||= r.status === 'error'; // network or server: retry soon; off (login needed) waits a day
      }
    } catch (e) {
      failed = true;
      console.error(`${at} sync failed: ${e instanceof GaError ? e.message : 'sync_error'}`);
    }
    wait = failed ? HOUR_MS : 24 * HOUR_MS;
  }
}

// Returns false when argv is not a SMART command.
export async function smartCommand(argv: string[]): Promise<boolean> {
  const cmd = argv[0] as keyof typeof OPTIONS;
  if (!Object.hasOwn(OPTIONS, cmd)) return false;
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv.slice(1), options: OPTIONS[cmd], allowPositionals: true, strict: true });
    values = parsed.values as typeof values;
    positionals = parsed.positionals;
  } catch {
    throw new GaError(`usage: ${USAGE[cmd]}`);
  }
  const usage = (ok: boolean) => {
    if (!ok) throw new GaError(`usage: ${USAGE[cmd]}`);
  };
  const dir = smartDir();

  if (cmd === 'keys') {
    usage(!positionals.length);
    const { publicJwks, publicPem } = await ensureKeys(dir);
    console.log(JSON.stringify(publicJwks, null, 2));
    console.log(publicPem.trim());
    console.log(
      `Public key only (also in ${join(dir, 'public.jwks.json')}). Paste the JWKS or the PEM, whichever the app registration form accepts. ` +
        'If it only takes a JWK Set URL, host public.jwks.json at any public static URL: it is a public key, never health data.',
    );
  } else if (cmd === 'connect') {
    usage(positionals.length === 1);
    const id = values['client-id'] as string | undefined;
    const clientId = id || readApp(dir).clientId;
    if (!clientId) throw new GaError('first connect needs --client-id <id> (the client ID from your app registration)');
    const { client, patientId } = await ga(); // fails before the login when GA is not running
    if (id) writeApp(dir, { ...readApp(dir), clientId: id });
    const src = await connect(dir, positionals[0], clientId, browser, { name: values.name as string | undefined });
    // No enabled types yet: syncSource only dry-runs. Under fallback A this is the only fetch.
    const r = await syncSource(client, dir, src, patientId);
    print(r);
    if (r.status === 'pending' && !r.error) {
      console.log(`Next: enable only the types that are new to GA or link to what it holds: ga sync --enable <Type,...> ${src.key}`);
    }
    if (r.status === 'error' || r.error === 'busy') process.exitCode = 1;
  } else if (cmd === 'sync') {
    if (values.daemon) {
      usage(!positionals.length && !values.enable && !values['dry-run']);
      await daemon();
    }
    usage(positionals.length <= 1);
    const sources = readSources(dir);
    if (!sources.length) {
      if (values.enable) throw new GaError(`${NO_SOURCES}: run ga connect <fhir-base-url> first`);
      console.log(NO_SOURCES);
      return true;
    }
    const chosen = pick(sources, positionals[0]);
    if (values.enable) {
      if (chosen.length > 1) throw new GaError('several sources connected: name the source, e.g. ga sync --enable <Type,...> <source>');
      const all = Object.keys(COMPARTMENT);
      const types = values.enable === 'all' ? all : (values.enable as string).split(',').map((t) => t.trim()).filter(Boolean);
      const bad = types.filter((t) => !all.includes(t));
      if (bad.length || !types.length) throw new GaError(`unknown type: ${bad.join(',') || '(none)'}; known: ${all.join(',')}`);
      chosen[0].enabledTypes = types;
      writeSources(dir, sources.map((s) => (s.key === chosen[0].key ? chosen[0] : s)));
    }
    const { client, patientId } = await ga();
    for (const src of chosen) {
      const r = await syncSource(client, dir, src, patientId, { dryRun: !!values['dry-run'] });
      print(r);
      if (r.status === 'error' || r.error === 'busy') process.exitCode = 1;
    }
  } else if (cmd === 'status') {
    usage(!positionals.length);
    if (!readSources(dir).length) {
      console.log(NO_SOURCES);
      return true;
    }
    const { client, patientId } = await ga();
    for (const s of await readStatus(client, patientId, dir)) {
      const types = s.enabledTypes.length ? s.enabledTypes.join(',') : 'none (dry run only)';
      console.log(
        `${s.name} (${s.source}): ${s.status}${s.error ? ` (${s.error})` : ''}, last success ${s.lastSuccess ?? 'never'}${s.stale ? ', STALE' : ''}, types: ${types}`,
      );
    }
  } else {
    usage(positionals.length === 1);
    const [src] = pick(readSources(dir), positionals[0]);
    const { client, patientId } = await ga();
    // Status first: if this write fails the tokens remain and the source still works. The source stays listed
    // (enabled types kept for a reconnect); with no tokens, sync skips it.
    await writeEndpoint(client, dir, src, patientId, 'off', new Date().toISOString(), 'disconnected');
    deleteSecret(dir, src.key);
    console.log(`${src.key}: disconnected; records already fetched stay. Reconnect: ga connect ${src.fhirBase}`);
  }
  return true;
}
