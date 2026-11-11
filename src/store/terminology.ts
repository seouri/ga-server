// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// Terminology: the concept index of stored CodeSystems (codes, properties, designations as rows, as Medplum's Coding,
// Coding_Property and CodeSystem_Property tables), the built-in HL7 terminology (seeded once, read-only) and findTerminology.
// Ported from Medplum 5.2.14 packages/server/src/fhir: lookups/coding.ts (which concepts become rows),
// operations/codesystemimport.ts (importCodeSystem), operations/utils/terminology.ts (findTerminologyResource's ordering,
// getParentProperty) and operations/rebuild-base-definitions.ts (the seed; a later entry replaces an earlier one by url).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { TERMINOLOGY_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, CodeSystem, CodeSystemConcept, CodeSystemConceptProperty, CodeSystemProperty, ConceptMap, ValueSet } from '@medplum/fhirtypes';
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
const prep = (db: DatabaseSync) => (sql: string): StatementSync => {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = db.prepare(sql)));
  return st;
};

export type ImportedProperty = { code: string; property: string; value: string };
export type Designation = { code: string; language?: string; value: string };

// The concept rows of CodeSystem `rid`, replaced (an update drops the old rows first).
export function indexCodeSystem(db: DatabaseSync, rid: number, cs: CodeSystem): void {
  dropCodeSystem(db, rid);
  if (!INDEXED.has(cs.content)) return;
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
