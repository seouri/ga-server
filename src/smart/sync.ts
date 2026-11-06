// Sync one or all SMART sources into GA: token -> fetch -> map -> Binaries -> importResources -> Endpoint status.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Endpoint, Extension, Resource } from '@medplum/fhirtypes';
import { GaError } from '../config.ts';
import { importResources, type ImportReport } from '../engine.ts';
import { accessToken, type Tokens } from './auth.ts';
import { fetchAll, mapForGa, type PendingBinary } from './fetch.ts';
import { loadSecret, readApp, readSources, type SourceRec } from './store.ts';

export type SyncResult = {
  source: string;
  status: 'active' | 'error' | 'off' | 'pending'; // pending: no enabled types yet, so only a dry run ran
  report?: ImportReport;
  perType?: Record<string, { created: number; flagged: number }>;
  fetched?: Record<string, number>; // per type, as the portal returned them
  dryRun?: boolean;
  error?: string;
  skipped?: Record<string, string>;
};

export const SOURCE_ID = 'urn:ga-server:id:smart-source';
const X = 'urn:ga-server:ext:smart-';
export const LAST_SUCCESS = `${X}last-success`;
const LAST_ATTEMPT = `${X}last-attempt`;
const LAST_ERROR = `${X}last-error`;
const ACCESS_EXPIRES = `${X}access-expires`;
const ENABLED_TYPES = `${X}enabled-types`;
const PATIENT = `${X}patient`;
const PENDING = 'urn:ga-server:pending-binary:';
const STALE_MS = 48 * 3_600_000;

export const isStale = (status: string, lastSuccess: string | undefined, now: Date): boolean =>
  status === 'off' || status === 'error' || !lastSuccess || !(now.getTime() - Date.parse(lastSuccess) <= STALE_MS); // NaN: stale

// The reads importResources and uploadBinaries use; bound to the real client (MedplumClient has #private fields).
const DRY_READS = new Set(['searchOne', 'searchResources', 'search', 'readResource', 'get', 'getProfile', 'fhirUrl', 'getBaseUrl']);

// Allowlist: the known writes are no-ops returning a plausible result, listed reads pass through, any other method throws.
function dryRunClient(client: MedplumClient): MedplumClient {
  const stubs: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    createResource: async (r) => ({ ...(r as Resource), id: randomUUID() }),
    updateResource: async (r) => r,
    patchResource: async (type, id) => ({ resourceType: type, id }),
    createBinary: async () => ({ resourceType: 'Binary', id: randomUUID() }),
    deleteResource: async () => undefined,
  };
  return new Proxy(client, {
    get: (t, p) => {
      if (typeof p === 'string' && Object.hasOwn(stubs, p)) return stubs[p];
      const v = Reflect.get(t, p, t);
      if (typeof v !== 'function') return v;
      if (typeof p === 'string' && DRY_READS.has(p)) return v.bind(t);
      return () => {
        throw new GaError(`dry run: ${String(p)} not allowed`);
      };
    },
  });
}

// Upload each pending Binary and point its attachment at it. A DocumentReference already stored with an attachment of the
// same hash keeps that Binary, so a re-sync uploads nothing and changes nothing.
async function uploadBinaries(client: MedplumClient, resources: Resource[], binaries: PendingBinary[], src: SourceRec, patientId: string): Promise<void> {
  const byRef = new Map(binaries.map((b) => [b.ref, b]));
  for (const r of resources) {
    if (r.resourceType !== 'DocumentReference') continue;
    const d = r as DocumentReference;
    if (!d.content.some((c) => c.attachment.url?.startsWith(PENDING))) continue;
    const existing = await client.searchOne(
      'DocumentReference',
      { identifier: `urn:ga-server:id:smart:${src.key}|DocumentReference/${d.id}`, subject: `Patient/${patientId}` },
      { cache: 'no-cache' },
    );
    for (const c of d.content) {
      const a = c.attachment;
      const b = a.url && byRef.get(a.url);
      if (!b) continue;
      // Medplum may answer with a presigned storage URL: store the Binary/<id> form either way.
      const reuse = existing?.content.find((x) => x.attachment.hash === a.hash && x.attachment.url)?.attachment.url;
      const id = reuse && /(?:^|\/)(?:Binary|storage)\/([^/?]+)/.exec(reuse)?.[1];
      a.url = `Binary/${id ?? (await client.createBinary({ data: b.data, contentType: b.contentType })).id}`;
    }
  }
}

const ext = (e: Endpoint | undefined, url: string): Extension | undefined => e?.extension?.find((x) => x.url === url);
export const forPatient = (patientId: string) => (e: Endpoint): boolean => ext(e, PATIENT)?.valueReference?.reference === `Patient/${patientId}`;

const findEndpoint = async (client: MedplumClient, key: string, patientId: string): Promise<Endpoint | undefined> =>
  (await client.searchResources('Endpoint', { identifier: `${SOURCE_ID}|${key}` }, { cache: 'no-cache' })).find(forPatient(patientId));

export async function writeEndpoint(
  client: MedplumClient,
  dir: string,
  src: SourceRec,
  patientId: string,
  status: 'active' | 'error' | 'off',
  at: string,
  error?: string,
): Promise<void> {
  const prev = await findEndpoint(client, src.key, patientId);
  let expires: number | undefined;
  try {
    expires = loadSecret<Tokens>(dir, src.key)?.expires_at;
  } catch {
    // unreadable token store: no expiry to report
  }
  const lastSuccess = status === 'active' ? at : ext(prev, LAST_SUCCESS)?.valueDateTime;
  const extension: Extension[] = [
    { url: PATIENT, valueReference: { reference: `Patient/${patientId}` } },
    { url: LAST_ATTEMPT, valueDateTime: at },
    ...(lastSuccess ? [{ url: LAST_SUCCESS, valueDateTime: lastSuccess }] : []),
    ...(error ? [{ url: LAST_ERROR, valueCode: error }] : []),
    ...(expires ? [{ url: ACCESS_EXPIRES, valueDateTime: new Date(expires).toISOString() }] : []),
    ...(src.enabledTypes ? [{ url: ENABLED_TYPES, valueString: src.enabledTypes.join(',') }] : []),
  ];
  const ep: Endpoint = {
    resourceType: 'Endpoint',
    ...(prev && { id: prev.id }),
    identifier: [{ system: SOURCE_ID, value: src.key }],
    status,
    name: src.name,
    address: src.fhirBase,
    connectionType: { system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest' },
    payloadType: [{ text: 'FHIR R4' }],
    extension,
  };
  await (prev ? client.updateResource(ep) : client.createResource(ep));
}

const lastUpdated = (r: Resource): string | undefined => r.meta?.lastUpdated;

const LOCK_STALE_MS = 2 * 3_600_000;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Per-source sync lock (O_EXCL), so a daemon run and a manual ga sync never both create the same record. Shared .ga/ with
// the ga-sync container: a pid is only checked on the host that wrote it; elsewhere only the 2 h age frees the lock.
async function takeSyncLock(dir: string, key: string, waitMs: number): Promise<string | undefined> {
  const f = join(dir, `${key}.sync.lock`);
  for (const end = Date.now() + waitMs; ; ) {
    try {
      const fd = openSync(f, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), started: Date.now() }));
      closeSync(fd);
      return f;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let held: { pid?: number; host?: string; started?: number } = {};
    let started = Date.now();
    try {
      started = statSync(f).mtimeMs;
      held = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      // vanished or mid-write: held, aged by its mtime
    }
    const stale =
      (held.host === hostname() && typeof held.pid === 'number' && !alive(held.pid)) ||
      // our own pid but written before we started: a restarted container that reused the pid (SIGTERM skips finally)
      (held.host === hostname() && held.pid === process.pid && (held.started ?? started) < Date.now() - process.uptime() * 1000) ||
      Date.now() - (held.started ?? started) > LOCK_STALE_MS;
    if (stale) rmSync(f, { force: true });
    else if (Date.now() >= end) return undefined;
    else await new Promise((r) => setTimeout(r, 250));
  }
}

export async function syncSource(
  client: MedplumClient,
  dir: string,
  src: SourceRec,
  patientId: string,
  opts: { dryRun?: boolean; now?: Date; lockWaitMs?: number } = {},
): Promise<SyncResult> {
  const lock = await takeSyncLock(dir, src.key, opts.lockWaitMs ?? 30_000);
  if (!lock) {
    // Another sync of this source is running: leave its Endpoint alone and report the status it has.
    const ep = await findEndpoint(client, src.key, patientId).catch(() => undefined);
    return { source: src.key, status: (ep?.status as SyncResult['status'] | undefined) ?? 'pending', error: 'busy' };
  }
  try {
    return await runSync(client, dir, src, patientId, opts);
  } finally {
    rmSync(lock, { force: true });
  }
}

async function runSync(client: MedplumClient, dir: string, src: SourceRec, patientId: string, opts: { dryRun?: boolean; now?: Date }): Promise<SyncResult> {
  const at = (opts.now ?? new Date()).toISOString(); // one timestamp: source date, last-seen and last-success
  const pending = !src.enabledTypes; // no enabled types yet: counts only, nothing in GA, until the user enables them
  const dryRun = !!opts.dryRun || pending;
  let stage = 'token_error';
  try {
    const clientId = readApp(dir).clientId;
    if (!clientId) throw new GaError('no_client_id');
    const token = await accessToken(dir, src, clientId);
    const patient = src.patient ?? loadSecret<Tokens>(dir, src.key)?.patient;
    if (!patient) throw new GaError('no_patient');
    stage = 'fetch_error';
    const fetched = await fetchAll(src.fhirBase, token, patient, dryRun ? undefined : src.enabledTypes);
    const { resources, binaries } = mapForGa(fetched.resources, src);
    stage = 'import_error';
    const c = dryRun ? dryRunClient(client) : client;
    await uploadBinaries(c, resources, binaries, src, patientId);
    const report = await importResources(
      c,
      resources,
      { kind: 'smart', file: src.fhirBase, date: at, writer: 'importer', dateOf: lastUpdated, fillOnly: (r) => !lastUpdated(r), seenAt: at },
      patientId,
      '',
    );
    const ok: SyncResult = {
      source: src.key,
      status: pending ? 'pending' : 'active',
      report,
      perType: report.byType,
      fetched: fetched.byType,
      skipped: fetched.skipped,
      ...(dryRun && { dryRun: true }),
    };
    if (opts.dryRun) return ok; // an explicit --dry-run writes nothing at all
    try {
      // Never enabled: a status-only Endpoint, so agents see the source (off, not_enabled: stale) without any patient data.
      await writeEndpoint(client, dir, src, patientId, pending ? 'off' : 'active', at, pending ? 'not_enabled' : undefined);
    } catch {
      console.error(`smart sync ${src.key}: status_write_error`);
      return { ...ok, error: 'status_write_error' }; // the import itself succeeded
    }
    return ok;
  } catch (e) {
    // Error codes only: messages from servers or the engine may carry content.
    const code = e instanceof GaError && /^[a-z_]+$/.test(e.message) ? e.message : stage;
    // No usable refresh token: only reconnecting helps.
    const status = code === 'invalid_grant' || code === 'no_refresh_token' || code === 'not_connected' ? 'off' : 'error';
    console.error(`smart sync ${src.key}: ${code}`);
    // not_connected: no tokens, i.e. ga disconnect, which already wrote the Endpoint off/disconnected. A never-enabled source is written off.
    if (!opts.dryRun && code !== 'not_connected') await writeEndpoint(client, dir, src, patientId, pending ? 'off' : status, at, code); // a throw here: syncAll records status_write_error
    return { source: src.key, status, error: code };
  }
}

// Sources in sources.json order; one failure never stops the others.
export async function syncAll(client: MedplumClient, dir: string, patientId: string, opts: { dryRun?: boolean } = {}): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const src of readSources(dir)) {
    try {
      out.push(await syncSource(client, dir, src, patientId, opts));
    } catch {
      out.push({ source: src.key, status: 'error', error: 'status_write_error' }); // the Endpoint write itself failed
    }
  }
  return out;
}

export async function readStatus(
  client: MedplumClient,
  patientId: string,
  dir?: string, // given: configured sources with no Endpoint yet (never synced for real) are listed as pending
): Promise<{ source: string; name: string; status: string; lastSuccess?: string; error?: string; stale: boolean; enabledTypes: string[] }[]> {
  const now = new Date();
  const eps = await client.searchResources('Endpoint', { identifier: `${SOURCE_ID}|`, _count: '1000' }, { cache: 'no-cache' });
  const listed = eps.filter(forPatient(patientId)).map((e) => {
    const lastSuccess = ext(e, LAST_SUCCESS)?.valueDateTime;
    const types = ext(e, ENABLED_TYPES)?.valueString;
    const error = ext(e, LAST_ERROR)?.valueCode;
    return {
      source: e.identifier?.find((i) => i.system === SOURCE_ID)?.value ?? '',
      name: e.name ?? '',
      status: e.status,
      ...(lastSuccess && { lastSuccess }),
      ...(error && { error }),
      stale: isStale(e.status, lastSuccess, now),
      enabledTypes: types ? types.split(',') : [],
    };
  });
  const have = new Set(listed.map((s) => s.source));
  const pending = (dir ? readSources(dir) : [])
    .filter((s) => !have.has(s.key))
    .map((s) => ({ source: s.key, name: s.name, status: 'pending', stale: true, enabledTypes: s.enabledTypes ?? [] }));
  return [...listed, ...pending];
}
