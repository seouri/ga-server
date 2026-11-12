// ConceptMap: the mapping index, $translate and $import (Medplum's conceptmaptranslate.test.ts and conceptmapimport.test.ts, reduced).
// Every store here has types with ConceptMap and neither CodeSystem nor ValueSet (no built-in seed); the definitions are
// loaded once per process and vitest runs each file in its own worker.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConceptMap, Parameters, ParametersParameter } from '@medplum/fhirtypes';
import { Store, StoreError } from '../store.ts';
import { params } from '../terminology.ts';
import { importConceptMap, translate } from '../conceptmap.ts';

const err = (f: () => unknown): StoreError => { try { f(); } catch (e) { return e as StoreError; } throw new Error('did not throw'); };
const TYPES = ['Patient', 'Observation', 'Basic', 'ConceptMap', 'Provenance'];
const SYS = 'http://example.com/private-codes';
const map = (o: Partial<ConceptMap> = {}): ConceptMap => ({ resourceType: 'ConceptMap', status: 'active', url: 'http://example.com/cm', sourceCanonical: 'http://example.com/labs', group: [
  { source: SYS, target: 'http://loinc.org', element: [{ code: 'FSH', target: [{ code: '15067-2', display: 'Follitropin Qn', equivalence: 'equivalent' }] }] },
  { source: SYS, target: 'http://www.ama-assn.org/go/cpt', element: [{ code: 'FSH', target: [{ code: '83001', equivalence: 'equivalent' }] }] },
], ...o });
const coding = (system: string | undefined, code: string): ParametersParameter => ({ name: 'coding', valueCoding: { system, code } });
const P = (parameter: ParametersParameter[], id?: string) => params(parameter, id);
const codes = (p: Parameters) => p.parameter!.filter((x) => x.name === 'match').map((m) => m.part![1].valueCoding!.code);
const result = (p: Parameters) => p.parameter![0].valueBoolean;
const mapping = (source: string, target: string, ...more: ParametersParameter[]): ParametersParameter => ({ name: 'mapping', part: [
  { name: 'source', valueCoding: { system: 'http://snomed.info/sct', code: source } }, { name: 'target', valueCoding: { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: target } }, ...more] });
const dependsOn = (code: string): ParametersParameter => ({ name: 'dependsOn', part: [{ name: 'code', valueCode: 'context' }, { name: 'value', valueCode: code }] });

describe('ConceptMap', () => {
  let dir: string, store: Store;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-cm-')); store = new Store(join(dir, 'store.db'), { types: TYPES }); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = (o?: Partial<ConceptMap>) => store.create(map(o)).resource as ConceptMap & { id: string };

  it('$translate by id, url and source; system+code, coding, codeableConcept; targetsystem filters', () => {
    const cm = create();
    expect(translate(store, P([{ name: 'system', valueUri: SYS }, { name: 'code', valueCode: 'FSH' }], cm.id))).toEqual({ resourceType: 'Parameters', parameter: [
      { name: 'result', valueBoolean: true },
      { name: 'match', part: [{ name: 'equivalence', valueCode: 'equivalent' }, { name: 'concept', valueCoding: { system: 'http://loinc.org', code: '15067-2', display: 'Follitropin Qn' } }] },
      { name: 'match', part: [{ name: 'equivalence', valueCode: 'equivalent' }, { name: 'concept', valueCoding: { system: 'http://www.ama-assn.org/go/cpt', code: '83001' } }] },
    ] });
    expect(codes(translate(store, P([{ name: 'url', valueUri: cm.url }, coding(SYS, 'FSH')])))).toEqual(['15067-2', '83001']);
    expect(codes(translate(store, P([{ name: 'source', valueUri: cm.sourceCanonical }, { name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: SYS, code: 'FSH' }] } }])))).toEqual(['15067-2', '83001']);
    expect(codes(translate(store, P([{ name: 'url', valueUri: cm.url }, { name: 'targetsystem', valueUri: 'http://loinc.org' }, coding(SYS, 'FSH')])))).toEqual(['15067-2']);
    expect(translate(store, P([coding(SYS, 'BAD')], cm.id)).parameter).toEqual([{ name: 'result', valueBoolean: false }]);
    expect(translate(store, P([{ name: 'codeableConcept', valueCodeableConcept: { text: 'Nebulous' } }], cm.id)).parameter).toEqual([{ name: 'result', valueBoolean: false }]);
  });

  it('$translate errors use Medplum\'s texts; unsupported R4 inputs are 400', () => {
    const cm = create();
    const text = (ps: ParametersParameter[], id?: string) => { const e = err(() => translate(store, P(ps, id))); return [e.status, e.outcome.issue?.[0]?.details?.text]; };
    expect(text([coding(SYS, 'FSH')])).toEqual([400, 'No ConceptMap specified']);
    expect(text([{ name: 'code', valueCode: 'BAD' }], cm.id)).toEqual([400, 'System parameter must be provided with code']);
    expect(text([coding(SYS, 'FSH'), { name: 'system', valueUri: SYS }, { name: 'code', valueCode: 'BAD' }], cm.id)).toEqual([400, 'Ambiguous input: multiple source codings provided']);
    expect(text([], cm.id)).toEqual([400, 'Source Coding (system + code) must be specified']);
    expect(text([{ name: 'url', valueUri: `${cm.url}BAD` }, coding(SYS, 'FSH')])).toEqual([400, `ConceptMap ${cm.url}BAD not found`]);
    expect(text([{ name: 'source', valueUri: `${cm.url}BAD` }, coding(SYS, 'FSH')])).toEqual([400, `ConceptMap for source ${cm.url}BAD not found`]);
    expect(text([coding(SYS, 'FSH'), { name: 'reverse', valueBoolean: true }], cm.id)).toEqual([400, '$translate: parameter reverse is not supported']);
    expect(text([coding(SYS, 'FSH')], '00000000-0000-4000-8000-000000000000')).toEqual([404, 'Not found']);
    expect(text([])).toEqual([400, 'No ConceptMap specified']); // the map is found before the codings are read, as Medplum
    expect(text([], '00000000-0000-4000-8000-000000000000')).toEqual([404, 'Not found']);
  });

  it('$translate: unmapped provided and fixed; implicit system; no groups; an other-map loop is 400', () => {
    const cm = create({ group: [
      { source: SYS, target: `${SYS}/v2`, element: [{ code: 'OTHER', target: [{ code: 'DISTINCT', equivalence: 'equivalent' }] }], unmapped: { mode: 'provided' } },
      { source: SYS, target: 'http://example.com/other', element: [{ code: 'OTHER', target: [{ code: '1', equivalence: 'equivalent' }] }], unmapped: { mode: 'fixed', code: 'UNK', display: 'Unknown' } },
    ] });
    expect(translate(store, P([coding(SYS, 'FSH')], cm.id)).parameter!.slice(1)).toEqual([
      { name: 'match', part: [{ name: 'equivalence', valueCode: 'equal' }, { name: 'concept', valueCoding: { system: `${SYS}/v2`, code: 'FSH' } }] },
      { name: 'match', part: [{ name: 'equivalence', valueCode: 'equivalent' }, { name: 'concept', valueCoding: { system: 'http://example.com/other', code: 'UNK', display: 'Unknown' } }] },
    ]);
    const implicit = create({ url: 'http://example.com/implicit', group: [{ target: 'http://loinc.org', element: [{ code: 'FSH', target: [{ code: '15067-2', equivalence: 'equivalent' }] }] }] });
    expect(codes(translate(store, P([{ name: 'codeableConcept', valueCodeableConcept: { coding: [{ code: 'FSH' }] } }], implicit.id)))).toEqual(['15067-2']);
    const empty = create({ url: 'http://example.com/empty', group: undefined });
    expect(translate(store, P([coding(SYS, 'FSH')], empty.id)).parameter).toEqual([{ name: 'result', valueBoolean: false }]);
    const loop = create({ url: 'http://example.com/loop', group: [{ source: SYS, element: [{ code: 'X', target: [{ code: 'Y', equivalence: 'equivalent' }] }], unmapped: { mode: 'other-map', url: 'http://example.com/loop' } }] });
    expect(err(() => translate(store, P([coding(SYS, 'FSH')], loop.id))).status).toBe(400);
    // A diamond is no loop: two source systems that both fall back to the same map.
    const n = create({ url: 'http://example.com/n', group: [{ source: 'http://example.com/s2', target: 'http://example.com/t', element: [{ code: 'Q', target: [{ code: 'R', equivalence: 'equivalent' }] }] }] });
    const m = create({ url: 'http://example.com/m', group: ['http://example.com/s1', 'http://example.com/s2'].map((source) => ({ source, element: [{ code: 'X', target: [{ code: 'Y', equivalence: 'equivalent' }] }],
      unmapped: { mode: 'other-map' as const, url: n.url } })) });
    expect(codes(translate(store, P([{ name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: 'http://example.com/s1', code: 'Q' }, { system: 'http://example.com/s2', code: 'Q' }] } }], m.id)))).toEqual(['R', 'R']); // each fallback translates every coding again, as Medplum
  });

  it('$import adds mappings with comment and dependsOn; $translate sorts by dependsOn, then system|code', () => {
    const cm = create({ group: undefined, url: 'http://example.com/imported' });
    const out = importConceptMap(store, P([
      mapping('1', 'Q87.0', dependsOn('715484003')), mapping('1', 'H18.509'), mapping('1', 'Q04.9', dependsOn('1172594000')),
      mapping('2', 'B', { name: 'comment', valueString: 'Baz, Quux' }),
    ], cm.id));
    expect([out.resourceType, out.id]).toEqual(['ConceptMap', cm.id]);
    expect(codes(translate(store, P([{ name: 'system', valueUri: 'http://snomed.info/sct' }, { name: 'code', valueCode: '1' }], cm.id)))).toEqual(['H18.509', 'Q04.9', 'Q87.0']);
    expect(translate(store, P([{ name: 'system', valueUri: 'http://snomed.info/sct' }, { name: 'code', valueCode: '1' }], cm.id)).parameter![2].part![2])
      .toEqual({ name: 'dependsOn', part: [{ name: 'attribute', valueUri: 'context' }, { name: 'value', valueCode: '1172594000' }] });
    expect(translate(store, P([{ name: 'system', valueUri: 'http://snomed.info/sct' }, { name: 'code', valueCode: '2' }], cm.id)).parameter![1].part![2])
      .toEqual({ name: 'property', part: [{ name: 'uri', valueUri: 'https://medplum.com/conceptmap-attribute/comment' }, { name: 'value', valueString: 'Baz, Quux' }] });
  });

  it('$import by url; errors use Medplum\'s texts; a failed import writes nothing', () => {
    const cm = create({ group: undefined, url: 'http://example.com/byurl' });
    importConceptMap(store, P([{ name: 'url', valueUri: cm.url }, mapping('1', 'A')]));
    const text = (ps: ParametersParameter[], id?: string) => { const e = err(() => importConceptMap(store, P(ps, id))); return [e.status, e.outcome.issue?.[0]?.details?.text]; };
    expect(text([mapping('1', 'A')])).toEqual([400, 'ConceptMap to import into must be specified']);
    expect(text([{ name: 'url', valueUri: cm.url }, mapping('1', 'A')], cm.id)).toEqual([400, 'Parameter `url` not permitted for instance operation']);
    expect(text([mapping('2', 'B'), { name: 'mapping', part: [{ name: 'source', valueCoding: { system: 'http://snomed.info/sct' } }, { name: 'target', valueCoding: { system: 'x', code: 'y' } }] }], cm.id))
      .toEqual([400, 'Source code for mapping is required']);
    expect(store.db.prepare('select sourceCode from concept_mapping order by rowid').all().map((r) => r.sourceCode)).toEqual(['1']); // the failed one rolled back
  });

  it('an element without a code is not a row; an update replaces inline rows and keeps imported ones; delete removes all', () => {
    const cm = create({ group: [{ source: 'http://snomed.info/sct', target: 'http://hl7.org/fhir/sid/icd-10-cm', element: [
      { code: '263204007', target: [{ code: 'S52.209A', equivalence: 'equivalent' }, { code: 'S52.209D', equivalence: 'equivalent' }] },
      { target: [{ code: 'unmapped', equivalence: 'equal' }] },
    ] }] });
    const rows = () => store.db.prepare('select sourceCode, targetCode from concept_mapping order by rowid').all().map((r) => `${r.sourceCode}>${r.targetCode}`);
    expect(rows()).toEqual(['263204007>S52.209A', '263204007>S52.209D']);
    importConceptMap(store, P([mapping('10347006', 'T50.905')], cm.id));
    expect(rows()).toHaveLength(3);
    store.update({ ...cm, group: [{ source: 'http://snomed.info/sct', target: 'http://hl7.org/fhir/sid/icd-10-cm', element: [{ code: '263204007', target: [{ code: 'S52.209A', equivalence: 'equivalent' }] }] }] });
    expect(rows()).toEqual(['10347006>T50.905', '263204007>S52.209A']);
    store.delete('ConceptMap', cm.id);
    expect(rows()).toEqual([]);
  });

  it('a store whose types include ConceptMap but neither CodeSystem nor ValueSet indexes ConceptMaps without seeding terminology', () => {
    expect(store.db.prepare("select (select count(*) from builtin) b, (select count(*) from meta where key = 'terminology') m").get()).toEqual({ b: 0, m: 0 });
    const cm = create();
    expect(store.db.prepare('select count(*) n from concept_mapping').get()).toEqual({ n: 2 });
    expect(codes(translate(store, P([coding(SYS, 'FSH')], cm.id)))).toEqual(['15067-2', '83001']);
  });
});
