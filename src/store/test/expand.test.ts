// ValueSet $expand, ValueSet $validate-code and the membership subqueries the search modifiers use (expand.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeSystem, ValueSet } from '@medplum/fhirtypes';
import { Store, StoreError } from '../store.ts';
import { collationKey, expandValueSet, inValueSet, strictWordSimilarity, subsumedCodes, validateCodeVs } from '../expand.ts';
import { findTerminology, params } from '../terminology.ts';

const err = (f: () => unknown): StoreError => { try { f(); } catch (e) { return e as StoreError; } throw new Error('did not throw'); };
const vs = (o: Partial<ValueSet>): ValueSet => ({ resourceType: 'ValueSet', status: 'active', url: 'http://example.com/vs', ...o });
const codes = (v: ValueSet) => v.expansion?.contains?.map((c) => c.code);
const members = (s: Store, url: string) => { const q = inValueSet(s, url); return (s.db.prepare(`select system, code from (${q.sql}) order by system, code`).all(...q.args) as { system: string; code: string }[]).map((r) => `${r.system}|${r.code}`); };

describe('pg_trgm and collation ports', () => {
  it('strict_word_similarity matches pg_trgm (float4)', () => {
    // Worked by hand through trgm_op.c's calc_word_similarity (DIVUNION, strict word bounds); the parity tests check the order.
    expect(strictWordSimilarity('son', 'son')).toBe(1);
    expect(strictWordSimilarity('foster son', 'son')).toBe(Math.fround(4 / 11));
    expect(strictWordSimilarity('stepson', 'son')).toBe(Math.fround(3 / 9));
    expect(strictWordSimilarity('word', 'two words')).toBe(Math.fround(4 / 7));
    expect(strictWordSimilarity('', 'son')).toBe(0);
  });

  it('the code collation key orders as ICU en with punctuation ignored (glibc en_US, as Medplum sorts codes)', () => {
    const list = ['ORDb', 'ORDB', 'ORD_', 'ORDa', 'ORD1', 'ORD-x', 'ORDZ', 'ORDé', 'ORDe', 'A_B', 'AXB', 'HT', 'HTX', 'ab', 'Ab', 'a-c', 'ä'];
    const icu = new Intl.Collator('en', { ignorePunctuation: true });
    expect([...list].sort((a, b) => (collationKey(a) < collationKey(b) ? -1 : 1))).toEqual([...list].sort(icu.compare));
  });
});

describe('$expand (no built-ins)', () => {
  let dir: string, store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'store-expand-'));
    store = new Store(join(dir, 'store.db'), { terminology: [] });
    store.create({ resourceType: 'CodeSystem', status: 'active', content: 'complete', url: 'http://example.com/cs', hierarchyMeaning: 'is-a',
      property: [{ code: 'kind', type: 'code' }, { code: 'abstract', uri: 'http://hl7.org/fhir/concept-properties#notSelectable', type: 'boolean' }],
      concept: [{ code: 'ROOT', display: 'Root', property: [{ code: 'abstract', valueBoolean: true }], concept: [
        { code: 'A', display: 'Alpha one', property: [{ code: 'kind', valueCode: 'x' }], designation: [{ language: 'fr', value: 'Alpha un' }] },
        { code: 'B', display: 'Beta', concept: [{ code: 'B1', display: 'Beta one' }] },
      ] }] });
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const expand = (v: ValueSet, o = {}) => expandValueSet(store, v, o);
  const include = (o = {}) => vs({ compose: { include: [{ system: 'http://example.com/cs', ...o }] } });

  it('a whole CodeSystem in insertion order; is-a breadth first; descendent-of without the root', () => {
    expect(codes(expand(include()))).toEqual(['ROOT', 'A', 'B', 'B1']);
    expect(codes(expand(include({ filter: [{ property: 'concept', op: 'is-a', value: 'ROOT' }] })))).toEqual(['ROOT', 'A', 'B', 'B1']);
    expect(codes(expand(include({ filter: [{ property: 'concept', op: 'descendent-of', value: 'B' }] })))).toEqual(['B1']);
    expect(codes(expand(include({ filter: [{ property: 'kind', op: '=', value: 'x' }] })))).toEqual(['A']);
    expect(codes(expand(include({ filter: [{ property: 'kind', op: 'exists', value: 'false' }] })))).toEqual(['ROOT', 'B', 'B1']);
    expect(codes(expand(include(), { excludeNotForUI: true }))).toEqual(['A', 'B', 'B1']);
  });

  it('the text filter: exact code first, then pg_trgm similarity of the display, then code; count defaults apply', () => {
    expect(codes(expand(include(), { filter: 'beta one' }))).toEqual(['B1']);
    expect(codes(expand(include(), { filter: 'one' }))).toEqual(['B1', 'A']); // 'Beta one' has fewer trigrams than 'Alpha one'
    expect(codes(expand(include(), { filter: 'A' }))).toEqual(['A']); // under 3 characters: the exact code only
    expect(expand(include(), { filter: 'zzz' }).expansion).toEqual({ total: 0, timestamp: expect.any(String) });
    expect(codes(expand(include(), { filter: 'un', displayLanguage: 'fr' }))).toBeUndefined(); // under 3 characters: code only
    expect(expand(include(), { filter: 'alpha', displayLanguage: 'fr' }).expansion?.contains).toEqual([{ system: 'http://example.com/cs', code: 'A', display: 'Alpha un' }]);
  });

  it('compose.exclude removes codes (R4; Medplum ignores it), from SQL includes and enumerated concepts', () => {
    const v = vs({ compose: { include: [{ system: 'http://example.com/cs' }, { system: 'http://example.com/cs', concept: [{ code: 'A' }] }],
      exclude: [{ system: 'http://example.com/cs', filter: [{ property: 'concept', op: 'is-a', value: 'B' }] }, { system: 'http://example.com/cs', concept: [{ code: 'A' }] }] } });
    expect(codes(expand(v))).toEqual(['ROOT']);
  });

  it('an unsupported filter op is 400 naming it (Medplum returns no codes)', () => {
    expect(err(() => expand(include({ filter: [{ property: 'concept', op: 'regex', value: '.*' }] }))).message).toBe('ValueSet filter op regex is not supported');
  });

  it('a ValueSet including itself through another is 400 (recursive definition)', () => {
    store.create(vs({ url: 'http://example.com/vs-a', compose: { include: [{ valueSet: ['http://example.com/vs-b'] }] } }));
    store.create(vs({ url: 'http://example.com/vs-b', compose: { include: [{ valueSet: ['http://example.com/vs-a'] }] } }));
    const a = findTerminology<ValueSet>(store, 'ValueSet', 'http://example.com/vs-a');
    for (const f of [() => expand(a), () => inValueSet(store, 'http://example.com/vs-a'),
      () => validateCodeVs(store, params([{ name: 'url', valueUri: a.url }, { name: 'coding', valueCoding: { system: 'http://example.com/cs', code: 'A' } }]))]) {
      const e = err(f);
      expect([e.status, e.message]).toEqual([400, 'Recursive ValueSet definition: http://example.com/vs-a']);
    }
  });

  it('inValueSet selects (system, code) membership; subsumedCodes walks below and above', () => {
    store.create(vs({ url: 'http://example.com/vs-b', compose: { include: [{ system: 'http://example.com/cs', filter: [{ property: 'concept', op: 'descendent-of', value: 'ROOT' }] }],
      exclude: [{ system: 'http://example.com/cs', concept: [{ code: 'B1' }] }] } }));
    store.create(vs({ url: 'http://example.com/vs-c', compose: { include: [{ valueSet: ['http://example.com/vs-b'] }, { system: 'http://other', concept: [{ code: 'z' }] }] } }));
    expect(members(store, 'http://example.com/vs-c')).toEqual(['http://example.com/cs|A', 'http://example.com/cs|B', 'http://other|z']);
    const sub = (code: string, dir: 'below' | 'above') => { const q = subsumedCodes(store, 'http://example.com/cs', code, dir); return (store.db.prepare(q.sql).all(...q.args) as { code: string }[]).map((r) => r.code).sort(); };
    expect(sub('B', 'below')).toEqual(['B', 'B1']);
    expect(sub('B1', 'above')).toEqual(['B', 'B1', 'ROOT']);
  });

  it('inValueSet and subsumedCodes throw 400 naming a url the store does not hold', () => {
    for (const [f, text] of [
      [() => inValueSet(store, 'http://unknown/vs'), 'ValueSet http://unknown/vs not found'],
      [() => subsumedCodes(store, 'http://unknown/cs', 'x', 'below'), 'CodeSystem http://unknown/cs not found'],
    ] as const) {
      const e = err(f);
      expect([e.status, e.message]).toEqual([400, text]);
    }
    store.create({ resourceType: 'CodeSystem', status: 'active', content: 'complete', url: 'http://example.com/flat', concept: [{ code: 'x' }] });
    expect(err(() => subsumedCodes(store, 'http://example.com/flat', 'x', 'above')).message).toBe('Invalid filter: CodeSystem http://example.com/flat does not have an is-a hierarchy');
  });

  it('ValueSet $validate-code finds a code through a nested ValueSet and honours exclude', () => {
    store.create(vs({ url: 'http://example.com/vs-b', compose: { include: [{ system: 'http://example.com/cs', filter: [{ property: 'concept', op: 'is-a', value: 'B' }] }],
      exclude: [{ system: 'http://example.com/cs', concept: [{ code: 'B1' }] }] } }));
    store.create(vs({ url: 'http://example.com/vs-c', compose: { include: [{ valueSet: ['http://example.com/vs-b'] }] } }));
    const check = (code: string) => validateCodeVs(store, params([{ name: 'url', valueUri: 'http://example.com/vs-c' }, { name: 'coding', valueCoding: { system: 'http://example.com/cs', code } }])).parameter;
    expect(check('B')).toEqual([{ name: 'result', valueBoolean: true }, { name: 'display', valueString: 'Beta' }]);
    expect(check('B1')).toEqual([{ name: 'result', valueBoolean: false }]);
    expect(check('A')).toEqual([{ name: 'result', valueBoolean: false }]);
  });
});

describe('$expand of the built-ins', () => {
  let dir: string, store: Store;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'store-expand-seed-')); store = new Store(join(dir, 'store.db')); }, 60_000);
  afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('expand of a large built-in ValueSet pages by count and offset', () => {
    // v3-RoleCode's ValueSet includes the whole CodeSystem (hundreds of codes).
    const v = findTerminology<ValueSet>(store, 'ValueSet', 'http://terminology.hl7.org/ValueSet/v3-RoleCode');
    // The query pages in SQL: the statement binds limit and offset (traced on the first expansion, before the statement cache has it).
    const seen: string[] = [];
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => { seen.push(sql); return prepare(sql); }) as typeof store.db.prepare;
    let next: ValueSet;
    try { next = expandValueSet(store, structuredClone(v), { count: 10, offset: 10 }); } finally { store.db.prepare = prepare; }
    expect(seen.some((s) => /from coding/.test(s) && /limit \? offset \?/.test(s))).toBe(true);
    const first = expandValueSet(store, structuredClone(v), { count: 10 });
    expect([first.expansion?.contains?.length, next.expansion?.contains?.length]).toEqual([10, 10]);
    expect(first.expansion?.total).toBe(11); // Medplum's total: the rows fetched (count + 1)
    expect(codes(first)?.filter((c) => codes(next)?.includes(c))).toEqual([]);
    expect(codes(next)).toEqual(codes(expandValueSet(store, structuredClone(v), { count: 20 }))?.slice(10)); // the next 10
  });

  it('Marital status: two CodeSystems, one whole and one enumerated', () => {
    const v = findTerminology<ValueSet>(store, 'ValueSet', 'http://hl7.org/fhir/ValueSet/marital-status');
    expect(codes(expandValueSet(store, v, {}))).toEqual(['A', 'D', 'I', 'L', 'M', 'P', 'S', 'T', 'U', 'W', 'UNK']);
    expect(codes(expandValueSet(store, v, { filter: 'married' }))).toEqual(['M', 'S', 'U']);
  });
});
