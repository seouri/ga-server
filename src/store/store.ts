// A FHIR store on node:sqlite: current versions, history for every type (a delete is a history row with empty json, as
// Medplum keeps one), server-set metadata as Medplum sets it (ids, versionId, lastUpdated, meta.compartment), If-Match /
// If-None-Exist, offline validation, search (search.ts).
import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  MEDPLUM_VERSION, OperationOutcomeError, convertToSearchableReferences, deepEquals, evalFhirPathTyped, getParsedExpressionForResourceType, getSearchParameters,
  stringify, toTypedValue, validateResource,
} from '@medplum/core';
import type { Bundle, CodeSystem, ConceptMap, OperationOutcome, OperationOutcomeIssue, Resource } from '@medplum/fhirtypes';
import { PATIENT_COMPARTMENT_PARAMS, loadDefinitions } from './definitions.ts';
import { SEARCH_SCHEMA, SearchError, searchJson, writeIndex } from './search.ts';
import { inValueSet, subsumedCodes } from './expand.ts';
import { CONCEPTMAP_SCHEMA, dropConceptMap, indexConceptMap } from './conceptmap.ts';
import { DEFINITIONS_VERSION, TERMINOLOGY_SCHEMA, dropCodeSystem, indexCodeSystem, seedTerminology } from './terminology.ts';

export type StoreIssue = { expression?: string[]; text: string };

// An OperationOutcomeError (so clients read it as they read Medplum's) with an HTTP status.
export class StoreError extends OperationOutcomeError {
  readonly status: 400 | 403 | 404 | 409 | 410 | 412;
  constructor(status: 400 | 403 | 404 | 409 | 410 | 412, issues: StoreIssue[], outcome?: OperationOutcome) {
    const id = { 400: undefined, 403: 'forbidden', 404: 'not-found', 409: 'conflict', 410: 'gone', 412: 'precondition-failed' }[status];
    const code = { 400: 'invalid', 403: 'forbidden', 404: 'not-found', 409: 'conflict', 410: 'deleted', 412: 'processing' }[status] as OperationOutcomeIssue['code'];
    super(outcome ?? { resourceType: 'OperationOutcome', id, issue: issues.map((i) => ({ severity: 'error', code, details: { text: i.text }, expression: i.expression })) });
    this.status = status;
  }
}

// Medplum's answer when a conditional request matches more than one resource.
export const multipleMatches = () => new StoreError(412, [], { resourceType: 'OperationOutcome', id: 'multiple-matches',
  issue: [{ severity: 'error', code: 'multiple-matches', details: { text: 'Multiple resources found matching condition' } }] });

export const INDEX_VERSION = 5;
// The file was written in another search index format: it must be rebuilt (re-imported) before this version can open it.
export class IndexFormatError extends Error {}
export type Row = { type: string; id: string; versionId: string; lastUpdated: string; json: string }; // json '': a delete
type Meta = NonNullable<Resource['meta']>;
const now = () => new Date().toISOString();
const etag = (v: string) => v.replace(/^W\//, '').replace(/"/g, '');
// Empty strings, arrays and objects dropped by Medplum's own stringify (identifier: [] is no identifier; a null array item
// stays, so a parallel _x array stays aligned). An empty array item ('' or {}) is 400 first, as Medplum (R4 JSON has no empty values).
const prune = (r: Resource): Resource => {
  const issues = emptyItems(r, r.resourceType);
  if (issues.length) throw new StoreError(400, issues, { resourceType: 'OperationOutcome', issue: issues.map((i) => ({ severity: 'error', code: 'structure', details: { text: i.text }, expression: i.expression })) });
  return JSON.parse(stringify(r));
};
function emptyItems(v: unknown, path: string, out: StoreIssue[] = []): StoreIssue[] {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      if (typeof x === 'string' && !x.trim()) out.push({ expression: [`${path}[${i}]`], text: 'String must contain non-whitespace content' });
      else if (x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length) out.push({ expression: [`${path}[${i}]`], text: 'Invalid empty non-primitive value' });
      else emptyItems(x, `${path}[${i}]`, out);
    });
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) emptyItems(x, `${path}.${k}`, out); // _given: [{}] is dropped, as Medplum
  return out;
}
// Equality for "not modified": everything but the server-set metadata.
const content = (r: Resource) => ({ ...r, meta: { ...r.meta, versionId: undefined, lastUpdated: undefined, compartment: undefined } });

export class Store {
  readonly db: DatabaseSync;
  private readonly binDir: string;

  // types: the resource types this store accepts (default every R4 resource type); one set per process (definitions.ts).
  // terminology: the built-in terminology bundles to seed (terminology.ts; default Medplum's five, [] none).
  constructor(file: string, opts: { types?: readonly string[]; terminology?: readonly string[] } = {}) {
    loadDefinitions(opts.types);
    this.db = new DatabaseSync(file);
    this.binDir = join(dirname(file), 'binary');
    if (existsSync(this.binDir)) for (const f of readdirSync(this.binDir)) if (/^\..*\.tmp$/.test(f)) rmSync(join(this.binDir, f), { force: true }); // stale temps from a crash
    // Memory beats speed: a bounded page cache and no mmap (mapped pages count as resident).
    this.db.exec(`pragma journal_mode=wal; pragma busy_timeout=5000; pragma mmap_size=0; pragma cache_size=-${64 * 1024};
      create table if not exists resources(rid integer primary key, type text not null, id text not null, versionId text, lastUpdated text, json text not null, unique(type, id));
      create index if not exists resources_lu on resources(type, lastUpdated);
      create table if not exists history(type text not null, id text not null, versionId text not null, lastUpdated text, json text not null, unique(type, id, versionId));
      create table if not exists binaries(id text primary key, contentType text not null, size integer not null);
      create index if not exists history_i on history(type, id, lastUpdated);
      create index if not exists history_lu on history(lastUpdated);${SEARCH_SCHEMA}${TERMINOLOGY_SCHEMA}${CONCEPTMAP_SCHEMA}`);
    // The search index format (token rows as written since 2): a file written in another format would answer searches wrongly.
    const v = (this.db.prepare('pragma user_version').get() as { user_version: number }).user_version;
    if (v !== INDEX_VERSION) {
      const empty = !(this.db.prepare('select 1 from resources limit 1').get());
      if (v !== 0 || !empty) {
        this.db.close();
        throw new IndexFormatError(`FHIR store ${file} has search index format ${v}, this version needs ${INDEX_VERSION}: rebuild the file from its source`);
      }
      this.db.exec(`pragma user_version = ${INDEX_VERSION}`);
    }
    // Index rows come from @medplum/core's FHIRPath and @medplum/definitions' search parameters: after either package changes
    // (or when the file does not say which wrote it), every resource is indexed again, in one transaction.
    const deps = `@medplum/core ${MEDPLUM_VERSION}, @medplum/definitions ${DEFINITIONS_VERSION}`;
    if ((this.prep("select value from meta where key = 'index'").get() as { value: string } | undefined)?.value !== deps) {
      try {
        this.transaction(() => {
          this.db.exec('delete from idx; delete from comp; delete from sortkeys; delete from idx_text');
          for (const { rid, json } of this.prep('select rid, json from resources').iterate() as Iterable<{ rid: number; json: string }>) writeIndex(this.prep, rid, JSON.parse(json));
          this.prep("insert or replace into meta values ('index', ?)").run(deps);
        });
      } catch (e) { this.db.close(); throw e; }
    }
    try { seedTerminology(this, opts.terminology); } catch (e) { this.db.close(); throw e; }
  }

  // A built-in (seeded terminology) is read-only: 403 Forbidden, as Medplum answers a write to its R4 project's resources.
  private guard(type: string, id?: string): void {
    if (id && this.prep('select 1 from resources r join builtin b on b.rid = r.rid where r.type = ? and r.id = ?').get(type, id)) {
      throw new StoreError(403, [{ text: 'Forbidden' }]);
    }
  }

  private stmts = new Map<string, StatementSync>();
  // Prepared statements by SQL; search shapes vary, so the cache is dropped when it grows past 500.
  private readonly prep = (sql: string): StatementSync => {
    let st = this.stmts.get(sql);
    if (!st) {
      if (this.stmts.size >= 500) this.stmts.clear();
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  };

  // FHIR search: a searchset Bundle (search.ts); type an array: a system-level search across those types (_type). Unsupported
  // features and unknown parameters are StoreError 400.
  search(type: string | string[], query: [string, string][], base: string): Bundle { return JSON.parse(this.searchJson(type, query, base)); }

  // The same search as JSON text, each resource spliced in as stored (no parse and re-stringify), for the HTTP server.
  searchJson(type: string | string[], query: [string, string][], base: string): string {
    try {
      return searchJson(this.prep, type, query, base, { inValueSet: (url) => inValueSet(this, url), subsumed: (system, code, dir) => subsumedCodes(this, system, code, dir) });
    } catch (e) {
      if (e instanceof SearchError) throw new StoreError(400, [{ text: e.text }]);
      // SQLite's limits on one statement (expression depth, parser recursion): a value list too long, not a server fault.
      if ((e as { code?: string }).code === 'ERR_SQLITE_ERROR' && /Expression tree is too large|Recursion limit|too many SQL variables/.test((e as Error).message)) throw new StoreError(400, [{ text: 'Search has too many values' }]);
      throw e;
    }
  }

  close(): void { this.db.close(); }

  // Binaries are files under <db dir>/binary (0600 in a 0700 dir), written outside SQLite transactions (a rollback after a
  // put leaves an orphan file unless the caller deletes it, as the HTTP server does for a refused bundle; nothing sweeps them). The stream goes to a temp file, fsynced and renamed into place, then the
  // row (content type, size) is inserted, so a row never points at a missing file; any failure removes both file names.
  // id: only the migration passes one (Medplum's Binary id, so attachment urls keep pointing at it).
  private binPath(id: string): string { return join(this.binDir, id); }
  // replace: new bytes for the existing Binary `id` (PUT Binary/<id>), renamed over its file.
  async putBinaryStream(contentType: string, data: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>, id?: string, replace = false): Promise<{ id: string }> {
    if (!replace) this.checkBinaryId(id);
    else if (!id || !this.openBinary(id)) throw new StoreError(404, [{ text: `Not found: Binary/${id}` }]);
    mkdirSync(this.binDir, { recursive: true, mode: 0o700 });
    const tmp = join(this.binDir, `.${randomUUID()}.tmp`), bid = id ?? randomUUID();
    try {
      await pipeline(data instanceof ReadableStream ? Readable.fromWeb(data as never) : Readable.from(data), createWriteStream(tmp, { mode: 0o600 }));
      const fd = openSync(tmp, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const size = statSync(tmp).size;
      renameSync(tmp, this.binPath(bid));
      const dfd = openSync(this.binDir, 'r'); // the rename itself survives a crash only once the directory is synced
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
      this.prep('insert into binaries(id, contentType, size) values(?,?,?) on conflict(id) do update set contentType = excluded.contentType, size = excluded.size').run(bid, contentType, size);
      return { id: bid };
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!replace) rmSync(this.binPath(bid), { force: true }); // a failed replace keeps the file it may have renamed in
      throw e;
    }
  }

  // A given id must be a uuid (it names the file) not already stored (the rename would replace that file).
  private checkBinaryId(id?: string): void {
    if (id === undefined) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new StoreError(400, [{ text: `Binary id must be a uuid: ${id}` }]);
    if (this.openBinary(id)) throw new StoreError(409, [{ text: `Binary/${id} already exists` }]);
  }

  openBinary(id: string): { contentType: string; size: number; stream(): ReadableStream<Uint8Array> } | undefined {
    const row = this.prep('select contentType, size from binaries where id = ?').get(id) as { contentType: string; size: number } | undefined;
    return row && { ...row, stream: () => Readable.toWeb(createReadStream(this.binPath(id))) as ReadableStream<Uint8Array> };
  }

  // Row first, then the file: a failed unlink leaves an orphan file, never a row without one.
  deleteBinary(id: string): void {
    if (!this.prep('delete from binaries where id = ? returning id').get(id)) throw new StoreError(404, [{ text: `Not found: Binary/${id}` }]);
    rmSync(this.binPath(id), { force: true });
  }

  private depth = 0;

  // BEGIN IMMEDIATE takes the write lock up front; a transaction inside one is a savepoint, so a failed inner write
  // (caught by the caller) rolls back only itself.
  transaction<T>(fn: () => T): T {
    const sp = `sp_${this.depth}`, nested = this.db.isTransaction;
    this.db.exec(nested ? `savepoint ${sp}` : 'begin immediate');
    this.depth++;
    try {
      const v = fn();
      this.db.exec(nested ? `release ${sp}` : 'commit');
      return v;
    } catch (e) {
      try { this.db.exec(nested ? `rollback to ${sp}; release ${sp}` : 'rollback'); } catch { /* keep the original error */ }
      throw e;
    } finally { this.depth--; }
  }

  read(type: string, id: string): Resource | undefined {
    const row = this.readRow(type, id);
    return row && JSON.parse(row.json);
  }

  // The current version as stored (JSON text, not parsed), or undefined; a deleted resource is a StoreError 410 when `gone`.
  readRow(type: string, id: string, gone = false): Row | undefined {
    const row = this.prep('select type, id, versionId, lastUpdated, json from resources where type = ? and id = ?').get(type, id) as Row | undefined;
    if (!row && gone && this.prep('select 1 from history where type = ? and id = ? limit 1').get(type, id)) throw new StoreError(410, [{ text: 'Gone' }]);
    return row;
  }

  // One version (vread) by its versionId: a direct index lookup.
  version(type: string, id: string, versionId: string): Row | undefined {
    return this.prep('select type, id, versionId, lastUpdated, json from history where type = ? and id = ? and versionId = ?').get(type, id, versionId) as Row | undefined;
  }

  // id: a transaction's pre-assigned id for a urn:uuid entry.
  create(r: Resource, ifNoneExist?: string, id: string = randomUUID()): { resource: Resource; created: boolean } {
    return this.transaction(() => {
      if (ifNoneExist) {
        const found = this.find(r.resourceType, ifNoneExist);
        if (found.length > 1) throw multipleMatches();
        if (found.length) return { resource: found[0], created: false };
      }
      return { resource: this.write(prune({ ...r, id }), { versionId: randomUUID(), lastUpdated: now() }), created: true };
    });
  }

  update(r: Resource, ifMatch?: string): Resource {
    r = prune(r);
    return this.transaction(() => {
      this.guard(r.resourceType, r.id);
      const old = r.id ? this.readRow(r.resourceType, r.id, true) : undefined;
      if (!old) throw new StoreError(404, [{ text: `Not found: ${r.resourceType}/${r.id}` }]);
      if (ifMatch && etag(ifMatch) !== old.versionId) throw new StoreError(412, [{ text: 'Precondition Failed' }]);
      // The request's meta wins (as Medplum): a write that drops a tag clears it. Server fields are set by write().
      const prev = JSON.parse(old.json) as Resource;
      if (deepEquals(content(r), content(prev))) return prev; // Medplum keeps the version of an unchanged update
      return this.write(r, { versionId: randomUUID(), lastUpdated: now() });
    });
  }

  // Deleting a deleted resource changes nothing (as Medplum); a delete leaves a history row with empty json. ifMatch: the
  // current versionId, else 412 (a deleted resource has none, as Medplum).
  delete(type: string, id: string, ifMatch?: string): void {
    this.transaction(() => {
      this.guard(type, id);
      if (ifMatch && this.readRow(type, id)?.versionId !== etag(ifMatch) && this.prep('select 1 from history where type = ? and id = ? limit 1').get(type, id)) {
        throw new StoreError(412, [{ text: 'Precondition Failed' }]);
      }
      const row = this.prep('delete from resources where type = ? and id = ? returning rid').get(type, id) as { rid: number } | undefined;
      if (!row) {
        try { this.readRow(type, id, true); } catch { return; } // gone already
        throw new StoreError(404, [{ text: `Not found: ${type}/${id}` }]);
      }
      writeIndex(this.prep, row.rid, undefined);
      if (type === 'CodeSystem') dropCodeSystem(this.db, row.rid);
      if (type === 'ConceptMap') dropConceptMap(this.db, row.rid);
      this.prep('insert into history values (?, ?, ?, ?, ?)').run(type, id, randomUUID(), now(), '');
    });
  }

  // History rows, newest first: one resource's (type and id), a type's, or every type's; since: lastUpdated at or after.
  history(q: { type?: string; id?: string; since?: string; count?: number; offset?: number }): Row[] {
    const where = [q.type && 'type = ?', q.id && 'id = ?', q.since && 'lastUpdated >= ?'].filter(Boolean).join(' and ') || '1';
    const args = [q.type, q.id, q.since].filter((x) => x) as string[];
    return this.prep(`select type, id, versionId, lastUpdated, json from history where ${where} order by lastUpdated desc, rowid desc limit ? offset ?`)
      .all(...args, q.count ?? 100, q.offset ?? 0) as Row[];
  }

  historyTotal(type: string, id: string, since?: string): number {
    return (this.prep(`select count(*) n from history where type = ? and id = ?${since ? ' and lastUpdated >= ?' : ''}`).get(type, id, ...(since ? [since] : [])) as { n: number }).n;
  }

  // Migration import: keeps the given id, versionId and lastUpdated (and older versions in `history`, written as given);
  // validates the current version and recomputes its compartment, so the migration can compare it with Medplum's.
  put(r: Resource, opts: { history?: Resource[] } = {}): Resource {
    if (!r.id || !r.meta?.versionId || !r.meta.lastUpdated) throw new StoreError(400, [{ text: 'put needs id, meta.versionId and meta.lastUpdated' }]);
    return this.transaction(() => {
      this.guard(r.resourceType, r.id);
      const out = this.write(r, { versionId: r.meta!.versionId!, lastUpdated: r.meta!.lastUpdated! });
      for (const h of opts.history ?? []) this.addHistory(h); // after write: the current version's row is the stored one
      return out;
    });
  }

  // Resources of `type` matching a search query (If-None-Exist, conditional update/delete, conditional references): two tell
  // "more than one". The query must hold a real criterion: one that only pages, sorts, shapes or formats would match every
  // resource (a conditional delete of everything), so it is 400; an empty value (code=) is no criterion.
  find(type: string, query: string): Resource[] {
    const q = [...new URLSearchParams(query)].filter(([k, v]) => !['_count', '_format', '_pretty'].includes(k) && v !== '');
    const bad = q.find(([k]) => /^_(offset|sort|include|revinclude|summary|elements|fields|total|cursor|contained|containedType)(:|$)/.test(k));
    if (bad) throw new StoreError(400, [{ text: `${bad[0]} is not a search criterion: a conditional request needs criteria (${query})` }]);
    if (!q.length) throw new StoreError(400, [{ text: `A conditional request needs search criteria: ${query || '(none)'}` }]);
    return (this.search(type, [...q, ['_count', '2']], '').entry ?? []).filter((e) => e.search?.mode === 'match').map((e) => e.resource!);
  }

  private write(r: Resource, stamp: Pick<Meta, 'versionId' | 'lastUpdated'>): Resource {
    // meta.deleted is Medplum's tombstone flag, not R4: a submitted one is dropped, as Medplum does.
    const { compartment: _c, deleted: _d, ...meta } = (r.meta ?? {}) as Meta & { deleted?: boolean };
    const out = { ...r, meta: { ...meta, ...stamp } } as Resource;
    const compartment = this.compartment(out);
    if (compartment.length) out.meta!.compartment = compartment.map((reference) => ({ reference }));
    this.validate(out);
    const json = JSON.stringify(out);
    const { rid } = this.prep(`insert into resources(type, id, versionId, lastUpdated, json) values (?, ?, ?, ?, ?)
      on conflict(type, id) do update set versionId = excluded.versionId, lastUpdated = excluded.lastUpdated, json = excluded.json returning rid`)
      .get(out.resourceType, out.id!, stamp.versionId!, stamp.lastUpdated!, json) as { rid: number };
    this.addHistory(out, json);
    writeIndex(this.prep, rid, out);
    if (out.resourceType === 'CodeSystem') indexCodeSystem(this.db, rid, out as CodeSystem);
    if (out.resourceType === 'ConceptMap') indexConceptMap(this.db, rid, out as ConceptMap);
    return out;
  }

  private addHistory(r: Resource, json = JSON.stringify(r)): void {
    this.prep('insert or ignore into history values (?, ?, ?, ?, ?)').run(r.resourceType, r.id!, r.meta?.versionId ?? null, r.meta?.lastUpdated ?? null, json);
  }

  // Patient references of the type's Patient CompartmentDefinition params (a Patient is in its own compartment), as Medplum stores them.
  private compartment(r: Resource): string[] {
    const refs = new Set<string>(r.resourceType === 'Patient' ? [`Patient/${r.id}`] : []);
    const params = getSearchParameters(r.resourceType) ?? {};
    for (const code of PATIENT_COMPARTMENT_PARAMS[r.resourceType] ?? []) {
      const expr = params[code]?.expression;
      if (!expr) continue;
      const v = evalFhirPathTyped(getParsedExpressionForResourceType(r.resourceType, expr), [toTypedValue(r)]);
      for (const ref of convertToSearchableReferences(v)) if (ref.startsWith('Patient/')) refs.add(ref);
    }
    return [...refs];
  }

  validate(r: Resource): void {
    let issues: OperationOutcomeIssue[];
    try { issues = validateResource(r); } catch (e) {
      if (!(e instanceof OperationOutcomeError)) throw e;
      issues = e.outcome.issue ?? [];
    }
    const errors = issues.filter((i) => i.severity === 'error' || i.severity === 'fatal');
    if (errors.length) {
      throw new StoreError(400, errors.map((i) => ({ expression: i.expression, text: i.details?.text ?? i.diagnostics ?? i.code })),
        { resourceType: 'OperationOutcome', issue: errors });
    }
  }
}
