// Concept index (codes, properties, designations of stored CodeSystems), the built-in HL7 terminology seed and findTerminology.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodeSystem, Parameters, ParametersParameter } from '@medplum/fhirtypes';
import { IndexFormatError, Store, StoreError } from '../store.ts';
import { codeSystemImport, findTerminology, isBuiltin, lookup, params, parentProperty, subsumes, validateCodeCs } from '../terminology.ts';

const err = (f: () => unknown): StoreError => { try { f(); } catch (e) { return e as StoreError; } throw new Error('did not throw'); };
const cs = (o: Partial<CodeSystem> = {}): CodeSystem => ({ resourceType: 'CodeSystem', status: 'active', content: 'complete', url: 'http://example.com/cs', ...o });
const rid = (s: Store, id: string): number => (s.db.prepare("select rid from resources where type = 'CodeSystem' and id = ?").get(id) as { rid: number }).rid;
const codings = (s: Store, r: number) => s.db.prepare('select code, display, language, synonymOf is not null syn from coding where system = ? order by code, syn, display').all(r)
  .map((x) => ({ ...x }));
const count = (s: Store, type: string): number => s.search(type, [['_summary', 'count']], '').total!;
// An operation's input as a POST Parameters body gives it.
const P = (parameter: ParametersParameter[], id?: string) => params(parameter, id);
const out = (p: Parameters, name: string) => p.parameter?.find((x) => x.name === name);
const prop = (code: string, property: string, value: string): ParametersParameter =>
  ({ name: 'property', part: [{ name: 'code', valueCode: code }, { name: 'property', valueCode: property }, { name: 'value', valueString: value }] });

describe('concept index (no built-ins)', () => {
  let dir: string, store: Store;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-term-')); store = new Store(join(dir, 'store.db'), { terminology: [] }); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('a complete CodeSystem indexes codes, nested parents and designations', () => {
    const { resource } = store.create(cs({ hierarchyMeaning: 'is-a', concept: [{
      code: 'A', display: 'Alpha', designation: [{ language: 'fr', value: 'Alpha (fr)' }],
      concept: [{ code: 'B', display: 'Beta' }],
    }] }));
    const r = rid(store, resource.id!);
    expect(codings(store, r)).toEqual([
      { code: 'A', display: 'Alpha', language: null, syn: 0 },
      { code: 'A', display: 'Alpha (fr)', language: 'fr', syn: 1 },
      { code: 'B', display: 'Beta', language: null, syn: 0 },
    ]);
    const parent = store.db.prepare(`select c.code, p.code prop, p.uri, cp.value, t.code target from coding_property cp join coding c on c.id = cp.coding
      join codesystem_property p on p.id = cp.property left join coding t on t.id = cp.target where c.system = ?`).all(r).map((x) => ({ ...x }));
    expect(parent).toEqual([{ code: 'B', prop: 'is-a', uri: 'http://hl7.org/fhir/concept-properties#parent', value: 'A', target: 'A' }]);
  });

  it('example and fragment CodeSystems are indexed; not-present is not', () => {
    for (const content of ['example', 'fragment', 'not-present'] as const) {
      const { resource } = store.create(cs({ url: `http://example.com/${content}`, content, concept: [{ code: 'X' }] }));
      expect(codings(store, rid(store, resource.id!)).length, content).toBe(content === 'not-present' ? 0 : 1);
    }
  });

  it('update replaces concept rows; delete removes them', () => {
    const { resource } = store.create(cs({ property: [{ code: 'p', type: 'string' }], concept: [{ code: 'A', property: [{ code: 'p', valueString: 'a' }] }, { code: 'B' }] }));
    const r = rid(store, resource.id!);
    store.update({ ...resource, concept: [{ code: 'A' }] } as CodeSystem);
    expect(codings(store, r).map((c) => c.code)).toEqual(['A']);
    expect(store.db.prepare('select count(*) n from coding_property cp join coding c on c.id = cp.coding where c.system = ?').get(r)).toEqual({ n: 0 });
    store.delete('CodeSystem', resource.id!);
    for (const t of ['coding where system', 'codesystem_property where system']) expect(store.db.prepare(`select count(*) n from ${t} = ?`).get(r)).toEqual({ n: 0 });
  });

  it('an undeclared property is 400 and nothing is written', () => {
    const e = err(() => store.create(cs({ concept: [{ code: 'A', property: [{ code: 'nope', valueString: 'x' }] }] })));
    expect([e.status, e.outcome.issue?.[0]?.details?.text]).toEqual([400, 'Unknown property: nope']); // Medplum's text
    expect(count(store, 'CodeSystem')).toBe(0);
  });

  it('findTerminology orders stored before built-in, then content, version, date, id', () => {
    store.create(cs({ content: 'example', version: '9' }));
    const complete = store.create(cs({ content: 'complete', version: '1' })).resource;
    expect(findTerminology(store, 'CodeSystem', 'http://example.com/cs').id).toBe(complete.id);
    const v2 = store.create(cs({ content: 'complete', version: '2' })).resource;
    expect(findTerminology(store, 'CodeSystem', 'http://example.com/cs').id).toBe(v2.id);
    const noVersion = store.create(cs({ content: 'complete', date: '2020-01-01' })).resource; // missing version ranks first
    expect(findTerminology(store, 'CodeSystem', 'http://example.com/cs').id).toBe(noVersion.id);
    const newer = store.create(cs({ content: 'complete', date: '2024-01-01' })).resource;
    expect(findTerminology(store, 'CodeSystem', 'http://example.com/cs').id).toBe(newer.id);
  });

  it('findTerminology skips retired and is 400 when nothing matches', () => {
    store.create(cs({ status: 'retired' }));
    for (const url of ['http://none', 'http://example.com/cs']) {
      const e = err(() => findTerminology(store, 'CodeSystem', url));
      expect([e.status, e.outcome.issue?.[0]?.details?.text]).toEqual([400, `CodeSystem ${url} not found`]);
    }
    store.create({ resourceType: 'ValueSet', status: 'active', url: 'http://example.com/vs' });
    expect(findTerminology(store, 'ValueSet', 'http://example.com/vs').url).toBe('http://example.com/vs');
  });

  it('findTerminology honours url|version', () => {
    const v1 = store.create(cs({ version: '1' })).resource;
    store.create(cs({ version: '2' }));
    expect(findTerminology(store, 'CodeSystem', 'http://example.com/cs|1').id).toBe(v1.id);
    expect(findTerminology(store, 'CodeSystem', 'http://example.com/cs', '1').id).toBe(v1.id);
    expect(err(() => findTerminology(store, 'CodeSystem', 'http://example.com/cs|3')).status).toBe(400);
  });

  it('parentProperty: the declared parent property, else the implicit one; 400 without an is-a hierarchy', () => {
    expect(parentProperty(cs({ hierarchyMeaning: 'is-a' }))).toEqual({ code: 'is-a', uri: 'http://hl7.org/fhir/concept-properties#parent', type: 'code' });
    const declared = { code: 'up', uri: 'http://hl7.org/fhir/concept-properties#parent', type: 'code' as const };
    expect(parentProperty(cs({ hierarchyMeaning: 'is-a', property: [declared] }))).toEqual(declared);
    const e = err(() => parentProperty(cs({ hierarchyMeaning: 'part-of' })));
    expect([e.status, e.outcome.issue?.[0]?.details?.text]).toEqual([400, 'Invalid filter: CodeSystem http://example.com/cs does not have an is-a hierarchy']);
  });

  it('cyclic is-a parents end', () => {
    const { resource } = store.create(cs({ hierarchyMeaning: 'is-a', property: [{ code: 'parent', uri: 'http://hl7.org/fhir/concept-properties#parent', type: 'code' }],
      concept: [{ code: 'A', property: [{ code: 'parent', valueCode: 'B' }] }, { code: 'B', property: [{ code: 'parent', valueCode: 'A' }] }, { code: 'C' }] }));
    const run = (a: string, b: string) => out(subsumes(store, P([{ name: 'codeA', valueCode: a }, { name: 'codeB', valueCode: b }], resource.id)), 'outcome')?.valueCode;
    expect([run('A', 'B'), run('A', 'C'), run('C', 'C')]).toEqual(['equivalent', 'not-subsumed', 'equivalent']);
  });

  it('$subsumes: subsumes, subsumed-by, by system; 400 without codes or an is-a hierarchy', () => {
    store.create(cs({ hierarchyMeaning: 'is-a', concept: [{ code: 'P', concept: [{ code: 'C', concept: [{ code: 'G' }] }] }, { code: 'X' }] }));
    const run = (a: string, b: string) => out(subsumes(store, P([{ name: 'system', valueUri: 'http://example.com/cs' }, { name: 'codeA', valueCode: a }, { name: 'codeB', valueCode: b }])), 'outcome')?.valueCode;
    expect([run('P', 'G'), run('G', 'P'), run('G', 'X')]).toEqual(['subsumes', 'subsumed-by', 'not-subsumed']);
    expect(err(() => subsumes(store, P([{ name: 'system', valueUri: 'http://example.com/cs' }, { name: 'codeA', valueCode: 'P' }]))).outcome.issue?.[0]?.details?.text)
      .toBe('Must specify codeA and codeB parameters');
    expect(err(() => subsumes(store, P([{ name: 'codeA', valueCode: 'P' }, { name: 'codeB', valueCode: 'P' }]))).outcome.issue?.[0]?.details?.text).toBe('No code system specified');
    store.create(cs({ url: 'http://example.com/flat', concept: [{ code: 'A' }] }));
    expect(err(() => subsumes(store, P([{ name: 'system', valueUri: 'http://example.com/flat' }, { name: 'codeA', valueCode: 'A' }, { name: 'codeB', valueCode: 'A' }]))).status).toBe(400);
  });

  it('$lookup by system and code returns name, display, designations and properties', () => {
    const { resource } = store.create(cs({ title: 'T', hierarchyMeaning: 'is-a', property: [{ code: 'rank', type: 'integer', description: 'Rank' }, { code: 'abstract', type: 'boolean' }],
      concept: [{ code: 'P', display: 'Parent', concept: [{ code: 'C', display: 'Child', designation: [{ language: 'fr', value: 'Enfant' }, { value: 'Kid' }],
        property: [{ code: 'abstract', valueBoolean: true }] }] }] }));
    codeSystemImport(store, P([prop('C', 'rank', '7')], resource.id));
    const r = lookup(store, P([{ name: 'system', valueUri: 'http://example.com/cs' }, { name: 'code', valueCode: 'C' }]));
    expect(r.parameter).toEqual([
      { name: 'name', valueString: 'T' },
      { name: 'display', valueString: 'Child' },
      { name: 'designation', part: [{ name: 'language', valueCode: 'fr' }, { name: 'value', valueString: 'Enfant' }] },
      { name: 'designation', part: [{ name: 'value', valueString: 'Kid' }] },
      { name: 'property', part: [{ name: 'code', valueCode: 'abstract' }, { name: 'value', valueBoolean: true }] },
      { name: 'property', part: [{ name: 'code', valueCode: 'is-a' }, { name: 'value', valueCode: 'P' }, { name: 'description', valueString: 'Parent' }] },
      { name: 'property', part: [{ name: 'code', valueCode: 'rank' }, { name: 'value', valueInteger: 7 }, { name: 'description', valueString: 'Rank' }] },
    ]);
    const status = (f: () => unknown) => { const e = err(f); return [e.status, e.outcome.issue?.[0]?.details?.text]; };
    expect(status(() => lookup(store, P([{ name: 'system', valueUri: 'http://example.com/cs' }, { name: 'code', valueCode: 'nope' }])))).toEqual([404, 'Not found']);
    expect(status(() => lookup(store, P([{ name: 'code', valueCode: 'C' }])))).toEqual([400, 'No code system specified']);
    expect(status(() => lookup(store, P([{ name: 'system', valueUri: 'http://example.com/cs' }])))).toEqual([400, 'No coding specified']);
    expect(status(() => lookup(store, P([{ name: 'coding', valueCoding: { system: 'http://other' , code: 'C' } }], resource.id)))).toEqual([404, 'Not found']);
    expect(status(() => lookup(store, P([{ name: 'system', valueUri: 'http://example.com/cs' }, { name: 'code', valueCode: 'C' }, { name: 'date', valueDateTime: '2020' }]))))
      .toEqual([400, '$lookup: parameter date is not supported']);
  });

  it('$lookup and $validate-code honour url|version', () => {
    store.create(cs({ version: '1', concept: [{ code: 'A', display: 'One' }] }));
    store.create(cs({ version: '2', concept: [{ code: 'A', display: 'Two' }] }));
    expect(out(lookup(store, P([{ name: 'system', valueUri: 'http://example.com/cs|1' }, { name: 'code', valueCode: 'A' }])), 'display')?.valueString).toBe('One');
    expect(validateCodeCs(store, P([{ name: 'url', valueUri: 'http://example.com/cs|1' }, { name: 'code', valueCode: 'A' }])).parameter)
      .toEqual([{ name: 'result', valueBoolean: true }, { name: 'display', valueString: 'One' }]);
  });

  it('$validate-code: by url, coding, id, displayLanguage; falls back to the system url', () => {
    const { resource } = store.create(cs({ concept: [{ code: 'A', display: 'Alpha', designation: [{ language: 'fr', value: 'Alpha (fr)' }] }] }));
    const v = (ps: ParametersParameter[], id?: string) => validateCodeCs(store, P(ps, id)).parameter;
    expect(v([{ name: 'url', valueUri: 'http://example.com/cs' }, { name: 'code', valueCode: 'A' }])).toEqual([{ name: 'result', valueBoolean: true }, { name: 'display', valueString: 'Alpha' }]);
    expect(v([{ name: 'url', valueUri: 'http://example.com/cs' }, { name: 'code', valueCode: 'B' }])).toEqual([{ name: 'result', valueBoolean: false }]);
    expect(v([{ name: 'coding', valueCoding: { code: 'A' } }, { name: 'displayLanguage', valueCode: 'fr' }], resource.id)).toEqual([{ name: 'result', valueBoolean: true }, { name: 'display', valueString: 'Alpha (fr)' }]);
    expect(v([{ name: 'coding', valueCoding: { code: 'A' } }, { name: 'displayLanguage', valueCode: 'de' }], resource.id)).toEqual([{ name: 'result', valueBoolean: false }]);
    expect(v([{ name: 'url', valueUri: 'incorrect' }, { name: 'code', valueCode: 'A' }], resource.id)).toEqual([{ name: 'result', valueBoolean: false }]);
    expect(v([{ name: 'coding', valueCoding: { system: 'http://unknown', code: 'A' } }])).toEqual([{ name: 'result', valueBoolean: true }]);
    expect(v([{ name: 'url', valueUri: 'http://other' }, { name: 'coding', valueCoding: { system: 'http://unknown', code: 'A' } }])).toEqual([{ name: 'result', valueBoolean: false }]);
    expect(err(() => v([{ name: 'code', valueCode: 'A' }])).outcome.issue?.[0]?.details?.text).toBe('No code system specified');
    expect(err(() => v([{ name: 'url', valueUri: 'http://example.com/cs' }, { name: 'code', valueCode: 'A' }, { name: 'display', valueString: 'x' }])).outcome.issue?.[0]?.details?.text)
      .toBe('$validate-code: parameter display is not supported');
  });

  it('$import adds concepts and properties to a stored CodeSystem; an unknown code rolls back; the CodeSystem is returned', () => {
    const { resource } = store.create(cs({ content: 'not-present', hierarchyMeaning: 'is-a', property: [{ code: 'parent', uri: 'http://hl7.org/fhir/concept-properties#parent', type: 'code' }] }));
    const r = rid(store, resource.id!);
    const res = codeSystemImport(store, P([{ name: 'system', valueUri: 'http://example.com/cs' }, { name: 'concept', valueCoding: { code: 'A', display: 'Alpha' } },
      { name: 'concept', valueCoding: { code: 'B', display: 'Beta' } }, prop('B', 'parent', 'A'),
      { name: 'designation', part: [{ name: 'code', valueCode: 'A' }, { name: 'language', valueCode: 'fr' }, { name: 'value', valueString: 'Alpha (fr)' }] }]));
    expect(res).toEqual(resource);
    expect(codings(store, r).map((c) => `${c.code}:${c.display}`)).toEqual(['A:Alpha', 'A:Alpha (fr)', 'B:Beta']);
    expect(out(subsumes(store, P([{ name: 'codeA', valueCode: 'A' }, { name: 'codeB', valueCode: 'B' }], resource.id)), 'outcome')?.valueCode).toBe('subsumes');
    const e = err(() => codeSystemImport(store, P([{ name: 'concept', valueCoding: { code: 'Z' } }, prop('nope', 'parent', 'A')], resource.id)));
    expect([e.status, e.outcome.issue?.[0]?.details?.text]).toEqual([400, 'Unknown code: http://example.com/cs|nope']);
    expect(codings(store, r).map((c) => c.code)).not.toContain('Z');
    const many = Array.from({ length: 1001 }, (_, i) => ({ name: 'concept', valueCoding: { code: `${i}` } }));
    expect(err(() => codeSystemImport(store, P(many, resource.id))).outcome.issue?.[0]?.details?.text).toBe('Expected 0..1000 value(s) for input parameter concept, but 1001 provided');
    expect(err(() => codeSystemImport(store, P([{ name: 'concept', valueCoding: { code: 'A' } }]))).outcome.issue?.[0]?.details?.text).toBe('No code system specified');
    // an update of a CodeSystem whose content is not indexed keeps the imported concepts, as Medplum
    store.update({ ...resource, title: 'renamed' } as CodeSystem);
    expect(codings(store, r).map((c) => c.code)).toEqual(['A', 'A', 'B']);
  });

  it('old index version is refused', () => {
    const file = join(dir, 'old.db');
    new Store(file, { terminology: [] }).close();
    const raw = new DatabaseSync(file);
    raw.exec('pragma user_version = 4');
    raw.close();
    expect(() => new Store(file, { terminology: [] })).toThrow(IndexFormatError);
  });
});

describe('built-in terminology', () => {
  let dir: string, store: Store;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'store-term-seed-')); store = new Store(join(dir, 'store.db')); }, 120_000);
  afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('seed: totals, read-only, stable ids', () => {
    expect(count(store, 'CodeSystem')).toBe(1108);
    expect(count(store, 'ValueSet')).toBe(1346);
    const v3 = findTerminology<CodeSystem>(store, 'CodeSystem', 'http://terminology.hl7.org/CodeSystem/v3-ActCode');
    expect(isBuiltin(store.db, rid(store, v3.id))).toBe(true);
    expect(v3.text).toBeUndefined(); // as Medplum's seed: no narrative
    expect((store.db.prepare('select count(*) n from coding where system = ?').get(rid(store, v3.id)) as { n: number }).n).toBeGreaterThan(100);
    expect(store.history({ type: 'CodeSystem' })).toEqual([]); // built-ins have no history rows
    for (const f of [() => store.update({ ...v3, status: 'retired' }), () => store.delete('CodeSystem', v3.id), () => store.put({ ...v3 })]) {
      const e = err(f);
      expect([e.status, e.outcome.issue?.[0]?.code, e.outcome.issue?.[0]?.details?.text]).toEqual([403, 'forbidden', 'Forbidden']);
    }
    const marker = store.db.prepare("select value from meta where key = 'terminology'").get();
    store.close();
    store = new Store(join(dir, 'store.db'));
    expect(store.db.prepare("select value from meta where key = 'terminology'").get()).toEqual(marker);
    expect(findTerminology(store, 'CodeSystem', 'http://terminology.hl7.org/CodeSystem/v3-ActCode').id).toBe(v3.id);
    expect(v3.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // a later entry with the same url replaces the earlier one (v2-0360 is in v2-tables twice: 2.3.1, then 2.7)
    expect(findTerminology<CodeSystem>(store, 'CodeSystem', 'http://terminology.hl7.org/CodeSystem/v2-0360').version).toBe('2.7');
  });

  it('a stored CodeSystem with a built-in url is found first', () => {
    const url = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
    const mine = store.create(cs({ url, content: 'example', concept: [{ code: 'X' }] })).resource;
    try {
      expect(findTerminology(store, 'CodeSystem', url).id).toBe(mine.id);
    } finally { store.delete('CodeSystem', mine.id!); }
  });

  it('$subsumes over a built-in: v3-RoleCode', () => {
    const run = (a: string, b: string) => out(subsumes(store, P([{ name: 'system', valueUri: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode' },
      { name: 'codeA', valueCode: a }, { name: 'codeB', valueCode: b }])), 'outcome')?.valueCode;
    expect([run('SIB', 'ITWINBRO'), run('WIFE', 'SIGOTHR'), run('INLAW', 'INLAW'), run('BRO', 'VET')]).toEqual(['subsumes', 'subsumed-by', 'equivalent', 'not-subsumed']);
  });

  it('$import into a built-in is 403, by id and by system url', () => {
    const url = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', v3 = findTerminology<CodeSystem>(store, 'CodeSystem', url);
    const concept = { name: 'concept', valueCoding: { code: 'ZZ-injected' } };
    for (const p of [P([concept], v3.id), P([{ name: 'system', valueUri: url }, concept])]) {
      const e = err(() => codeSystemImport(store, p));
      expect([e.status, e.outcome.issue?.[0]?.code, e.outcome.issue?.[0]?.details?.text]).toEqual([403, 'forbidden', 'Forbidden']);
    }
    expect(store.db.prepare("select count(*) n from coding where code = 'ZZ-injected'").get()).toEqual({ n: 0 });
    // a stored CodeSystem with that url is the one written
    const mine = store.create(cs({ url, content: 'not-present' })).resource;
    try {
      codeSystemImport(store, P([{ name: 'system', valueUri: url }, concept]));
      expect(store.db.prepare("select system from coding where code = 'ZZ-injected'").get()).toEqual({ system: rid(store, mine.id!) });
    } finally { store.delete('CodeSystem', mine.id!); }
  });

  it('interrupted seed leaves no built-ins and the next open seeds', () => {
    const d = mkdtempSync(join(tmpdir(), 'store-term-int-'));
    try {
      const file = join(d, 'store.db');
      expect(() => new Store(file, { terminology: ['fhir/r4/valuesets-medplum.json', 'fhir/r4/no-such-file.json'] })).toThrow(/no-such-file/);
      const raw = new DatabaseSync(file);
      expect(raw.prepare('select (select count(*) from builtin) b, (select count(*) from resources) r, (select count(*) from meta) m').get()).toEqual({ b: 0, r: 0, m: 0 });
      raw.close();
      const s = new Store(file);
      try { expect([count(s, 'CodeSystem'), count(s, 'ValueSet')]).toEqual([1108, 1346]); } finally { s.close(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);
});
