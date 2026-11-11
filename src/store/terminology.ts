// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// Terminology: the concept index of stored CodeSystems (codes, properties, designations as rows, as Medplum's Coding,
// Coding_Property and CodeSystem_Property tables), the built-in HL7 terminology (seeded once, read-only) and findTerminology.
// Ported from Medplum 5.2.14 packages/server/src/fhir: lookups/coding.ts (which concepts become rows),
// operations/codesystemimport.ts (importCodeSystem), operations/utils/terminology.ts (findTerminologyResource's ordering,
// getParentProperty, findAncestor) and operations/rebuild-base-definitions.ts (the seed; a later entry replaces an earlier one by url);
// the operations from operations/codesystemlookup.ts, codesystemvalidatecode.ts, subsumes.ts, codesystemimport.ts and
// utils/parameters.ts (parseInputParameters' cardinality texts).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { TERMINOLOGY_BUNDLE_FILES } from '@medplum/definitions';
import type {
  Bundle, CodeSystem, CodeSystemConcept, CodeSystemConceptProperty, CodeSystemProperty, Coding, ConceptMap, Parameters, ParametersParameter, ValueSet,
} from '@medplum/fhirtypes';
import { storedTypes } from './definitions.ts';
import { writeIndex } from './search.ts';
import { type Store, StoreError } from './store.ts';

export const TERMINOLOGY_SCHEMA = `
  create table if not exists coding(id integer primary key, system integer not null, code text not null, display text, language text, synonymOf integer,
    unique(system, code, language, display));
  create table if not exists coding_property(coding integer not null, property integer not null, value text, target integer);
  create unique index if not exists coding_property_c on coding_property(coding, property, value); -- (coding, property) lookups; one row per value
  create index if not exists coding_property_t on coding_property(target, property);
  create table if not exists codesystem_property(id integer primary key, system integer not null, code text not null, uri text, type text, description text,
    unique(system, code));
  create table if not exists builtin(rid integer primary key);
  create table if not exists meta(key text primary key, value text);`;

export const PARENT = 'http://hl7.org/fhir/concept-properties#parent';
const SYNONYM = 'http://hl7.org/fhir/concept-properties#synonym';
const INDEXED = new Set(['complete', 'example', 'fragment']); // Medplum's CodingTable: the content modes whose concepts are rows

// Not @medplum/definitions' readJson (see definitions.ts); its file names start at dist/ (fhir/r4/...).
const DIST = new URL('../', import.meta.resolve('@medplum/definitions'));
const readJson = (f: string) => JSON.parse(readFileSync(new URL(f, DIST), 'utf8'));
const DEFINITIONS_VERSION = JSON.parse(readFileSync(new URL('../package.json', DIST), 'utf8')).version as string;

// Prepared statements per database, by SQL.
const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
export const prep = (db: DatabaseSync) => (sql: string): StatementSync => {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = db.prepare(sql)));
  return st;
};

export type ImportedProperty = { code: string; property: string; value: string };
export type Designation = { code: string; language?: string; value: string };

// The concept rows of CodeSystem `rid`, replaced (an update drops the old rows first).
// Other content modes keep their rows (concepts $import wrote), as Medplum's CodingTable.
export function indexCodeSystem(db: DatabaseSync, rid: number, cs: CodeSystem): void {
  if (!INDEXED.has(cs.content)) return;
  dropCodeSystem(db, rid);
  const concepts: { code: string; display?: string }[] = [], properties: ImportedProperty[] = [], designations: Designation[] = [];
  const parentCode = cs.property?.find((p) => p.uri === PARENT)?.code ?? cs.hierarchyMeaning ?? 'parent';
  const add = (c: CodeSystemConcept): void => {
    concepts.push({ code: c.code, display: c.display });
    for (const p of c.property ?? []) properties.push({ code: c.code, property: p.code, value: propertyValue(p) });
    for (const child of c.concept ?? []) {
      add(child);
      properties.push({ code: child.code, property: parentCode, value: c.code }); // a nested concept's implicit parent
    }
    for (const d of c.designation ?? []) designations.push({ code: c.code, language: d.language, value: d.value });
  };
  for (const c of cs.concept ?? []) add(c);
  importCodeSystem(db, rid, cs, concepts, properties, designations);
}

function propertyValue(p: CodeSystemConceptProperty): string {
  if (p.valueBoolean !== undefined) return p.valueBoolean ? 'true' : 'false';
  return p.valueCode ?? p.valueString ?? '';
}

// Medplum's importCodeSystem: codes (one row per code, display updated), then properties (a code-valued one points at its
// target coding; a synonym property is also a synonym row), then designations (synonym rows). 400 for an unknown code or property.
export function importCodeSystem(db: DatabaseSync, rid: number, cs: CodeSystem, concepts: { code?: string; display?: string }[] = [],
  properties: ImportedProperty[] = [], designations: Designation[] = []): void {
  const q = prep(db);
  const find = (code: string) => (q('select id from coding where system = ? and code = ? and synonymOf is null').get(rid, code) as { id: number } | undefined)?.id;
  for (const c of new Map(concepts.map((c) => [c.code as string, c])).values()) { // the last of a repeated code wins, as Medplum's uniqueOn
    const display = c.display?.normalize('NFC') ?? null, id = find(c.code!);
    if (id) q('update coding set display = ? where id = ?').run(display, id);
    else q('insert into coding(system, code, display) values (?, ?, ?)').run(rid, c.code!, display);
  }
  const props = new Map<string, { id: number; prop: CodeSystemProperty }>();
  const resolve = (code: string) => {
    let p = props.get(code);
    if (p) return p;
    let prop = cs.property?.find((x) => x.code === code);
    if (!prop) {
      if (code === cs.hierarchyMeaning || (code === 'parent' && !cs.hierarchyMeaning)) prop = { code, uri: PARENT, type: 'code' };
      else throw new StoreError(400, [{ text: `Unknown property: ${code}` }]);
    }
    q('insert or ignore into codesystem_property(system, code, uri, type, description) values (?, ?, ?, ?, ?)').run(rid, code, prop.uri ?? null, prop.type ?? null, prop.description ?? null);
    p = { id: (q('select id from codesystem_property where system = ? and code = ?').get(rid, code) as { id: number }).id, prop };
    props.set(code, p);
    return p;
  };
  const source = (code: string) => find(code) ?? (() => { throw new StoreError(400, [{ text: `Unknown code: ${cs.url}|${code}` }]); })();
  for (const p of properties) resolve(p.property); // every property resolves before any row is written, as Medplum
  for (const ip of properties) {
    const { id, prop } = resolve(ip.property), from = source(ip.code);
    q('insert or ignore into coding_property(coding, property, value, target) values (?, ?, ?, ?)').run(from, id, ip.value, prop.type === 'code' ? find(ip.value) ?? null : null);
    if (prop.uri === SYNONYM) q('insert or ignore into coding(system, code, display, synonymOf) values (?, ?, ?, ?)').run(rid, ip.code, ip.value.normalize('NFC'), from);
  }
  for (const d of designations) {
    q('insert or ignore into coding(system, code, display, language, synonymOf) values (?, ?, ?, ?, ?)').run(rid, d.code, d.value.normalize('NFC'), d.language ?? null, source(d.code));
  }
}

export function dropCodeSystem(db: DatabaseSync, rid: number): void {
  const q = prep(db);
  q('delete from coding_property where coding in (select id from coding where system = ?)').run(rid);
  q('delete from coding where system = ?').run(rid);
  q('delete from codesystem_property where system = ?').run(rid);
}

export const isBuiltin = (db: DatabaseSync, rid: number): boolean => !!prep(db)('select 1 from builtin where rid = ?').get(rid);

// A built-in's id: sha1(type|url|version) as a UUID, so a reseed keeps it.
const stableId = (type: string, url: string, version = ''): string => {
  const h = createHash('sha1').update(`${type}|${url}|${version}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// Seeds the built-in CodeSystems and ValueSets of `files` (default: Medplum's terminology bundles) once: only when the store's
// types include CodeSystem or ValueSet, and only when the marker in `meta` differs. One transaction: a seed that stops part way
// leaves none. Built-ins are resources with a `builtin` row and no history; writes to them are 403 (store.ts). files: [] seeds nothing.
export function seedTerminology(store: Store, files: readonly string[] = TERMINOLOGY_BUNDLE_FILES): void {
  const types = storedTypes().filter((t) => t === 'CodeSystem' || t === 'ValueSet');
  if (!types.length || !files.length) return;
  const marker = files === TERMINOLOGY_BUNDLE_FILES ? DEFINITIONS_VERSION : `${DEFINITIONS_VERSION} ${files.join(',')}`;
  const db = store.db, q = prep(db);
  if ((q("select value from meta where key = 'terminology'").get() as { value: string } | undefined)?.value === marker) return;
  const drop = (rid: number) => {
    q('delete from resources where rid = ?').run(rid);
    writeIndex(q, rid, undefined);
    dropCodeSystem(db, rid);
    q('delete from builtin where rid = ?').run(rid);
  };
  store.transaction(() => {
    for (const { rid } of q('select rid from builtin').all() as { rid: number }[]) drop(rid);
    const seen = new Map<string, number>(); // type|url -> rid: a later entry replaces it, as Medplum's replaceExisting
    const lastUpdated = new Date().toISOString();
    for (const f of files) {
      for (const e of (readJson(f) as Bundle<CodeSystem | ValueSet>).entry ?? []) { // one file at a time, let go after its loop
        const r = e.resource;
        if (!r?.url || !types.includes(r.resourceType)) continue;
        const key = `${r.resourceType}|${r.url}`, old = seen.get(key);
        if (old !== undefined) drop(old);
        // As Medplum's cleanSeedResource: no narrative.
        const out = { ...r, id: stableId(r.resourceType, r.url, r.version), text: undefined, meta: { ...r.meta, versionId: randomUUID(), lastUpdated } };
        const { rid } = q('insert into resources(type, id, versionId, lastUpdated, json) values (?, ?, ?, ?, ?) returning rid')
          .get(out.resourceType, out.id, out.meta.versionId, lastUpdated, JSON.stringify(out)) as { rid: number };
        writeIndex(q, rid, out);
        if (out.resourceType === 'CodeSystem') indexCodeSystem(db, rid, out);
        q('insert into builtin(rid) values (?)').run(rid);
        seen.set(key, rid);
      }
    }
    q("insert into meta(key, value) values ('terminology', ?) on conflict(key) do update set value = excluded.value").run(marker);
  });
}

const CONTENT_RANK: Record<string, number> = { complete: 0, supplement: 1, fragment: 2, example: 3, 'not-present': 4 };
const contentRank = (r: CodeSystem | ValueSet | ConceptMap) => r.resourceType === 'CodeSystem' && r.content ? CONTENT_RANK[r.content] ?? Number.MAX_SAFE_INTEGER : 0;
const descending = (a?: string, b?: string) => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : b.localeCompare(a));

// The resource an operation uses for `url` (`url|version` selects that version; Medplum 5.2.14 drops it): not retired; stored
// before built-in, then CodeSystem content complete < supplement < fragment < example < not-present, version descending
// (missing first), date descending (missing first), id. 400 `<type> <url> not found` (Medplum's text) when none matches.
export function findTerminology<T extends CodeSystem | ValueSet | ConceptMap>(store: Store, type: T['resourceType'], url: string, version?: string): T & { id: string } {
  if (!url) throw new StoreError(400, [{ text: `${type} not specified` }]);
  const bar = url.lastIndexOf('|');
  if (bar > 0) { version ??= url.slice(bar + 1); url = url.slice(0, bar); }
  const rows = prep(store.db)(`select r.json, b.rid is not null builtin from resources r left join builtin b on b.rid = r.rid
    where r.rid in (select rid from idx where type = ? and code = 'url' and val = ?)`).all(type, url) as { json: string; builtin: number }[];
  const found = rows.map((r) => ({ builtin: r.builtin, r: JSON.parse(r.json) as T & { id: string } }))
    .filter(({ r }) => r.url === url && r.status !== 'retired' && (!version || r.version === version))
    .sort((a, b) => a.builtin - b.builtin || contentRank(a.r) - contentRank(b.r) || descending(a.r.version, b.r.version) || descending(a.r.date, b.r.date) || a.r.id.localeCompare(b.r.id));
  if (!found.length) throw new StoreError(400, [{ text: `${type} ${url} not found` }]);
  return found[0].r;
}

// Medplum's getParentProperty: the CodeSystem's parent property (declared, else implicit); 400 without an is-a hierarchy.
export function parentProperty(cs: CodeSystem): CodeSystemProperty {
  if (cs.hierarchyMeaning !== 'is-a') throw new StoreError(400, [{ text: `Invalid filter: CodeSystem ${cs.url} does not have an is-a hierarchy` }]);
  return cs.property?.find((p) => p.uri === PARENT) ?? { code: cs.hierarchyMeaning, uri: PARENT, type: 'code' };
}

// An operation's input: `id` for an instance-level call; get/coding read one value (more than one is 400, as Medplum's
// parseInputParameters), all reads every one. Built from a POST Parameters body, or from a GET query (each value a valueString:
// fromQuery makes a Coding parameter 400, as Medplum).
export type Params = { id?: string; get(name: string): string | undefined; coding(name: string): Coding | undefined; all(name: string): ParametersParameter[] };

const bad = (text: string) => new StoreError(400, [{ text }]);
// A parameter's primitive value, whatever its value[x] type.
export const paramValue = (p?: ParametersParameter): string | undefined => {
  for (const [k, v] of Object.entries(p ?? {})) if (k.startsWith('value') && ['string', 'number', 'boolean'].includes(typeof v)) return String(v);
  return undefined;
};

export function params(parameter: ParametersParameter[] = [], id?: string, fromQuery = false): Params {
  const all = (name: string) => parameter.filter((x) => x.name === name);
  const one = (name: string) => {
    const v = all(name);
    if (v.length > 1) throw bad(`Expected 0..1 value(s) for input parameter ${name}, but ${v.length} provided`);
    return v[0];
  };
  return {
    id, all, get: (name) => paramValue(one(name)),
    coding(name) {
      const v = one(name);
      if (v && fromQuery) throw bad(`Complex parameter ${name} (Coding) cannot be passed via query string`);
      return v?.valueCoding;
    },
  };
}

// Inputs R4 defines that these operations do not implement (Medplum ignores them): 400 naming the first one given.
const refuse = (p: Params, op: string, names: string[]): void => {
  const n = names.find((x) => p.all(x).length);
  if (n) throw bad(`${op}: parameter ${n} is not supported`);
};
const notFound = () => new StoreError(404, [{ text: 'Not found' }]);
const bare = (url: string) => url.replace(/\|[^|]*$/, ''); // url|version without the version (findTerminology reads it)

// The operation's CodeSystem: CodeSystem/<id> (404 Not found, 410 if deleted), else findTerminology's choice for the url.
function codeSystem(store: Store, p: Params, url?: string, version?: string): { rid: number; cs: CodeSystem & { id: string } } {
  const id = p.id ?? findTerminology<CodeSystem>(store, 'CodeSystem', url!, version).id;
  const row = prep(store.db)("select rid, json from resources where type = 'CodeSystem' and id = ?").get(id) as { rid: number; json: string } | undefined;
  if (!row) { store.readRow('CodeSystem', id, true); throw notFound(); }
  return { rid: row.rid, cs: JSON.parse(row.json) };
}

const TRUE = ['true', 't', '1'], FALSE = ['false', 'f', '0'];
// A property row's value as its declared type (Medplum's toTypedValue); a boolean that is neither is a server error, as Medplum.
function typedValue(value: string, type: string | null): ParametersParameter {
  if (type === 'boolean') {
    const v = value.toLowerCase();
    if (!TRUE.includes(v) && !FALSE.includes(v)) throw new Error(`Invalid value for boolean property: ${value}`);
    return { name: 'value', valueBoolean: TRUE.includes(v) };
  }
  if (type === 'integer') return { name: 'value', valueInteger: Number.parseInt(value, 10) };
  if (type === 'decimal') return { name: 'value', valueDecimal: Number.parseFloat(value) };
  const t = type ?? 'string';
  return { name: 'value', [`value${t[0].toUpperCase()}${t.slice(1)}`]: value };
}

// CodeSystem $lookup: name, display, designations (synonym rows), then properties (a code-valued one described by its
// target's display). The CodeSystem by id, `system` (with `version`) or the coding's system; 404 when the code is not in it.
export function lookup(store: Store, p: Params): Parameters {
  refuse(p, '$lookup', ['date', 'displayLanguage', 'property']);
  const system = p.get('system'), given = p.coding('coding'), code = p.get('code'), url = system ?? given?.system;
  if (!p.id && !url) throw bad('No code system specified');
  const { rid, cs } = codeSystem(store, p, url, p.get('version'));
  let coding: Coding;
  if (given) {
    if (!given.code) throw bad('No code specified');
    coding = given;
  } else if (code) coding = { system: system ? bare(system) : cs.url, code };
  else throw bad('No coding specified');
  if (coding.system && coding.system !== cs.url) throw notFound();
  const rows = prep(store.db)(`select c.display, c.synonymOf, c.language, p.code, p.type, p.description, cp.value, t.display targetDisplay
    from coding c left join coding_property cp on cp.coding = c.id left join codesystem_property p on p.id = cp.property left join coding t on t.id = cp.target
    where c.system = ? and c.code = ? order by c.id, cp.rowid`).all(rid, coding.code!) as Record<string, string | null>[];
  if (!rows.length) throw notFound();
  const out: ParametersParameter[] = [], name = cs.title ?? cs.name ?? cs.url, display = rows.find((r) => !r.synonymOf)?.display;
  if (name) out.push({ name: 'name', valueString: name });
  if (display) out.push({ name: 'display', valueString: display });
  for (const r of rows) {
    if (r.synonymOf) out.push({ name: 'designation', part: [...(r.language ? [{ name: 'language', valueCode: r.language }] : []), { name: 'value', valueString: r.display! }] });
  }
  for (const r of rows) {
    if (r.synonymOf || !r.code || !r.value) continue;
    const description = r.targetDisplay ?? r.description;
    out.push({ name: 'property', part: [{ name: 'code', valueCode: r.code }, typedValue(r.value, r.type), ...(description ? [{ name: 'description', valueString: description }] : [])] });
  }
  return { resourceType: 'Parameters', parameter: out };
}

// CodeSystem $validate-code: result (and the display: the coding's own, else the code's, in `displayLanguage` when given). A url
// no CodeSystem has is checked against the coding's system only, as Medplum.
export function validateCodeCs(store: Store, p: Params): Parameters {
  refuse(p, '$validate-code', ['codeSystem', 'codeableConcept', 'date', 'abstract', 'display']);
  const given = p.coding('coding'), code = p.get('code'), url = p.get('url') ?? given?.system, language = p.get('displayLanguage');
  let target: ReturnType<typeof codeSystem> | undefined;
  if (p.id) target = codeSystem(store, p);
  else if (url) {
    try { target = codeSystem(store, p, url, p.get('version')); } catch (e) { if (!(e instanceof StoreError && e.status === 400)) throw e; }
  }
  if (!target && !url) throw bad('No code system specified');
  let coding: Coding;
  if (given) coding = given;
  else if (code) coding = { system: url ? bare(url) : target!.cs.url, code };
  else throw bad('No coding specified');
  let found: Coding | undefined;
  if (!target) found = coding.system === bare(url!) ? coding : undefined;
  else if (coding.code && (!coding.system || coding.system === target.cs.url)) {
    const row = prep(store.db)(`select display from coding where system = ? and code = ? and ${language ? 'language = ?' : 'synonymOf is null'} limit 1`)
      .get(target.rid, coding.code, ...(language ? [language] : [])) as { display: string | null } | undefined;
    if (row) found = { ...coding, display: coding.display ?? row.display ?? undefined };
  }
  return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: !!found }, ...(found?.display ? [{ name: 'display', valueString: found.display }] : [])] };
}

export type Arg = string | number | null;
// The is-a walk over parent property `prop` of CodeSystem `rid`, from the rows of `code`, as a CTE `walk` of coding rows: 'up'
// to the ancestors (from a row or the canonical row of a synonym), 'down' to the descendants (Medplum's findAncestor and
// addDescendants). `union` drops rows already seen, so a cycle ends. The caller appends the select over `walk`.
export function hierarchy(dir: 'up' | 'down', rid: number, prop: number, code: string): { sql: string; args: Arg[] } {
  const [on, to] = dir === 'up' ? ['cp.coding = walk.id or cp.coding = walk.synonymOf', 'cp.target'] : ['cp.target = walk.id', 'cp.coding'];
  return {
    sql: `with recursive walk as (select * from coding where system = ? and code = ?
      union select c.* from walk join coding_property cp on ${on} join coding c on c.id = ${to} where cp.property = ? and c.system = ?)`,
    args: [rid, code, prop, rid],
  };
}

// CodeSystem $subsumes over the is-a parent property: the walk up from each code (hierarchy). A code subsumes itself (equivalent).
export function subsumes(store: Store, p: Params): Parameters {
  refuse(p, '$subsumes', ['codingA', 'codingB']);
  const system = p.get('system');
  if (!p.id && !system) throw bad('No code system specified');
  const { rid, cs } = codeSystem(store, p, system, p.get('version'));
  const a = p.get('codeA'), b = p.get('codeB');
  if (!a || !b) throw bad('Must specify codeA and codeB parameters');
  const parent = parentProperty(cs);
  const prop = (prep(store.db)('select id from codesystem_property where system = ? and code = ?').get(rid, parent.code) as { id: number } | undefined)?.id;
  const under = (base: string, ancestor: string) => {
    if (prop === undefined) return false;
    const up = hierarchy('up', rid, prop, base);
    return !!prep(store.db)(`${up.sql} select 1 from walk where code = ? limit 1`).get(...up.args, ancestor);
  };
  const subsumedBy = under(a, b), subsumesB = under(b, a);
  const outcome = subsumedBy && subsumesB ? 'equivalent' : subsumesB ? 'subsumes' : subsumedBy ? 'subsumed-by' : 'not-subsumed';
  return { resourceType: 'Parameters', parameter: [{ name: 'outcome', valueCode: outcome }] };
}

// Medplum's CodeSystem $import (project-admin semantics): concepts, properties and designations into a stored CodeSystem,
// by id or `system`, in one transaction; the answer is the CodeSystem. A built-in is 403, as Medplum answers a project admin
// by id (by url Medplum finds only the project's own and answers 400 not found).
export function codeSystemImport(store: Store, p: Params): CodeSystem {
  const many = (name: string) => {
    const v = p.all(name);
    if (v.length > 1000) throw bad(`Expected 0..1000 value(s) for input parameter ${name}, but ${v.length} provided`);
    return v;
  };
  const part = (x: ParametersParameter, name: string, required = true) => {
    const v = paramValue(x.part?.find((y) => y.name === name));
    if (v === undefined && required) throw bad(`Expected 1 value(s) for input parameter ${name}, but 0 provided`);
    return v;
  };
  const concepts = many('concept').map((x) => {
    if (!x.valueCoding?.code) throw bad('Expected a concept Coding with a code');
    return x.valueCoding;
  });
  const properties = many('property').map((x) => ({ code: part(x, 'code')!, property: part(x, 'property')!, value: part(x, 'value')! }));
  const designations = many('designation').map((x) => ({ code: part(x, 'code')!, language: part(x, 'language', false), value: part(x, 'value')! }));
  const system = p.get('system');
  if (!p.id && !system) throw bad('No code system specified');
  const { rid, cs } = codeSystem(store, p, system);
  if (isBuiltin(store.db, rid)) throw new StoreError(403, [{ text: 'Forbidden' }]);
  store.transaction(() => importCodeSystem(store.db, rid, cs, concepts, properties, designations));
  return cs;
}
