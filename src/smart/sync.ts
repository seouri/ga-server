// Sync one or all SMART sources into GA: token -> fetch -> map -> Binaries -> importResources -> Endpoint status.
import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Attachment, DocumentReference, Endpoint, Extension, Resource } from '@medplum/fhirtypes';
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
  error?: string;
  skipped?: Record<string, string>;
};

const SOURCE_ID = 'urn:ga-server:id:smart-source';
const X = 'urn:ga-server:ext:smart-';
const LAST_SUCCESS = `${X}last-success`;
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
    get: (t, p, _r) => {
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
      const a: Attachment = c.attachment;
      const b = a.url && byRef.get(a.url);
      if (!b) continue;
      // Medplum may answer with a presigned storage URL: store the Binary/<id> form either way.
      const reuse = existing?.content.find((x) => x.attachment.hash === a.hash && x.attachment.url)?.attachment.url;
      const id = reuse && /(?:^|\/)(?:Binary|storage)\/([^/?]+)/.exec(reuse)?.[1];
      a.url = `Binary/${id ?? (await client.createBinary({ data: b.data, contentType: b.contentType })).id}`;
    }
  }
}

const findEndpoint = async (client: MedplumClient, key: string, patientId: string): Promise<Endpoint | undefined> =>
  (await client.searchResources('Endpoint', { identifier: `${SOURCE_ID}|${key}` }, { cache: 'no-cache' })).find(
    (e) => e.extension?.find((x) => x.url === PATIENT)?.valueReference?.reference === `Patient/${patientId}`,
  );

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
  const lastSuccess = status === 'active' ? at : prev?.extension?.find((x) => x.url === LAST_SUCCESS)?.valueDateTime;
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

export async function syncSource(
  client: MedplumClient,
  dir: string,
  src: SourceRec,
  patientId: string,
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<SyncResult> {
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
    const ok: SyncResult = { source: src.key, status: pending ? 'pending' : 'active', report, perType: report.byType, skipped: fetched.skipped };
    if (dryRun) return ok;
    try {
      await writeEndpoint(client, dir, src, patientId, 'active', at);
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
    // not_connected: no tokens, i.e. ga disconnect, which already wrote the Endpoint off/disconnected.
    if (!dryRun && code !== 'not_connected') await writeEndpoint(client, dir, src, patientId, status, at, code); // a throw here: syncAll records status_write_error
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
  const listed = eps
    .filter((e) => e.extension?.find((x) => x.url === PATIENT)?.valueReference?.reference === `Patient/${patientId}`)
    .map((e) => {
      const get = (url: string) => e.extension?.find((x) => x.url === url);
      const lastSuccess = get(LAST_SUCCESS)?.valueDateTime;
      const types = get(ENABLED_TYPES)?.valueString;
      const error = get(LAST_ERROR)?.valueCode;
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
