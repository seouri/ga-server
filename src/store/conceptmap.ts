// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// ConceptMap: the mapping index (one row per source code and target, as Medplum's ConceptMapping and ConceptMapping_Attribute
// tables), $translate and Medplum's ConceptMap $import. Ported from Medplum 5.2.14 packages/server/src/fhir: lookups/conceptmapping.ts,
// operations/conceptmaptranslate.ts and operations/conceptmapimport.ts; the source codings are @medplum/core's indexConceptMapCodings.
// Beyond Medplum: $import rows survive an update of the ConceptMap (an update replaces only its inline rows), R4 inputs
// $translate does not implement are 400, and an other-map loop is 400.
import type { DatabaseSync } from 'node:sqlite';
import { type ConceptMapTranslateParameters, OperationOutcomeError, indexConceptMapCodings } from '@medplum/core';
import type { CodeableConcept, ConceptMap, ConceptMapGroupElementTargetDependsOn, Parameters, ParametersParameter } from '@medplum/fhirtypes';
import { type Store, StoreError } from './store.ts';
import { type Params, findTerminology, isBuiltin, paramValue, prep, refuse } from './terminology.ts';

// attributes: the mapping's property, dependsOn and product entries as JSON [{kind, uri, type, value}], type the value[x] suffix
// (Code, Coding, String); nothing searches them. imported: 1 for a $import row, which an update of the ConceptMap keeps.
export const CONCEPTMAP_SCHEMA = `
  create table if not exists concept_mapping(map integer not null, sourceSystem text, sourceCode text not null, sourceDisplay text,
    targetSystem text, targetCode text, targetDisplay text, relationship text, comment text, attributes text, imported integer not null default 0);
  create index if not exists concept_mapping_s on concept_mapping(map, sourceSystem, sourceCode);`;

type Attribute = { kind: 'property' | 'dependsOn' | 'product'; uri: string; type?: string; value?: unknown };
type Mapping = { sourceSystem?: string; sourceCode?: string; sourceDisplay?: string; targetSystem?: string; targetCode?: string; targetDisplay?: string;
  relationship?: string; comment?: string; attributes: Attribute[] };

const bad = (text: string) => new StoreError(400, [{ text }]);
const COMMENT = 'https://medplum.com/conceptmap-attribute/comment';
const NON_MATCHING = ['unmatched', 'disjoint', 'not-related-to'];

// A dependsOn or product of an inline target: a Coding when it has a system or display, else a code (Medplum's getAttributeValue).
const attributeValue = (a: ConceptMapGroupElementTargetDependsOn): Pick<Attribute, 'type' | 'value'> => a.system || a.display
  ? { type: 'Coding', value: { system: a.system, code: a.value, display: a.display } }
  : { type: 'Code', value: a.value };

function insert(db: DatabaseSync, rid: number, mappings: Mapping[], imported: 0 | 1): void {
  const q = prep(db)(`insert into concept_mapping(map, sourceSystem, sourceCode, sourceDisplay, targetSystem, targetCode, targetDisplay, relationship, comment, attributes, imported)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of mappings) {
    if (!m.sourceCode) throw bad('Source code for mapping is required');
    q.run(rid, m.sourceSystem ?? '', m.sourceCode, m.sourceDisplay ?? null, m.targetSystem ?? '', m.targetCode ?? '', m.targetDisplay ?? null,
      m.relationship === 'equivalent' ? null : m.relationship ?? null, m.comment ?? null, m.attributes.length ? JSON.stringify(m.attributes) : null, imported);
  }
}

// The inline mapping rows of ConceptMap `rid`, replaced; an element without a code is skipped (Medplum's gatherResourceMappings).
export function indexConceptMap(db: DatabaseSync, rid: number, cm: ConceptMap): void {
  prep(db)('delete from concept_mapping where map = ? and imported = 0').run(rid);
  const mappings: Mapping[] = [];
  for (const g of cm.group ?? []) {
    for (const e of g.element ?? []) {
      if (!e.code) continue;
      for (const t of e.target ?? []) {
        mappings.push({ sourceSystem: g.source, sourceCode: e.code, sourceDisplay: e.display, targetSystem: g.target, targetCode: t.code, targetDisplay: t.display,
          relationship: t.equivalence, comment: t.comment, attributes: [
            ...(t.dependsOn ?? []).map((a) => ({ kind: 'dependsOn' as const, uri: a.property, ...attributeValue(a) })),
            ...(t.product ?? []).map((a) => ({ kind: 'product' as const, uri: a.property, ...attributeValue(a) })),
          ] });
      }
    }
  }
  insert(db, rid, mappings, 0);
}

export const dropConceptMap = (db: DatabaseSync, rid: number): void => { prep(db)('delete from concept_mapping where map = ?').run(rid); };

// A parameter's value[x] as Medplum's TypedValue: the suffix (Code, Coding, String) and the value.
function typed(p?: ParametersParameter): Pick<Attribute, 'type' | 'value'> {
  for (const [k, v] of Object.entries(p ?? {})) if (k.startsWith('value')) return { type: k.slice(5), value: v };
  return {};
}

type Match = { equivalence: string; concept: { system?: string; code?: string; display?: string }; property?: Attribute[]; dependsOn?: Attribute[]; product?: Attribute[] };

// ConceptMap $translate: the map by id, `url` or `source` (the newest version); the matches of each source system's codes, else the
// group's `unmapped` (provided, fixed, other-map). result: some match that is not unmatched, disjoint or not-related-to.
export function translate(store: Store, p: Params): Parameters {
  refuse(p, '$translate', ['conceptMap', 'conceptMapVersion', 'version', 'target', 'dependency', 'reverse']);
  const cc = p.all('codeableConcept');
  if (cc.length > 1) throw bad(`Expected 0..1 value(s) for input parameter codeableConcept, but ${cc.length} provided`);
  if (cc[0] && !cc[0].valueCodeableConcept) throw bad('Complex parameter codeableConcept (CodeableConcept) cannot be passed via query string');
  const input: ConceptMapTranslateParameters = { system: p.get('system'), code: p.get('code'), coding: p.coding('coding'), codeableConcept: cc[0]?.valueCodeableConcept as CodeableConcept | undefined };
  const cm = conceptMap(store, p); // before the codings, as Medplum's handler
  let sourceCodes: Record<string, string[]>;
  try { sourceCodes = indexConceptMapCodings(input); } catch (e) {
    if (e instanceof OperationOutcomeError) throw new StoreError(400, [], e.outcome);
    throw e;
  }
  const matches = translateCodes(store, cm, sourceCodes, p.get('targetsystem'), new Set());
  return { resourceType: 'Parameters', parameter: [
    { name: 'result', valueBoolean: matches.some((m) => !NON_MATCHING.includes(m.equivalence)) },
    ...matches.map(matchParameter),
  ] };
}

function conceptMap(store: Store, p: Params): ConceptMap & { id: string } {
  const url = p.get('url'), source = p.get('source');
  if (p.id) {
    const row = store.readRow('ConceptMap', p.id, true);
    if (!row) throw new StoreError(404, [{ text: 'Not found' }]);
    return JSON.parse(row.json);
  }
  if (url) return findTerminology<ConceptMap>(store, 'ConceptMap', url);
  if (source) {
    const found = store.search('ConceptMap', [['source', source], ['_sort', '-version'], ['_count', '1']], '').entry?.[0]?.resource;
    if (!found) throw bad(`ConceptMap for source ${source} not found`);
    return found as ConceptMap & { id: string };
  }
  throw bad('No ConceptMap specified');
}

const ridOf = (store: Store, id: string) => (prep(store.db)("select rid from resources where type = 'ConceptMap' and id = ?").get(id) as { rid: number }).rid;

function translateCodes(store: Store, cm: ConceptMap & { id: string }, sourceCodes: Record<string, string[]>, targetSystem: string | undefined, seen: Set<string>): Match[] {
  seen = new Set(seen).add(cm.id); // the maps on this chain only: two branches may reach the same map
  const matches: Match[] = [];
  for (const [system, codes] of Object.entries(sourceCodes)) {
    const rows = prep(store.db)(`select targetSystem, targetCode, targetDisplay, relationship, comment, attributes from concept_mapping
      where map = ? and sourceSystem = ? and sourceCode in (select value from json_each(?))${targetSystem === undefined ? '' : ' and targetSystem = ?'} order by rowid`)
      .all(ridOf(store, cm.id), system, JSON.stringify(codes), ...(targetSystem === undefined ? [] : [targetSystem])) as Record<string, string | null>[];
    if (rows.length) {
      matches.push(...rows.map((r) => {
        const attributes = JSON.parse(r.attributes ?? '[]') as Attribute[], of = (kind: Attribute['kind']) => attributes.filter((a) => a.kind === kind);
        const property = [...(r.comment ? [{ kind: 'property' as const, uri: COMMENT, type: 'String', value: r.comment }] : []), ...of('property')];
        return { equivalence: r.relationship ?? 'equivalent', concept: { system: r.targetSystem ?? undefined, code: r.targetCode || undefined, display: r.targetDisplay ?? undefined },
          property, dependsOn: of('dependsOn'), product: of('product') };
      }).sort(byMatch));
      continue;
    }
    // Unmapped codes: the group's default, or another ConceptMap's translation (Medplum's handleUnmappedCodes).
    for (const g of cm.group?.filter((x) => x.source === system && x.unmapped) ?? []) {
      const u = g.unmapped!;
      if (u.mode === 'provided') for (const code of codes) matches.push({ concept: { system: g.target, code }, equivalence: 'equal' });
      else if (u.mode === 'fixed') matches.push({ concept: { system: g.target, code: u.code, display: u.display }, equivalence: 'equivalent' });
      else if (u.mode === 'other-map') {
        const other = findTerminology<ConceptMap>(store, 'ConceptMap', u.url!);
        if (seen.has(other.id)) throw bad(`ConceptMap ${u.url} refers back to itself through unmapped.url`);
        matches.push(...translateCodes(store, other, sourceCodes, targetSystem, seen));
      }
    }
  }
  return matches;
}

// Medplum's sortMatches: by dependsOn (attribute|value, sorted), then system|code.
function byMatch(a: Match, b: Match): number {
  const key = (m: Match) => [(m.dependsOn ?? []).map((d) => `${d.uri}|${JSON.stringify(d.value)}`).sort().join(','), `${m.concept.system ?? ''}|${m.concept.code ?? ''}`];
  const [a1, a2] = key(a), [b1, b2] = key(b);
  return a1 < b1 ? -1 : a1 > b1 ? 1 : a2 < b2 ? -1 : a2 > b2 ? 1 : 0;
}

// A match as Medplum's buildOutputParameters renders it: equivalence, concept, property, product, dependsOn.
function matchParameter(m: Match): ParametersParameter {
  const attr = (name: string, key: string) => (a: Attribute): ParametersParameter => ({ name, part: [{ name: key, valueUri: a.uri },
    ...(a.value === undefined || a.value === null ? [] : [{ name: 'value', [`value${a.type}`]: a.value }])] });
  return { name: 'match', part: [
    { name: 'equivalence', valueCode: m.equivalence },
    { name: 'concept', valueCoding: Object.fromEntries(Object.entries(m.concept).filter(([, v]) => v !== undefined)) },
    ...(m.property ?? []).map(attr('property', 'uri')),
    ...(m.product ?? []).map(attr('product', 'attribute')),
    ...(m.dependsOn ?? []).map(attr('dependsOn', 'attribute')),
  ] };
}

// Medplum's ConceptMap $import (project-admin semantics): mappings into a stored ConceptMap, by id or `url`, in one transaction;
// the answer is the ConceptMap. A built-in is 403 (the store seeds none; kept as CodeSystem $import).
export function importConceptMap(store: Store, p: Params): ConceptMap {
  const url = p.get('url');
  const mappings = p.all('mapping');
  if (!mappings.length) throw bad("Expected at least 1 value(s) for required input parameter 'mapping'");
  const rows = mappings.map((x): Mapping => {
    const part = (name: string) => x.part?.filter((y) => y.name === name) ?? [];
    const coding = (name: string) => {
      const c = part(name)[0]?.valueCoding;
      if (!c) throw bad(`Expected at least 1 value(s) for required input parameter '${name}'`);
      return c;
    };
    const source = coding('source'), target = coding('target');
    const attrs = (kind: Attribute['kind']) => part(kind).map((a): Attribute => {
      const code = paramValue(a.part?.find((y) => y.name === 'code'));
      if (!code) throw bad("Expected at least 1 value(s) for required input parameter 'code'");
      return { kind, uri: code, ...typed(a.part?.find((y) => y.name === 'value')) };
    });
    return { sourceSystem: source.system, sourceCode: source.code, sourceDisplay: source.display, targetSystem: target.system, targetCode: target.code,
      targetDisplay: target.display, relationship: paramValue(part('relationship')[0]), comment: paramValue(part('comment')[0]),
      attributes: [...attrs('property'), ...attrs('dependsOn'), ...attrs('product')] };
  });
  if (p.id && url) throw new StoreError(400, [{ text: 'Parameter `url` not permitted for instance operation', expression: ['Parameters.parameter'] }]);
  if (!p.id && !url) throw new StoreError(400, [{ text: 'ConceptMap to import into must be specified', expression: ["Parameters.parameter.where(name = 'url')"] }]);
  const cm = p.id ? conceptMap(store, p) : findTerminology<ConceptMap>(store, 'ConceptMap', url!);
  const rid = ridOf(store, cm.id);
  if (isBuiltin(store.db, rid)) throw new StoreError(403, [{ text: 'Forbidden' }]);
  store.transaction(() => insert(store.db, rid, rows, 1));
  return cm;
}
