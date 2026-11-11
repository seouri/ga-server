// ConceptMap $translate and $import (store plan 2): the ported Medplum tests, one describe per file, sharing one login. Medplum's
// beforeEach map has a fixed url and sourceCanonical; here each test suffixes both (the project keeps its maps until the run ends,
// and a tie between two maps would be broken by ids that differ between the sides). Medplum's database assertions (getMappingRows)
// become $translate calls.
import { randomUUID } from 'node:crypto';
import type { ConceptMap, Parameters, ParametersParameter } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, paritySides, same, type Side } from './harness.ts';

const SNOMED = 'http://snomed.info/sct';
const ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm';
const SYS = 'http://example.com/private-codes';
const CODE = 'FSH';
const E = encodeURIComponent;
const P = (...parameter: ParametersParameter[]): Parameters => ({ resourceType: 'Parameters', parameter });
const call = async (s: Side, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const g = await s.call(method, path, body, headers);
  return { status: g.status, body: g.json };
};
const text = (r: { body: any }) => r.body?.issue?.[0]?.details?.text as string | undefined;
const matches = (r: { body: any }) => (r.body?.parameter ?? []).filter((p: ParametersParameter) => p.name === 'match') as ParametersParameter[];
const result = (r: { body: any }) => r.body?.parameter?.find((p: ParametersParameter) => p.name === 'result')?.valueBoolean;
const coding = (system: string | undefined, code: string): ParametersParameter => ({ name: 'coding', valueCoding: { system, code } });
const dependsOn = (code: string): ParametersParameter => ({ name: 'dependsOn', part: [{ name: 'code', valueCode: 'context' }, { name: 'value', valueCode: code }] });
const mapping = (...part: ParametersParameter[]): ParametersParameter => ({ name: 'mapping', part });
const src = (code?: string, system = SNOMED): ParametersParameter => ({ name: 'source', valueCoding: { system, code } });
const tgt = (code: string, system = ICD10CM): ParametersParameter => ({ name: 'target', valueCoding: { system, code } });

describe.skipIf(SQLITE)('ConceptMap operations (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);
  let suffix: string;
  const run = <T>(fn: (s: Side) => Promise<T>) => () => { suffix = randomUUID(); return same(sides, fn).then(() => undefined); };

  // conceptmaptranslate.test.ts
  describe('ConceptMap $translate', () => {
    const url = () => `http://example.com/concept-map-${suffix}`;
    const labs = () => `http://example.com/labs-${suffix}`;
    // Medplum's beforeEach map.
    const create = (s: Side, o: Partial<ConceptMap> = {}) => s.create<ConceptMap>({
      resourceType: 'ConceptMap', url: url(), status: 'active', sourceCanonical: labs(),
      group: [
        { source: SYS, target: 'http://loinc.org', element: [{ code: CODE, target: [{ code: '15067-2', display: 'Follitropin Qn', equivalence: 'equivalent' }] }] },
        { source: SYS, target: 'http://www.ama-assn.org/go/cpt', element: [{ code: CODE, target: [{ code: '83001', equivalence: 'equivalent' }] }] },
      ], ...o,
    });
    const tr = (s: Side, path: string, ...parameter: ParametersParameter[]) => call(s, 'POST', path, P(...parameter));
    const two = (r: { status: number; body: any }) => {
      expect([r.status, result(r), matches(r).length]).toEqual([200, true, 2]);
      return r;
    };

    test('ConceptMap $translate › Success %s [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const cm = await create(s);
      const out = [];
      for (const params of [[{ name: 'system', valueUri: SYS }, { name: 'code', valueCode: CODE }], [coding(SYS, CODE)],
        [{ name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: SYS, code: CODE }] } }]] as ParametersParameter[][]) {
        out.push(two(await tr(s, `ConceptMap/${cm.id}/$translate`, ...params)));
      }
      return out;
    }));

    test('ConceptMap $translate › Lookup by URL [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      await create(s);
      return two(await tr(s, 'ConceptMap/$translate', { name: 'url', valueUri: url() }, coding(SYS, CODE)));
    }));

    test('ConceptMap $translate › Allows GET request [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      await create(s);
      return two(await call(s, 'GET', `ConceptMap/$translate?url=${E(url())}&system=${E(SYS)}&code=${CODE}`));
    }));

    test('ConceptMap $translate › Lookup by source ValueSet [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      await create(s);
      return two(await tr(s, 'ConceptMap/$translate', { name: 'source', valueUri: labs() }, coding(SYS, CODE)));
    }));

    test('ConceptMap $translate › Filter on target system [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      await create(s);
      const r = await tr(s, 'ConceptMap/$translate', { name: 'url', valueUri: url() }, { name: 'targetsystem', valueUri: 'http://loinc.org' }, coding(SYS, CODE));
      expect([r.status, result(r), matches(r).map((m) => m.part?.[1]?.valueCoding?.code)]).toEqual([200, true, ['15067-2']]);
      return r;
    }));

    test('ConceptMap $translate › No match [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const cm = await create(s);
      const r = await tr(s, `ConceptMap/${cm.id}/$translate`, coding(SYS, 'BAD'));
      expect([r.status, r.body.parameter]).toEqual([200, [{ name: 'result', valueBoolean: false }]]);
      return r;
    }));

    const fails = (path: (cm: ConceptMap) => string, expected: string | RegExp, ...parameter: ParametersParameter[]) => run(async (s) => {
      const cm = await create(s);
      const r = await tr(s, path(cm), ...parameter);
      expect(r.status).toBe(400);
      expect(text(r)).toMatch(expected);
      return r;
    });
    test('ConceptMap $translate › No map specified [server/src/fhir/operations/conceptmaptranslate.test.ts]',
      fails(() => 'ConceptMap/$translate', 'No ConceptMap specified', coding(SYS, CODE)));
    test('ConceptMap $translate › Code without system [server/src/fhir/operations/conceptmaptranslate.test.ts]',
      fails((cm) => `ConceptMap/${cm.id}/$translate`, 'System parameter must be provided with code', { name: 'code', valueCode: 'BAD' }));
    test('ConceptMap $translate › Ambiguous coding provided [server/src/fhir/operations/conceptmaptranslate.test.ts]',
      fails((cm) => `ConceptMap/${cm.id}/$translate`, 'Ambiguous input: multiple source codings provided', coding(SYS, CODE), { name: 'system', valueUri: SYS }, { name: 'code', valueCode: 'BAD' }));
    test('ConceptMap $translate › No source coding [server/src/fhir/operations/conceptmaptranslate.test.ts]',
      fails((cm) => `ConceptMap/${cm.id}/$translate`, 'Source Coding (system + code) must be specified'));

    test('ConceptMap $translate › Not found by %s [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      await create(s);
      const out = [];
      for (const name of ['url', 'source']) {
        const r = await tr(s, 'ConceptMap/$translate', { name, valueUri: `${url()}BAD` }, coding(SYS, CODE));
        expect(r.status).toBe(400);
        expect(text(r)).toMatch(/^ConceptMap .* not found$/);
        out.push(r);
      }
      return out;
    }));

    test('ConceptMap $translate › Unmapped code handling [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const cm = await create(s, { group: [
        { source: SYS, target: `${SYS}/v2`, element: [{ code: 'OTHER', target: [{ code: 'DISTINCT', equivalence: 'equivalent' }] }], unmapped: { mode: 'provided' } },
        { source: SYS, target: 'http://example.com/other-system', element: [{ code: 'OTHER', target: [{ code: '1', equivalence: 'equivalent' }] }],
          unmapped: { mode: 'fixed', code: 'UNK', display: 'Unknown' } },
      ] });
      const r = await tr(s, `ConceptMap/${cm.id}/$translate`, coding(SYS, CODE));
      expect([r.status, result(r)]).toEqual([200, true]);
      expect(matches(r)).toEqual([
        { name: 'match', part: [{ name: 'equivalence', valueCode: 'equal' }, { name: 'concept', valueCoding: { system: `${SYS}/v2`, code: CODE } }] },
        { name: 'match', part: [{ name: 'equivalence', valueCode: 'equivalent' }, { name: 'concept', valueCoding: { system: 'http://example.com/other-system', code: 'UNK', display: 'Unknown' } }] },
      ]);
      return r;
    }));

    test('ConceptMap $translate › Handles empty CodeableConcept [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const cm = await create(s);
      const r = await tr(s, `ConceptMap/${cm.id}/$translate`, { name: 'codeableConcept', valueCodeableConcept: { text: 'Nebulous concept' } });
      expect([r.status, r.body.parameter]).toEqual([200, [{ name: 'result', valueBoolean: false }]]);
      return r;
    }));

    test('ConceptMap $translate › Handles implicit system [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const cm = await create(s, { group: [{ target: 'http://loinc.org', element: [{ code: CODE, target: [{ code: '15067-2', display: 'Follitropin Qn', equivalence: 'equivalent' }] }] }] });
      const r = await tr(s, `ConceptMap/${cm.id}/$translate`, { name: 'codeableConcept', valueCodeableConcept: { coding: [{ code: CODE }] } });
      expect([r.status, result(r), matches(r).length]).toEqual([200, true, 1]);
      return r;
    }));

    test('ConceptMap $translate › No mapping groups specified [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const cm = await create(s, { group: undefined, targetCanonical: 'http://example.com/loinc' });
      const r = await tr(s, `ConceptMap/${cm.id}/$translate`, coding(SYS, CODE));
      expect([r.status, r.body.parameter]).toEqual([200, [{ name: 'result', valueBoolean: false }]]);
      return r;
    }));

    test('ConceptMap $translate › Complex SNOMED to ICD mapping [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const map = await s.create<ConceptMap>({ resourceType: 'ConceptMap', status: 'active', url: `https://example.com/snomedct_to_icd10cm-${suffix}`, title: 'SNOMED CT to ICD-10-CM Mapping',
        name: 'snomed-to-icd', description: 'Mapping of clinically relevant SNOMED codes to candidate ICD-10 codes' });
      const source = src('1003408005');
      const rows: [string, ...string[]][] = [['Q52.71', '1172594000', '248152002'], ['Q55.29', '1172594000', '248153007'], ['Q87.89', '254150007'], ['Q87.0', '715484003'],
        ['H18.519', '720749004'], ['Q87.89', '723584003'], ['H18.559', '95488001'], ['H18.549', '231933003'], ['H18.509'], ['Q04.9', '1172594000'], ['H18.599', '254150007'],
        ['Q74.8', '715484003'], ['H90.5', '720749004'], ['H18.509', '1172594000'], ['H18.509', '715484003'], ['Q87.0', '1172594000']];
      const imp = await call(s, 'POST', `ConceptMap/${map.id}/$import`, P(...rows.map(([code, ...deps]) => mapping(source, tgt(code), ...deps.map(dependsOn)))), { 'x-medplum': 'extended' });
      expect(imp.status).toBe(200);
      const r = await call(s, 'GET', `ConceptMap/${map.id}/$translate?system=${E(SNOMED)}&code=1003408005`);
      expect([r.status, result(r), matches(r).length]).toEqual([200, true, 16]);
      // Medplum joins a mapping's attributes with no ORDER BY (its test uses arrayContaining): parts sorted within each match.
      for (const m of matches(r)) m.part?.sort((a, b) => a.name !== 'dependsOn' || b.name !== 'dependsOn' ? 0 : JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return [imp, r];
    }));

    test('ConceptMap $translate › Renders mapping comment [server/src/fhir/operations/conceptmaptranslate.test.ts]', run(async (s) => {
      const map = await s.create<ConceptMap>({ resourceType: 'ConceptMap', status: 'active', url: `http://example.com/ConceptMap/commented-${suffix}` });
      const imp = await call(s, 'POST', `ConceptMap/${map.id}/$import`, P(mapping(src('foo', 'A'), tgt('bar', 'B'), { name: 'comment', valueString: 'Baz, Quux' })), { 'x-medplum': 'extended' });
      expect(imp.status).toBe(200);
      const r = await call(s, 'GET', `ConceptMap/${map.id}/$translate?system=A&code=foo`);
      expect(r.body.parameter).toEqual([{ name: 'result', valueBoolean: true }, { name: 'match', part: [
        { name: 'equivalence', valueCode: 'equivalent' }, { name: 'concept', valueCoding: { system: 'B', code: 'bar' } },
        { name: 'property', part: [{ name: 'uri', valueUri: 'https://medplum.com/conceptmap-attribute/comment' }, { name: 'value', valueString: 'Baz, Quux' }] }] }]);
      return [imp, r];
    }));

    // R4 inputs $translate does not implement: Medplum ignores them (and translates as without), the store refuses them.
    test('differs on purpose: unsupported $translate inputs are 400 [store-plan-2]', async () => {
      suffix = randomUUID();
      const [medplum, store] = await both(sides, async (s) => {
        const cm = await create(s);
        const out = [];
        for (const p of [{ name: 'conceptMapVersion', valueString: '1' }, { name: 'version', valueString: '1' }, { name: 'target', valueUri: 'http://example.com/vs' },
          { name: 'reverse', valueBoolean: true }] as ParametersParameter[]) {
          const r = await tr(s, `ConceptMap/${cm.id}/$translate`, coding(SYS, CODE), p);
          out.push([p.name, r.status, r.status === 200 ? matches(r).length : text(r)]);
        }
        return out;
      });
      expect(medplum.map((x) => x[1])).toEqual([200, 200, 200, 200]);
      expect(store).toEqual(['conceptMapVersion', 'version', 'target', 'reverse'].map((n) => [n, 400, `$translate: parameter ${n} is not supported`]));
    });
  });

  // conceptmapimport.test.ts
  describe('ConceptMap/$import', () => {
    const blank = (s: Side, o: Partial<ConceptMap> = {}) => s.create<ConceptMap>({ resourceType: 'ConceptMap', status: 'draft', url: `http://example.com/ConceptMap/${suffix}`, ...o });
    const imp = (s: Side, path: string, ...parameter: ParametersParameter[]) => call(s, 'POST', path, P(...parameter), { 'x-medplum': 'extended' });
    const translated = (s: Side, cm: ConceptMap, code: string) => call(s, 'GET', `ConceptMap/${cm.id}/$translate?system=${E(SNOMED)}&code=${code}`);
    const one = mapping(src('10347006'), tgt('T50.905'));

    test('ConceptMap/$import › Imports concept mappings and attributes [server/src/fhir/operations/conceptmapimport.test.ts]', run(async (s) => {
      const cm = await blank(s, { name: 'Test Imported ConceptMap' });
      const res = await imp(s, `ConceptMap/${cm.id}/$import`, mapping(
        { name: 'source', valueCoding: { system: SNOMED, code: '10347006', display: 'Solar uticaria' } },
        { name: 'target', valueCoding: { system: ICD10CM, code: 'T50.905', display: 'Adverse effect of unspecified drugs, medicaments and biological substances, episode of care unspecified' } },
        { name: 'comment', valueString: 'CONSIDER ADDITIONAL CODE TO IDENTIFY SPECIFIC CONDITION OR DISEASE | EPISODE OF CARE INFORMATION NEEDED | MAP OF SOURCE CONCEPT IS CONTEXT DEPENDENT' },
        { name: 'dependsOn', part: [{ name: 'code', valueCode: 'context' }, { name: 'value', valueCoding: { system: SNOMED, code: '403625006' } }] },
      ));
      expect([res.status, res.body.resourceType]).toEqual([200, 'ConceptMap']);
      const r = await translated(s, cm, '10347006');
      expect(matches(r)).toHaveLength(1);
      expect(matches(r)[0].part).toEqual(expect.arrayContaining([
        { name: 'dependsOn', part: [{ name: 'attribute', valueUri: 'context' }, { name: 'value', valueCoding: { system: SNOMED, code: '403625006' } }] }]));
      return [res, r];
    }));

    test('ConceptMap/$import › Imports by ID without extended mode [server/src/fhir/operations/conceptmapimport.test.ts]', run(async (s) => {
      const cm = await blank(s, { name: 'Test Imported ConceptMap' });
      const res = await call(s, 'POST', `ConceptMap/${cm.id}/$import`, P(one));
      expect(res.status).toBe(200);
      return res;
    }));

    test('ConceptMap/$import › Allows selecting ConceptMap by URL [server/src/fhir/operations/conceptmapimport.test.ts]', run(async (s) => {
      const cm = await blank(s);
      const res = await imp(s, 'ConceptMap/$import', { name: 'url', valueUri: cm.url }, one);
      expect(res.status).toBe(200);
      const r = await translated(s, cm, '10347006');
      expect(matches(r)).toHaveLength(1);
      return [res, r];
    }));

    test('ConceptMap/$import › Requires ConceptMap to be specified [server/src/fhir/operations/conceptmapimport.test.ts]', run(async (s) => {
      const res = await call(s, 'POST', 'ConceptMap/$import', P(one));
      expect([res.status, text(res)]).toEqual([400, 'ConceptMap to import into must be specified']);
      return res;
    }));

    test('ConceptMap/$import › Cannot overspecify ConceptMap [server/src/fhir/operations/conceptmapimport.test.ts]', run(async (s) => {
      const cm = await blank(s);
      const res = await imp(s, `ConceptMap/${cm.id}/$import`, { name: 'url', valueUri: cm.url }, one);
      expect(res.status).toBe(400);
      expect(text(res)).toContain('not permitted for instance operation');
      return res;
    }));

    test('ConceptMap/$import › Requires source code to be specified [server/src/fhir/operations/conceptmapimport.test.ts]', run(async (s) => {
      const cm = await blank(s);
      const res = await imp(s, `ConceptMap/${cm.id}/$import`, mapping(src(undefined), tgt('T50.905')));
      expect([res.status, text(res)]).toEqual([400, 'Source code for mapping is required']);
      return res;
    }));

    const inline = (): Partial<ConceptMap> => ({ version: '4.0.1', group: [{ source: SNOMED, target: 'http://hl7.org/fhir/sid/icd-10-us', element: [
      { code: '263204007', target: [{ code: 'S52.209A', equivalence: 'equivalent' }, { code: 'S52.209D', equivalence: 'equivalent' }] }] }] });

    test('ConceptMap/$import › Import does not clobber or duplicate inline mappings [server/src/fhir/operations/conceptmapimport.test.ts]', run(async (s) => {
      const cm = await blank(s, inline());
      const before = await translated(s, cm, '263204007');
      expect(matches(before)).toHaveLength(2);
      const res = await imp(s, `ConceptMap/${cm.id}/$import`, one);
      expect(res.status).toBe(200);
      const [inl, imported] = [await translated(s, cm, '263204007'), await translated(s, cm, '10347006')];
      expect([matches(inl).length, matches(imported).length]).toEqual([2, 1]); // 3 rows
      return [before, res, inl, imported];
    }));

    // Medplum's update of a ConceptMap with groups purges every mapping row and re-indexes the inline ones, losing what $import
    // wrote; the store replaces only the inline rows, so an import survives an edit of the map (as CodeSystem $import's concepts do).
    test('differs on purpose: $import mappings survive an update of the ConceptMap [store-plan-2]', async () => {
      suffix = randomUUID();
      const [medplum, store] = await both(sides, async (s) => {
        const cm = await blank(s, inline());
        expect((await imp(s, `ConceptMap/${cm.id}/$import`, one)).status).toBe(200);
        const put = await s.call('PUT', `ConceptMap/${cm.id}`, { ...cm, group: [{ ...cm.group![0], element: [{ code: '263204007', target: [{ code: 'S52.209A', equivalence: 'equivalent' }] }] }] });
        expect(put.status).toBe(200);
        return [matches(await translated(s, cm, '263204007')).length, matches(await translated(s, cm, '10347006')).length];
      });
      expect(medplum).toEqual([1, 0]);
      expect(store).toEqual([1, 1]);
    });
  });
});
