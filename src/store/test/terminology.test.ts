// Concept index (codes, properties, designations of stored CodeSystems), the built-in HL7 terminology seed and findTerminology.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodeSystem } from '@medplum/fhirtypes';
import { IndexFormatError, Store, StoreError } from '../store.ts';
import { findTerminology, isBuiltin, parentProperty } from '../terminology.ts';

const err = (f: () => unknown): StoreError => { try { f(); } catch (e) { return e as StoreError; } throw new Error('did not throw'); };
const cs = (o: Partial<CodeSystem> = {}): CodeSystem => ({ resourceType: 'CodeSystem', status: 'active', content: 'complete', url: 'http://example.com/cs', ...o });
const rid = (s: Store, id: string): number => (s.db.prepare("select rid from resources where type = 'CodeSystem' and id = ?").get(id) as { rid: number }).rid;
const codings = (s: Store, r: number) => s.db.prepare('select code, display, language, synonymOf is not null syn from coding where system = ? order by code, syn, display').all(r)
  .map((x) => ({ ...x }));
const count = (s: Store, type: string): number => s.search(type, [['_summary', 'count']], '').total!;

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
