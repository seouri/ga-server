// The store over local HTTP in Medplum's REST shape (/fhir/R4/<Type>[/<id>[/_history[/<vid>]]], _search, PATCH, conditional
// PUT/DELETE, history, Patient/$everything, metadata, Binary, batch and transaction),
// so a MedplumClient in another process reads and writes it. The one process that owns the SQLite file runs this.
// Every request but GET /healthz needs `Authorization: Bearer <token>` (the token file, created on first serve).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { applyPatch, getSearchParameters } from '@medplum/core';
import type { Bundle, BundleEntry, OperationOutcome, Resource } from '@medplum/fhirtypes';
import { PATIENT_COMPARTMENT_PARAMS, storedTypes } from './definitions.ts';
import { IGNORED } from './search.ts';
import { type Row, Store, StoreError, multipleMatches } from './store.ts';

// Binaries stream to disk, so their limit (serveStore's maxBinaryBytes) can be gigabytes; JSON bodies are read whole.
export const JSON_LIMIT = 16 << 20, DEFAULT_BINARY_LIMIT = 2 * 1024 ** 3;

class HttpError extends Error {
  readonly status: number;
  readonly midStream: boolean; // the body was being read: the rest is not drained, the connection is dropped
  constructor(status: number, message: string, midStream = false) { super(message); this.status = status; this.midStream = midStream; }
}

const outcome = (code: string, text: string): OperationOutcome => ({ resourceType: 'OperationOutcome', ...(code === 'not-found' && { id: 'not-found' }), issue: [{ severity: 'error', code: code as 'invalid', details: { text } }] });
const OK: OperationOutcome = { resourceType: 'OperationOutcome', id: 'ok', issue: [{ severity: 'information', code: 'informational', details: { text: 'All OK' } }] };

// The token file's contents. A missing file is created as 32 random bytes, base64url, 0600 in a 0700 dir, by linking a full temp
// file into place (link fails if another process made it first: both then read the same token). Kept 0600. An empty or short
// token is refused (an empty one would let in requests without one).
export function storeToken(file: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const read = () => { try { return readFileSync(file, 'utf8').trim(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return undefined; } };
  let text = read();
  if (text === undefined) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } finally { rmSync(tmp, { force: true }); }
    text = read() ?? '';
  }
  chmodSync(file, 0o600);
  if (text.length < 43) throw new Error(`store token in ${file} is empty or too short: delete the file and restart to make a new one`);
  return text;
}

// The request body, at most `limit` bytes (else 413), as one buffer or as a stream for Binary.
async function* limited(req: IncomingMessage, limit: number): AsyncGenerator<Uint8Array> {
  let n = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    n += chunk.length;
    if (n > limit) throw new HttpError(413, 'Request body too large', true);
    yield chunk;
  }
}
async function body(req: IncomingMessage): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const c of limited(req, JSON_LIMIT)) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}
function parse(text: string): any {
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

// types: the resource types the store accepts (default every R4 resource type).
export type ServeOptions = { file: string; host?: string; port: number; tokenFile: string; maxBinaryBytes?: number; types?: readonly string[] };

export async function serveStore(opts: ServeOptions): Promise<Server> {
  const binaryLimit = opts.maxBinaryBytes ?? DEFAULT_BINARY_LIMIT;
  let token: Buffer | undefined, store: Store | undefined;
  const server = createServer((req, res) => {
    const sock = req.socket; // req.socket is null by the time a mid-stream error is caught
    // Readiness for the compose healthcheck: no data, the one path open without the token; 503 until token and database are open.
    if (req.method === 'GET' && req.url === '/healthz') { req.resume(); res.writeHead(token && store ? 200 : 503, { 'content-length': 0 }).end(); return; }
    const given = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !store || !given || !timingSafeEqual(token, createHash('sha256').update(given).digest())) { req.resume(); res.writeHead(401, { 'content-length': 0 }).end(); return; }
    handle(store, binaryLimit, req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : e instanceof StoreError ? e.status : 500;
      if (status === 500) console.error('store server:', e);
      const text = status === 500 ? 'Internal error' : (e as Error).message;
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError && e.midStream) { res.setHeader('connection', 'close'); res.on('finish', () => sock.destroy()); }
      else req.resume(); // discard an unread body (early 413, other errors) so the client gets the response
      send(res, status, JSON.stringify(e instanceof StoreError ? e.outcome : outcome(status === 404 ? 'not-found' : status === 500 ? 'exception' : 'invalid', text)));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.host ?? '127.0.0.1', resolve); });
  // Only the process that got the port touches the token file and the database: a second server on the same port fails above first.
  try {
    token = createHash('sha256').update(storeToken(opts.tokenFile)).digest();
    store = new Store(opts.file, { types: opts.types });
  } catch (e) { server.close(); throw e; }
  server.on('close', () => store?.close());
  return server;
}

function send(res: ServerResponse, status: number, json: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/fhir+json', 'content-length': Buffer.byteLength(json), ...headers }).end(json);
}

async function handle(store: Store, binaryLimit: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://store');
  if (url.pathname !== '/fhir/R4' && !url.pathname.startsWith('/fhir/R4/')) throw new HttpError(404, `Not found: ${url.pathname}`);
  const base = `http://${req.headers.host || `127.0.0.1:${req.socket.localPort}`}/`; // next links and fullUrls point where the client reached us
  let parts: string[];
  try { parts = url.pathname.slice('/fhir/R4'.length).split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new HttpError(400, `Bad path: ${url.pathname}`); }
  const [type, id, op] = parts;
  const method = req.method ?? 'GET';
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > (type === 'Binary' ? binaryLimit : JSON_LIMIT)) throw new HttpError(413, 'Request body too large');
  if (parts.length > 4) throw new HttpError(404, `Not found: ${url.pathname}`);

  if (type === 'Binary') {
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    if (method === 'POST' && !id) {
      const { id: bid } = await store.putBinaryStream(contentType, limited(req, binaryLimit));
      return send(res, 201, JSON.stringify({ resourceType: 'Binary', id: bid, contentType }), { location: `${base}fhir/R4/Binary/${bid}` });
    }
    // Medplum replaces the bytes and keeps the Binary's id (binaries here have no versions, so no ETag either way).
    if (method === 'PUT' && id && !op) {
      await store.putBinaryStream(contentType, limited(req, binaryLimit), id, true);
      return send(res, 200, JSON.stringify({ resourceType: 'Binary', id, contentType }));
    }
    if (method === 'GET' && id && !op) {
      const b = store.openBinary(id);
      if (!b) throw new HttpError(404, `Not found: Binary/${id}`);
      // readResource asks for FHIR JSON; download asks for */* and gets the bytes.
      if (req.headers.accept?.startsWith('application/fhir+json')) return send(res, 200, JSON.stringify({ resourceType: 'Binary', id, contentType: b.contentType }));
      res.writeHead(200, { 'content-type': b.contentType, 'content-length': b.size });
      await pipeline(Readable.fromWeb(b.stream() as never), res); // a read error destroys the response, never the process
      return;
    }
    if (method === 'DELETE' && id && !op) { store.deleteBinary(id); return send(res, 200, JSON.stringify(OK)); }
    if (method === 'GET' && !id) throw new HttpError(400, 'Cannot search on Binary resource type'); // Medplum's text
    throw new HttpError(405, `${method} ${url.pathname} not supported for Binary`);
  }

  const query = url.searchParams;
  let json: unknown;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const text = await body(req);
    if (id === '_search') for (const [k, v] of new URLSearchParams(text)) query.append(k, v);
    else json = parse(text);
  }
  const a = dispatch(store, { method, parts, query, body: json, ifMatch: header(req, 'if-match'), ifNoneExist: header(req, 'if-none-exist'), base });
  const h: Record<string, string> = {};
  if (a.row) {
    h.etag = `W/"${a.row.versionId}"`;
    h['last-modified'] = new Date(a.row.lastUpdated).toUTCString();
    if (a.status === 201) h.location = `${base}fhir/R4/${a.row.type}/${a.row.id}`;
  }
  send(res, a.status, a.json ?? JSON.stringify(a.outcome ?? OK), h);
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v || undefined;
};

// One request (HTTP or a batch entry): its body parsed; id: a transaction's pre-assigned id for a POST.
type Req = { method: string; parts: string[]; query: URLSearchParams; body: unknown; ifMatch?: string; ifNoneExist?: string; base: string; id?: string };
// Its answer: a resource or Bundle as JSON text, or an OperationOutcome; row (one resource's version) gives ETag, Last-Modified,
// Location (201) and a batch entry's location.
type Answer = { status: number; json?: string; outcome?: OperationOutcome; row?: Pick<Row, 'type' | 'id' | 'versionId' | 'lastUpdated'> };

const CREATED: OperationOutcome = { resourceType: 'OperationOutcome', id: 'created', issue: [{ severity: 'information', code: 'informational', details: { text: 'Created' } }] };
const TYPE = /^[A-Z][A-Za-z]+$/;

const written = (r: Resource, status: number): Answer => ({ status, json: JSON.stringify(r), row: { type: r.resourceType, id: r.id!, versionId: r.meta!.versionId!, lastUpdated: r.meta!.lastUpdated! } });
function resourceOf(r: Req, type: string): Resource {
  const res = r.body as Resource;
  if (res?.resourceType !== type) throw new HttpError(400, `Expected a ${type}`);
  return res;
}

// Synchronous on purpose: an await inside store.transaction (a batch, a conditional write) would let another request's writes in.
function dispatch(store: Store, r: Req): Answer {
  const { method, query } = r;
  const [type, id, op, vid] = r.parts;
  if (!type) {
    if (method === 'POST') return { status: 200, json: JSON.stringify(batch(store, r.body as Bundle, r.base)) };
    throw new HttpError(405, `${method} not allowed`);
  }
  if (method === 'GET' && !id && type === 'metadata') return { status: 200, json: capability() };
  if (method === 'GET' && !id && type === '_history') return history(store, r, {});
  if (!TYPE.test(type) || type === 'Binary') throw new HttpError(type === 'Binary' ? 400 : 404, type === 'Binary' ? 'Binary is only served at Binary/<id>, not in a batch' : `Not found: ${type}`);
  if (!id) {
    if (method === 'GET') return { status: 200, json: store.searchJson(type, [...query], r.base) };
    if (method === 'POST') {
      const out = store.create(resolveRefs(store, resourceOf(r, type)), r.ifNoneExist, r.id);
      return written(out.resource, out.created ? 201 : 200);
    }
    if (method === 'PUT' || method === 'DELETE') return conditional(store, r, type);
    throw new HttpError(405, `${method} not allowed`);
  }
  if (method === 'POST' && id === '_search' && !op) return { status: 200, json: store.searchJson(type, [...query], r.base) };
  if (method === 'GET' && id === '_history' && !op) return history(store, r, { type });
  // $validate: a client can check resources before it writes them.
  if (method === 'POST' && id === '$validate' && !op) { store.validate(resourceOf(r, type)); return { status: 200, outcome: OK }; }
  if (method === 'GET' && type === 'Patient' && op === '$everything' && !vid) return everything(store, id, r);
  if (method === 'GET' && op === '_history') {
    if (!vid) return history(store, r, { type, id });
    const v = store.version(type, id, vid);
    if (!v) throw new HttpError(404, 'Not found');
    if (!v.json) throw new StoreError(410, [{ text: 'Gone' }]);
    return { status: 200, json: v.json, row: v };
  }
  if (op) throw new HttpError(404, `Not found: ${r.parts.join('/')}`);
  if (method === 'GET') {
    const row = store.readRow(type, id, true);
    if (!row) throw new HttpError(404, 'Not found'); // Medplum's text
    return { status: 200, json: row.json, row };
  }
  if (method === 'PUT') {
    const res = resourceOf(r, type);
    if (res.id !== id) throw new HttpError(400, `Expected ${type}/${id}`);
    return written(store.update(resolveRefs(store, res), r.ifMatch), 200);
  }
  if (method === 'PATCH') return written(patch(store, type, id, r), 200);
  if (method === 'DELETE') { store.delete(type, id); return { status: 200, outcome: OK }; }
  throw new HttpError(405, `${method} not allowed`);
}

// PUT/DELETE Type?query, as Medplum: no match creates (PUT) or does nothing (DELETE), one is updated or deleted, more are 412.
function conditional(store: Store, r: Req, type: string): Answer {
  const q = r.query.toString();
  if (!q) throw new HttpError(r.method === 'PUT' ? 400 : 405, `${r.method} ${type} needs a search (conditional ${r.method === 'PUT' ? 'update' : 'delete'})`);
  return store.transaction(() => {
    const found = store.find(type, q);
    if (found.length > 1) throw multipleMatches();
    if (r.method === 'DELETE') { if (found.length) store.delete(type, found[0].id!); return { status: 200, outcome: OK }; }
    const res = resourceOf(r, type);
    if (!found.length) {
      if (res.id) throw new HttpError(400, 'Cannot perform create as update with client-assigned ID');
      return written(store.create(resolveRefs(store, res), undefined, r.id).resource, 201);
    }
    if (res.id && res.id !== found[0].id) throw new HttpError(400, 'Resource ID did not match resolved ID');
    return written(store.update(resolveRefs(store, { ...res, id: found[0].id }), r.ifMatch), 200);
  });
}

// JSON Patch (RFC 6902; in a batch, a Binary holding it, as Medplum's client sends it). The result is validated and versioned
// like an update, as on Medplum.
function patchOps(body: unknown): unknown {
  const bin = body as { resourceType?: string; contentType?: string; data?: string };
  if (bin?.resourceType !== 'Binary') return body;
  if (bin.contentType !== 'application/json-patch+json') throw new HttpError(400, 'PATCH takes a JSON Patch: FHIRPath Patch is not supported');
  return parse(Buffer.from(bin.data ?? '', 'base64').toString('utf8'));
}
function patch(store: Store, type: string, id: string, r: Req): Resource {
  const ops = patchOps(r.body);
  if (!Array.isArray(ops)) throw new HttpError(400, 'PATCH takes a JSON Patch (an array of operations): FHIRPath Patch is not supported');
  // A urn reference the patch brings in names no stored record (outside a transaction, or one no entry defines). Only the
  // operations are checked: references already stored are not this request's.
  for (const op of ops as { path?: string; value?: unknown }[]) {
    if (typeof op?.value === 'string' && /(^|\/)reference$/.test(op.path ?? '') && URN.test(op.value)) throw new HttpError(400, `Reference ${op.value} matches no entry's fullUrl`);
    danglingUrn(op?.value);
  }
  return store.transaction(() => {
    const row = store.readRow(type, id, true);
    if (!row) throw new HttpError(404, 'Not found');
    const res = JSON.parse(row.json) as Resource;
    let err: Error | null | undefined;
    try { err = applyPatch(res, ops).find(Boolean); } catch (e) { err = e as Error; }
    if (err) throw new HttpError(400, err.message);
    if (res.resourceType !== type || res.id !== id) throw new HttpError(400, 'Invalid id');
    return store.update(resolveRefs(store, res), r.ifMatch);
  });
}

// Conditional references (`Patient?identifier=s|v` in a reference), resolved as Medplum does: one match is its Type/id,
// none or several is 400. shortcut: Medplum also fills `display` from the match; this store leaves it out.
function resolveRefs<T>(store: Store, v: T, path = ''): T {
  if (Array.isArray(v)) v.forEach((x, i) => resolveRefs(store, x, `${path}[${i}]`));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const m = k === 'reference' && typeof x === 'string' ? /^([A-Z][A-Za-z]+)\?(.+)$/.exec(x) : null;
      if (!m) { resolveRefs(store, x, path ? `${path}.${k}` : k); continue; }
      const found = store.find(m[1], m[2]);
      if (found.length !== 1) throw new HttpError(400, `Conditional reference '${x}' ${found.length ? 'matched multiple resources' : 'did not match any resources'}`);
      (v as Record<string, unknown>)[k] = `${m[1]}/${found[0].id}`;
    }
  }
  return v;
}

const queryOf = (r: Req, allowed: string[]): void => {
  for (const k of r.query.keys()) if (!allowed.includes(k) && !IGNORED.has(k)) throw new HttpError(400, `Unsupported parameter: ${k}`);
};
const num = (r: Req, k: string, dflt: number): number => {
  const v = r.query.get(k);
  if (v !== null && !/^\d+$/.test(v)) throw new HttpError(400, `Invalid ${k}: ${v}`);
  return v === null ? dflt : Number(v);
};
const since = (r: Req): string | undefined => {
  const v = r.query.get('_since');
  if (v === null) return undefined;
  const t = Date.parse(v);
  if (!/^\d{4}-\d\d-\d\dT/.test(v) || Number.isNaN(t)) throw new HttpError(400, `Invalid _since (an instant): ${v}`);
  return new Date(t).toISOString();
};
const links = (base: string, path: string, r: Req, count: number, offset: number, more: boolean): Bundle['link'] => {
  const at = (o?: number) => {
    const q = new URLSearchParams([...r.query].filter(([k]) => k !== '_count' && k !== '_offset'));
    q.set('_count', String(count));
    if (o) q.set('_offset', String(o));
    return `${base}fhir/R4/${path}?${q}`;
  };
  return [{ relation: 'self', url: at(offset) }, { relation: 'first', url: at() },
    ...(offset ? [{ relation: 'previous', url: at(Math.max(0, offset - count)) }] : []), ...(more ? [{ relation: 'next', url: at(offset + count) }] : [])];
};

// History newest first, as Medplum shapes it: each version as a GET of it, each delete as a DELETE answered 410. One
// resource's history has a total and no links (as Medplum); a type's and the system's (Medplum has neither) page by _offset.
function history(store: Store, r: Req, q: { type?: string; id?: string }): Answer {
  queryOf(r, ['_count', '_offset', '_since']);
  if (q.type && !storedTypes().includes(q.type)) throw new HttpError(400, `Unknown resource type: ${q.type}`);
  const count = Math.min(num(r, '_count', 100), 1000), offset = num(r, '_offset', 0), from = since(r);
  if (q.id && !store.historyTotal(q.type!, q.id)) throw new HttpError(404, 'Not found');
  const total = q.id ? store.historyTotal(q.type!, q.id, from) : undefined;
  const rows = store.history({ ...q, since: from, count: count + 1, offset });
  const entry: BundleEntry[] = rows.slice(0, count).map((x) => {
    const fullUrl = `${r.base}fhir/R4/${x.type}/${x.id}`;
    return x.json
      ? { fullUrl, request: { method: 'GET', url: `${x.type}/${x.id}/_history/${x.versionId}` }, response: { status: '200', outcome: OK }, resource: JSON.parse(x.json) }
      : { fullUrl, request: { method: 'DELETE', url: `${x.type}/${x.id}` }, response: { status: '410', outcome: new StoreError(410, [{ text: `Deleted on ${new Date(x.lastUpdated)}` }]).outcome } };
  });
  const path = [q.type, q.id, '_history'].filter(Boolean).join('/');
  return { status: 200, json: JSON.stringify({ resourceType: 'Bundle', type: 'history', ...(total !== undefined ? { total } : { link: links(r.base, path, r, count, offset, count > 0 && rows.length > count) }), entry }) };
}

// Patient/<id>/$everything as Medplum answers it: the Patient and its compartment ordered by lastUpdated (_type keeps the
// Patient, _since filters by lastUpdated), _count 1000 by default with _offset pages, then per page the records its entries
// reference that are in no Patient compartment (Practitioner, Medication, Organization...) as includes.
function everything(store: Store, pid: string, r: Req): Answer {
  queryOf(r, ['_count', '_offset', '_since', '_type']);
  if (!store.readRow('Patient', pid, true)) throw new HttpError(404, 'Not found');
  const count = Math.min(num(r, '_count', 1000), 1000), offset = num(r, '_offset', 0), from = since(r);
  const only = r.query.get('_type')?.split(',');
  if (only?.some((t) => !TYPE.test(t))) throw new HttpError(400, `Invalid _type: ${r.query.get('_type')}`);
  const types = only ? [...new Set([...only, 'Patient'])] : COMPARTMENT_TYPES;
  const P = `Patient/${pid}`;
  const rows = store.db.prepare(`select r.type, r.id, r.json from idx i join resources r on r.rid = i.rid join sortkeys s on s.rid = i.rid and s.code = '_lastUpdated'
    where i.type in (${types.map(() => '?').join(', ')}) and i.code = '_compartment' and i.val = ?${from ? ' and s.lo >= ?' : ''} order by s.lo, i.rid limit ? offset ?`)
    .all(...types, P, ...(from ? [from] : []), count + 1, offset) as { type: string; id: string; json: string }[];
  const page = rows.slice(0, count).map((x) => JSON.parse(x.json) as Resource);
  const seen = new Set(page.map((x) => `${x.resourceType}/${x.id}`));
  const included: Resource[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const m = k === 'reference' && typeof x === 'string' ? /^([A-Z][A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(x) : null;
      if (!m) { walk(x); continue; }
      if (seen.has(x as string)) continue;
      seen.add(x as string);
      const row = store.readRow(m[1], m[2]);
      const res = row && (JSON.parse(row.json) as Resource);
      // Only records in no patient's compartment (Practitioner, Organization, Medication...): this Patient's own come on
      // their pages, and another patient's (a performer or a linked Patient) never.
      if (res && !res.meta?.compartment?.some((c) => c.reference?.startsWith('Patient/'))) included.push(res);
    }
  };
  page.forEach(walk);
  const entry = [...page.map((x) => ({ x, mode: 'match' as const })), ...included.map((x) => ({ x, mode: 'include' as const }))]
    .map(({ x, mode }) => ({ fullUrl: `${r.base}fhir/R4/${x.resourceType}/${x.id}`, search: { mode }, resource: x }));
  return { status: 200, json: JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry, link: links(r.base, `Patient/${pid}/$everything`, r, count, offset, count > 0 && rows.length > count) }) };
}
const COMPARTMENT_TYPES = [...new Set(['Patient', ...Object.keys(PATIENT_COMPARTMENT_PARAMS)])];

// What this store supports, for GET metadata: its types, interactions, search parameters and operations (not Medplum's).
let capabilityJson: string | undefined;
function capability(): string {
  const versioned = ['read', 'vread', 'update', 'patch', 'delete', 'history-instance', 'history-type', 'create', 'search-type'];
  return capabilityJson ??= JSON.stringify({
    resourceType: 'CapabilityStatement', status: 'active', date: '2026-11-08', kind: 'instance', fhirVersion: '4.0.1', format: ['json'],
    patchFormat: ['application/json-patch+json'], software: { name: 'fhir-sqlite-store' }, implementation: { description: 'FHIR R4 store on SQLite' },
    rest: [{
      mode: 'server',
      interaction: [{ code: 'transaction' }, { code: 'batch' }, { code: 'history-system' }],
      operation: [{ name: 'validate', definition: 'http://hl7.org/fhir/OperationDefinition/Resource-validate' }],
      resource: storedTypes().map((type) => type === 'Binary'
        ? { type, interaction: ['read', 'create', 'update', 'delete'].map((code) => ({ code })), versioning: 'no-version', readHistory: false, updateCreate: false }
        : {
          type, interaction: versioned.map((code) => ({ code })), versioning: 'versioned', readHistory: true, updateCreate: false,
          conditionalCreate: true, conditionalUpdate: true, conditionalDelete: 'single',
          searchParam: Object.values(getSearchParameters(type) ?? {}).filter((p) => p.type !== 'composite' && p.type !== 'special').map((p) => ({ name: p.code, type: p.type })),
          ...(type === 'Patient' && { operation: [{ name: 'everything', definition: 'http://hl7.org/fhir/OperationDefinition/Patient-everything' }] }),
        }),
    }],
  });
}

const URN = /^urn:(uuid|oid):/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RANK: Record<string, number> = { DELETE: 0, POST: 1, PUT: 2, PATCH: 2 }; // then GET

// A batch (each entry on its own, in order) or a transaction (all or nothing, one SQLite transaction, entries run DELETE,
// POST, PUT/PATCH, then GET as FHIR orders them; answers in request order). Entry fullUrls that are urn:uuid or urn:oid are
// rewritten to the real Type/id anywhere in later entries' resources, as Medplum does (Medplum only for urn:uuid); a
// reference to a urn no entry defines is 400 (Medplum stores it as written). Medplum's transactions are not atomic: a
// failed entry leaves the others written; this store fails the whole transaction with that entry's status.
function batch(store: Store, b: Bundle, base: string): Bundle {
  if (b?.resourceType !== 'Bundle' || (b.type !== 'batch' && b.type !== 'transaction')) throw new HttpError(400, 'Expected a batch or transaction Bundle');
  if (b.entry !== undefined && (!Array.isArray(b.entry) || b.entry.some((e) => !e || typeof e !== 'object' || Array.isArray(e)))) throw new HttpError(400, 'Bundle.entry must be a list of entries');
  const entries = b.entry ?? [];
  const urns = new Map<string, string>(), pre = new Map<number, string>();
  // Every defined urn replaced, whole urns only (urn:oid:1.2.3 never rewrites inside urn:oid:1.2.3.4); the pattern is rebuilt
  // only when a urn was added (once per transaction after the pre-pass, unless a GET defines one).
  let re: RegExp | undefined, reSize = 0;
  const rewrite = <T>(v: T): T => {
    if (!urns.size) return v;
    if (urns.size !== reSize) {
      re = new RegExp(`(?:${[...urns.keys()].sort((x, y) => y.length - x.length).map(esc).join('|')})(?![\\w.-])`, 'g');
      reSize = urns.size;
    }
    return JSON.parse(JSON.stringify(v).replace(re!, (m) => urns.get(m)!));
  };
  // Whether any entry's body (a PATCH's operations decoded) holds this whole urn, as rewrite would replace it.
  const referenced = (urn: string): boolean => {
    const at = new RegExp(`${esc(urn)}(?![\\w.-])`);
    return entries.some((x) => { try { return at.test(JSON.stringify(x.request?.method === 'PATCH' ? patchOps(x.resource) : x.resource) ?? ''); } catch { return false; } });
  };
  const run = (i: number): BundleEntry => {
    const e = entries[i];
    const { method = '', url = '', ifMatch, ifNoneExist } = e.request ?? {};
    // A PATCH entry's operations are base64 in a Binary: decoded first, so urns inside them are rewritten too.
    const body = method === 'PATCH' ? patchOps(e.resource) : e.resource;
    const res = body && rewrite(body);
    if (res && method !== 'PATCH') danglingUrn(res); // patch() checks its operations
    const q = url.indexOf('?'), path = q < 0 ? url : url.slice(0, q);
    const parts = path.split('/');
    if (!parts[0] || parts.length > 4 || /^[a-z]+:/i.test(url)) throw new HttpError(400, `Unsupported entry url: ${url}`);
    const a = dispatch(store, { method, parts, query: new URLSearchParams(q < 0 ? '' : url.slice(q + 1)), body: res, ifMatch, ifNoneExist, base, id: pre.get(i) });
    if (e.fullUrl && URN.test(e.fullUrl) && a.row) {
      const at = `${a.row.type}/${a.row.id}`, want = urns.get(e.fullUrl);
      // An earlier entry of the transaction changed what this one matched, and entries point at the planned id.
      if (b.type === 'transaction' && want && want !== at && referenced(e.fullUrl)) throw new HttpError(400, `${e.fullUrl} resolved to ${at}, not ${want}: an earlier entry changed its match`);
      urns.set(e.fullUrl, at);
    }
    return {
      ...(a.json !== undefined && { resource: JSON.parse(a.json) }),
      response: { status: String(a.status), ...(a.row && { location: `${a.row.type}/${a.row.id}` }), outcome: a.outcome ?? (a.status === 201 ? CREATED : OK) },
    };
  };
  if (b.type === 'batch') {
    return {
      resourceType: 'Bundle', type: 'batch-response', entry: entries.map((_, i) => {
        try { return run(i); } catch (err) {
          if (!(err instanceof StoreError || err instanceof HttpError)) throw err;
          return { response: { status: String(err.status), outcome: err instanceof StoreError ? err.outcome : outcome(err.status === 404 ? 'not-found' : 'invalid', err.message) } };
        }
      }),
    };
  }
  const rank = (i: number) => RANK[entries[i].request?.method ?? ''] ?? 3;
  const order = entries.map((_, i) => i).sort((x, y) => rank(x) - rank(y));
  return {
    resourceType: 'Bundle', type: 'transaction-response', entry: store.transaction(() => {
      const out: BundleEntry[] = [];
      for (const i of order.filter((i) => rank(i) === 0)) out[i] = run(i);
      // Every create's id is known before any entry is rewritten: a POST (If-None-Exist) or conditional PUT (Type?query) keeps
      // its one match's id, else gets a pre-assigned one (each entry on its own, against the store as it is now).
      for (const i of order.filter((i) => rank(i) > 0)) {
        const { fullUrl, request } = entries[i];
        if (!fullUrl || !URN.test(fullUrl)) continue;
        const url = request?.url ?? '', q = url.indexOf('?');
        const [type, id, extra] = (q < 0 ? url : url.slice(0, q)).split('/');
        const search = id ? undefined : request?.method === 'POST' && q < 0 ? request.ifNoneExist ?? '' : request?.method === 'PUT' && q > 0 ? url.slice(q + 1) : undefined;
        if (search !== undefined) {
          const found = search ? store.find(type, search) : [];
          if (found.length > 1) throw multipleMatches();
          if (!found.length) pre.set(i, randomUUID());
          urns.set(fullUrl, `${type}/${found[0]?.id ?? pre.get(i)}`);
        } else if (request?.method === 'PUT' && id && extra === undefined && q < 0) urns.set(fullUrl, `${type}/${id}`);
      }
      for (const i of order.filter((i) => rank(i) > 0)) out[i] = run(i);
      return out;
    }),
  };
}

function danglingUrn(v: unknown): void {
  if (Array.isArray(v)) { v.forEach(danglingUrn); return; }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'reference' && typeof x === 'string' && URN.test(x)) throw new HttpError(400, `Reference ${x} matches no entry's fullUrl`);
    danglingUrn(x);
  }
}
