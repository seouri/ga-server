// ValueSet $expand and ValueSet $validate-code (store plan 2): the ported Medplum tests, one describe per file, sharing one login.
// Built-in ids differ between the two servers, so ValueSets are named by url. $expand answers are compared whole (the
// expansion's timestamp blanked), `expansion.contains` in order. The CodeSystem $import row whose last step is $expand is in
// terminology.test.ts with the other $import rows.
import { randomUUID } from 'node:crypto';
import type { CodeSystem, Parameters, ParametersParameter, ValueSet } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, paritySides, same, type Side } from './harness.ts';

const E = encodeURIComponent;
const LOINC = 'http://loinc.org';
const ROLE_CODE = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode';
const RELATED = 'http://hl7.org/fhir/ValueSet/relatedperson-relationshiptype';
const OBS = 'http://hl7.org/fhir/ValueSet/observation-codes';
const ABSTRACT = 'http://hl7.org/fhir/concept-properties#notSelectable';
const P = (...parameter: ParametersParameter[]): Parameters => ({ resourceType: 'Parameters', parameter });

// A $expand by GET: status and body, the timestamp blanked (each server stamps its own).
async function exp(s: Side, query: string): Promise<{ status: number; body: any }> {
  const g = await s.call('GET', `ValueSet/$expand?${query}`);
  if (g.json?.expansion?.timestamp) g.json.expansion.timestamp = 'TIMESTAMP';
  return { status: g.status, body: g.json };
}
const text = (r: { body: any }) => r.body?.issue?.[0]?.details?.text as string | undefined;
const contains = (r: { body: any }) => r.body?.expansion?.contains as { system?: string; code?: string; display?: string }[] | undefined;
// An expansion that walks a hierarchy has no ORDER BY in Medplum: below the third level its order follows its Postgres plan
// (observed: grouped by the parent's code), the store's stays breadth-first in CodeSystem order. Such answers are compared
// with `contains` sorted by system and code.
const unordered = <T extends { body: any }>(r: T): T => {
  r.body?.expansion?.contains?.sort((a: any, b: any) => `${a.system}|${a.code}`.localeCompare(`${b.system}|${b.code}`));
  return r;
};
const created = async (s: Side, ...rs: (CodeSystem | ValueSet)[]) => { for (const r of rs) await s.create(r); };

describe.skipIf(SQLITE)('ValueSet $expand and $validate-code (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  describe('Expand', () => {

    test('Expand › No ValueSet URL [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, '');
      expect([r.status, text(r)]).toEqual([400, expect.stringContaining('Missing url')]);
      return r;
    }));

    test('Expand › ValueSet not found [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E('http://example.com/ValueSet/123')}`);
      expect([r.status, text(r)]).toEqual([400, expect.stringMatching(/^ValueSet .*not found$/)]);
      return r;
    }));

    test('Expand › No logical definition [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `https://example.com/ValueSet/${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url });
        const r = await exp(s, `url=${E(url)}`);
        expect([r.status, text(r)]).toEqual([400, expect.stringMatching(/(^Missing ValueSet definition$)|(^No systems found$)/)]);
        return r;
      });
    });

    test('Expand › No filter [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(OBS)}`);
      expect([r.status, contains(r)?.length, contains(r)?.[0].system]).toEqual([200, 10, LOINC]);
      return r;
    }));

    test('Expand › Multiple filters [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(OBS)}&filter=a&filter=b`);
      expect([r.status, text(r)]).toEqual([400, expect.stringContaining('filter')]);
      return r;
    }));

    test('Expand › Invalid filter [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(OBS)}&filter=%00a`);
      expect([r.status, text(r)]).toEqual([400, expect.stringContaining('null byte')]);
      return r;
    }));

    test('Expand › Filter token limit [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const accepted = await exp(s, `url=${E(OBS)}&filter=${E(Array(10).fill('rate').join(' '))}`);
      const rejected = await exp(s, `url=${E(OBS)}&filter=${E(Array(11).fill('rate').join(' '))}`);
      expect([accepted.status, rejected.status, text(rejected)]).toEqual([200, 400, expect.stringContaining('Filter value cannot contain more than 10 tokens')]);
      return [accepted, rejected];
    }));

    test('Expand › Success [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(OBS)}&filter=rate`);
      expect([r.status, contains(r)?.[0].system, contains(r)?.[0].display]).toEqual([200, LOINC, expect.stringMatching(/rate/i)]);
      return r;
    }));

    test('Expand › Success with count and offset [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(OBS)}&filter=blood&offset=1&count=1`);
      expect([r.status, contains(r)?.length, contains(r)?.[0].system, contains(r)?.[0].display]).toEqual([200, 1, LOINC, expect.stringMatching(/blood/i)]);
      return r;
    }));

    test('Expand › No duplicates [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E('http://hl7.org/fhir/ValueSet/subscription-status|4.0.1')}&filter=active`);
      expect(r).toMatchObject({ status: 200, body: { resourceType: 'ValueSet', url: 'http://hl7.org/fhir/ValueSet/subscription-status',
        expansion: { contains: [{ system: 'http://hl7.org/fhir/subscription-status', code: 'active', display: 'Active' }] } } });
      expect(contains(r)).toHaveLength(1);
      return r;
    }));

    test('Expand › Marital status [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E('http://hl7.org/fhir/ValueSet/marital-status')}&filter=married`);
      expect(contains(r)).toEqual(expect.arrayContaining([
        { system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus', code: 'M', display: 'Married' },
        { system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus', code: 'S', display: 'Never Married' },
      ]));
      return r;
    }));

    test('Expand › Handle punctuation [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(OBS)}&filter=${E('intention - reported')}`);
      expect([r.status, contains(r)?.[0].system, contains(r)?.[0].display]).toEqual([200, LOINC, expect.stringMatching(/pregnancy intention/i)]);
      return r;
    }));

    test('Expand › Handle empty string after punctuation [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E('http://hl7.org/fhir/ValueSet/care-plan-activity-kind')}&filter=${E('[')}`);
      expect(r.status).toBe(200);
      return r;
    }));

    test('Expand › No null `display` field [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E('http://hl7.org/fhir/ValueSet/care-plan-activity-kind')}`);
      expect(r.status).toBe(200);
      expect(contains(r)?.length).toBeGreaterThan(0);
      expect(contains(r)?.filter((c) => c.display === null)).toEqual([]);
      return r;
    }));

    test('Expand › User uploaded ValueSet [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `https://example.com/fhir/ValueSet/clinical-resources${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url, expansion: { timestamp: '2023-09-13T23:24:00.000Z' },
          compose: { include: [{ system: 'http://hl7.org/fhir/resource-types', concept: [{ code: 'Patient' }, { code: 'Practitioner' }, { code: 'Observation' }] }] } });
        const r = await exp(s, `url=${E(url)}`);
        for (const code of ['Patient', 'Practitioner', 'Observation']) expect(contains(r)).toContainEqual({ system: 'http://hl7.org/fhir/resource-types', code, display: code });
        return r;
      });
    });

    test('Expand › CodeSystem resolution [server/src/fhir/operations/expand.test.ts]', async () => {
      const csUrl = `http://example.com/CodeSystem/foo${randomUUID()}`, vsUrl = `http://example.com/ValueSet/bar${randomUUID()}`;
      await same(sides, async (s) => {
        const codeSystem: CodeSystem = { resourceType: 'CodeSystem', status: 'active', url: csUrl, version: '1', content: 'not-present' };
        const imp = async (...codes: [string, string][]) => (await s.call('POST', 'CodeSystem/$import', P({ name: 'system', valueUri: csUrl },
          ...codes.map(([code, display]) => ({ name: 'concept', valueCoding: { code, display } }))))).status;
        await created(s, codeSystem);
        const r2 = await imp(['foo', 'Foo'], ['bar', 'Bar']);
        await created(s, { ...codeSystem, version: '2' });
        const r4 = await imp(['baz', 'Baz'], ['quux', 'Quux']);
        await created(s, { resourceType: 'ValueSet', status: 'active', url: vsUrl, compose: { include: [{ system: csUrl }] } });
        const r = await exp(s, `url=${E(vsUrl)}`);
        expect([r2, r4, r.status]).toEqual([200, 200, 200]);
        return r;
      });
    });

    test('Expand › ValueSet that uses expansion instead of compose [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `https://example.com/fhir/ValueSet/clinical-resources${randomUUID()}`;
      const rt = 'http://hl7.org/fhir/resource-types', nf = 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor';
      const list = [{ system: rt, code: 'Patient', display: 'Patient' }, { system: rt, code: 'Practitioner', display: 'Practitioner' },
        { system: rt, code: 'Observation', display: 'Observation' }, { system: nf, code: 'UNK', display: 'Unknown' }];
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url, expansion: { timestamp: '2024-05-02T06:30:00.000Z', total: 4, contains: list } });
        const r = await exp(s, `url=${E(url)}`), r3 = await exp(s, `url=${E(url)}&filter=pra`);
        expect(contains(r)).toEqual(expect.arrayContaining(list));
        expect(contains(r3)).toEqual(expect.arrayContaining([list[1]]));
        return [r, r3];
      });
    });

    // Medplum's ValueSet includes a url no server holds: 400 not found on both sides. A real cycle is a store unit test only:
    // Medplum would recurse without end.
    test('Expand › Returns error for recursive definition [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `https://example.com/fhir/ValueSet/recursive${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url, compose: { include: [{ valueSet: ['http://example.com/ValueSet/recursive'] }] } });
        const r = await exp(s, `url=${E(url)}`);
        expect(r.status).toBe(400);
        return r;
      });
    });

    test('Expand › Subsumption [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(RELATED)}&count=200`);
      expect(contains(r)?.find((c) => c.system === ROLE_CODE && c.code === 'FRND')?.display).toBe('unrelated friend');
      return unordered(r);
    }));

    test('Expand › Returns error when CodeSystem not found [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `https://example.com/csdne${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url, expansion: { timestamp: '2023-09-13T23:24:00.000Z' },
          compose: { include: [{ system: 'http://example.com/the-codesystem-does-not-exist', concept: [{ code: '0' }] }] } });
        const r = await exp(s, `url=${E(url)}`);
        expect([r.status, text(r)]).toEqual([400, 'CodeSystem http://example.com/the-codesystem-does-not-exist not found']);
        return r;
      });
    });

    test('Expand › Prefers current Project version of common CodeSystem [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `https://example.com/snomed-all${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'CodeSystem', status: 'active', url: 'http://snomed.info/sct', content: 'complete', concept: [{ code: '314159265', display: 'Test SNOMED override' }] },
          { resourceType: 'ValueSet', status: 'active', url, compose: { include: [{ system: 'http://snomed.info/sct' }] } });
        const r = await exp(s, `url=${E(url)}`);
        expect(contains(r)?.[0]).toEqual({ system: 'http://snomed.info/sct', code: '314159265', display: 'Test SNOMED override' });
        return r;
      });
    });

    test('Expand › Expands ValueSet with explicit concepts from fragment CodeSystem [server/src/fhir/operations/expand.test.ts]', async () => {
      const csUrl = `http://example.com/fragment-cs-${randomUUID()}`, vsUrl = `http://example.com/vs-fragment-${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'CodeSystem', status: 'active', url: csUrl, content: 'fragment', concept: [{ code: 'A', display: 'Concept A' }, { code: 'B', display: 'Concept B' }] },
          { resourceType: 'ValueSet', status: 'active', url: vsUrl, compose: { include: [{ system: csUrl, concept: [{ code: 'A', display: 'Concept A' }] }] } });
        const r = await exp(s, `url=${E(vsUrl)}`);
        expect(contains(r)).toEqual([{ system: csUrl, code: 'A', display: 'Concept A' }]);
        return r;
      });
    });

    test('Expand › Returns error when property filter is invalid for CodeSystem [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `https://example.com/invalid-hierarchy${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'CodeSystem', status: 'active', url: 'http://example.com/custom-code-system', content: 'complete', hierarchyMeaning: 'grouped-by', concept: [{ code: 'A', concept: [{ code: 'B' }] }] },
          { resourceType: 'ValueSet', status: 'active', url, compose: { include: [{ system: 'http://example.com/custom-code-system', filter: [{ property: 'concept', op: 'is-a', value: 'A' }] }] } });
        const r = await exp(s, `url=${E(url)}`);
        expect([r.status, text(r)]).toEqual([400, expect.stringMatching(/invalid filter/i)]);
        return r;
      });
    });

    describe('Hierarchy filters', () => {
      const system = `http://example.com/CodeSystem/${randomUUID()}`;
      const isa = `http://example.com/ValueSet/${randomUUID()}`, descendent = `http://example.com/ValueSet/${randomUUID()}`;
      beforeAll(() => both(sides, (s) => created(s,
        { resourceType: 'CodeSystem', status: 'draft', content: 'example', url: system, hierarchyMeaning: 'is-a',
          concept: [{ code: 'PAR', display: 'parent', concept: [{ code: 'CHD', display: 'child' }, { code: 'PET', display: 'pet' }] }] },
        { resourceType: 'ValueSet', url: isa, status: 'draft', compose: { include: [{ system, filter: [{ property: 'code', op: 'is-a', value: 'PAR' }] }] } },
        { resourceType: 'ValueSet', url: descendent, status: 'draft', compose: { include: [{ system, filter: [{ property: 'code', op: 'descendent-of', value: 'PAR' }] }] } })));
      const check = (query: () => string, codes: string[]) => () => same(sides, async (s) => {
        const r = await exp(s, query());
        expect(contains(r)?.map((c) => c.code).sort()).toEqual([...codes].sort());
        return r;
      });
      test('Expand › Hierarchy filters › Includes ancestor code in is-a filter [server/src/fhir/operations/expand.test.ts]', check(() => `url=${isa}`, ['PAR', 'CHD', 'PET']));
      test('Expand › Hierarchy filters › Text filter with is-a [server/src/fhir/operations/expand.test.ts]', check(() => `url=${isa}&filter=chi`, ['CHD']));
      test('Expand › Hierarchy filters › Excludes ancestor code in descendent-of filter [server/src/fhir/operations/expand.test.ts]', check(() => `url=${descendent}`, ['CHD', 'PET']));
      test('Expand › Hierarchy filters › Text filter with descendent-of [server/src/fhir/operations/expand.test.ts]', check(() => `url=${descendent}&filter=pet`, ['PET']));
    });

    describe('Code prefix filter', () => {
      const flat = `http://example.com/CodeSystem/${randomUUID()}`, hierarchy = `http://example.com/CodeSystem/${randomUUID()}`;
      const synonym = `http://example.com/CodeSystem/${randomUUID()}`, ordering = `http://example.com/CodeSystem/${randomUUID()}`;
      const flatConcepts = [{ code: 'HT', display: 'Alpha' }, { code: 'HTX', display: 'Beta' }, { code: 'HTXY', display: 'Gamma' }, { code: 'A_B', display: 'Delta' },
        { code: 'AXB', display: 'Epsilon' }, { code: 'MW1', display: 'Omega Psi' }];
      const vs = { flat: '', concepts: '', expanded: '', isa: '', descendent: '', synonym: '', ordering: '' };
      for (const k of Object.keys(vs) as (keyof typeof vs)[]) vs[k] = `http://example.com/ValueSet/${randomUUID()}`;
      beforeAll(() => both(sides, (s) => created(s,
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: flat, concept: flatConcepts },
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: hierarchy, hierarchyMeaning: 'is-a',
          concept: [{ code: 'MED', display: 'Alpha', concept: [{ code: 'MED100', display: 'Beta' }, { code: 'MED200', display: 'Gamma' }] }] },
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: synonym, concept: [{ code: 'SYN100', display: 'Alpha', designation: [{ value: 'Zeta' }] }] },
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: ordering,
          concept: [{ code: 'ORD30', display: 'Alpha' }, { code: 'ORD10', display: 'Beta' }, { code: 'ORD50', display: 'Gamma' }, { code: 'ORD20', display: 'Delta' }, { code: 'ORD40', display: 'Epsilon' }] },
        { resourceType: 'ValueSet', url: vs.flat, status: 'active', compose: { include: [{ system: flat }] } },
        { resourceType: 'ValueSet', url: vs.concepts, status: 'active', compose: { include: [{ system: flat, concept: flatConcepts }] } },
        { resourceType: 'ValueSet', url: vs.expanded, status: 'active', expansion: { timestamp: '2024-05-02T06:30:00.000Z', total: flatConcepts.length, contains: flatConcepts.map((c) => ({ system: flat, ...c })) } },
        { resourceType: 'ValueSet', url: vs.isa, status: 'active', compose: { include: [{ system: hierarchy, filter: [{ property: 'code', op: 'is-a', value: 'MED' }] }] } },
        { resourceType: 'ValueSet', url: vs.descendent, status: 'active', compose: { include: [{ system: hierarchy, filter: [{ property: 'code', op: 'descendent-of', value: 'MED' }] }] } },
        { resourceType: 'ValueSet', url: vs.synonym, status: 'active', compose: { include: [{ system: synonym }] } },
        { resourceType: 'ValueSet', url: vs.ordering, status: 'active', compose: { include: [{ system: ordering }] } })));

      test('Expand › Code prefix filter › %s ValueSet shape has correct filter behavior › $name [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
        const cases: [string, [string, string][]][] = [
          ['HTX', [['HTX', 'Beta'], ['HTXY', 'Gamma']]], ['htx', [['HTX', 'Beta'], ['HTXY', 'Gamma']]], ['HT', [['HT', 'Alpha']]], ['et', []],
          ['A_B', [['A_B', 'Delta']]], ['psi omega', [['MW1', 'Omega Psi']]],
        ];
        const out = [];
        for (const url of [vs.flat, vs.concepts, vs.expanded]) {
          for (const [filter, expected] of cases) {
            const r = await exp(s, `url=${url}&filter=${E(filter)}`);
            expect([r.status, contains(r) ?? []], `${url} ${filter}`).toEqual([200, expected.map(([code, display]) => ({ system: flat, code, display }))]);
            out.push(r);
          }
        }
        return out;
      }));

      test('Expand › Code prefix filter › $name [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
        const cases: [string, string, string, [string, string][]][] = [
          [vs.isa, hierarchy, 'med', [['MED', 'Alpha'], ['MED100', 'Beta'], ['MED200', 'Gamma']]],
          [vs.isa, hierarchy, 'med2', [['MED200', 'Gamma']]],
          [vs.descendent, hierarchy, 'med', [['MED100', 'Beta'], ['MED200', 'Gamma']]],
          [vs.synonym, synonym, 'SYN', [['SYN100', 'Alpha']]],
          [vs.synonym, synonym, 'zeta', [['SYN100', 'Zeta']]],
        ];
        const out = [];
        for (const [url, system, filter, expected] of cases) {
          const r = await exp(s, `url=${url}&filter=${E(filter)}`);
          expect(r.body.expansion, filter).toMatchObject({ contains: expected.map(([code, display]) => ({ system, code, display })) });
          out.push(r);
        }
        return out;
      }));

      test('Expand › Code prefix filter › Sort order is deterministic when rows tie on relevance [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
        const a = await exp(s, `url=${vs.ordering}&filter=ORD`), b = await exp(s, `url=${vs.ordering}&filter=ORD`);
        expect([contains(a)?.map((c) => c.code), contains(b)?.map((c) => c.code)]).toEqual([['ORD10', 'ORD20', 'ORD30', 'ORD40', 'ORD50'], ['ORD10', 'ORD20', 'ORD30', 'ORD40', 'ORD50']]);
        return [a, b];
      }));

      test('Expand › Code prefix filter › Pagination is stable across offset windows [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
        const pages = [];
        for (const offset of [0, 2, 4]) pages.push(await exp(s, `url=${vs.ordering}&filter=ORD&offset=${offset}&count=2`));
        expect(pages.flatMap((p) => contains(p)?.map((c) => c.code))).toEqual(['ORD10', 'ORD20', 'ORD30', 'ORD40', 'ORD50']);
        return pages;
      }));
    });

    test('Expand › Recursive subsumption [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(RELATED)}&count=200`);
      const c = contains(r) ?? [];
      expect([c.filter((x) => x.system === 'http://terminology.hl7.org/CodeSystem/v2-0131').length, c.filter((x) => x.system === ROLE_CODE).length]).toEqual([12, 110]);
      expect(c.find((x) => x.code === '_PersonalRelationshipRoleType')).toBeDefined();
      return unordered(r);
    }));

    test('Expand › Recursive subsumption with filter [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(RELATED)}&filter=adopt&count=200`);
      expect(contains(r)?.map((c) => c.code).sort()).toEqual(['ADOPTF', 'ADOPTM', 'ADOPTP', 'CHLDADOPT', 'DAUADOPT', 'SONADOPT']);
      return r;
    }));

    test('Expand › Filter out abstract codes [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, `url=${E(RELATED)}&count=200&excludeNotForUI=true`);
      expect(contains(r)?.filter((c) => c.system === ROLE_CODE)).toHaveLength(109);
      expect(contains(r)?.find((c) => c.code === '_PersonalRelationshipRoleType')).toBeUndefined();
      return unordered(r);
    }));

    const propertyFilter = (filter: { property: string; op: '=' | 'in' | 'exists'; value: string }, n: number) => async () => {
      const url = `https://example.com/fhir/ValueSet/property-filter${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url, compose: { include: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm', filter: [filter] }] } });
        const r = await exp(s, `url=${E(url)}`);
        expect(contains(r)).toHaveLength(n);
        if (n === 1) expect(contains(r)?.[0].code).toBe('ERECCAP');
        else expect(contains(r)?.find((c) => c.code === 'ERECCAP')).toBeUndefined();
        return r;
      });
    };
    test('Expand › Property filter [server/src/fhir/operations/expand.test.ts]', propertyFilter({ property: 'status', op: '=', value: 'retired' }, 1));
    test('Expand › Property filter with multiple values [server/src/fhir/operations/expand.test.ts]', propertyFilter({ property: 'status', op: 'in', value: 'preferred,retired' }, 1));
    test('Expand › Property filter with exists=true [server/src/fhir/operations/expand.test.ts]', propertyFilter({ property: 'status', op: 'exists', value: 'true' }, 1));
    test('Expand › Property filter with exists=false [server/src/fhir/operations/expand.test.ts]', propertyFilter({ property: 'status', op: 'exists', value: 'false' }, 160));

    test('Expand › Reference to other ValueSet [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `http://example.com/ValueSet/reference-${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ valueSet: [RELATED] },
          { system: ROLE_CODE, filter: [{ property: 'concept', op: 'is-a', value: 'RESPRSN' }] }, { system: ROLE_CODE, concept: [{ code: 'SEE' }] }] } });
        const r = await exp(s, `url=${E(url)}&count=200`);
        const c = contains(r) ?? [];
        expect([c.filter((x) => x.system === 'http://terminology.hl7.org/CodeSystem/v2-0131').length, c.filter((x) => x.system === ROLE_CODE).length]).toEqual([12, 119]);
        expect(c.find((x) => x.code === '_PersonalRelationshipRoleType')).toBeDefined();
        expect([c.find((x) => x.code === 'HPOWATT')?.display, c.find((x) => x.code === 'SEE')?.display]).toEqual(['healthcare power of attorney', 'Seeing']);
        return unordered(r);
      });
    });

    test('Expand › Display text override [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `http://example.com/ValueSet/reference-${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ system: ROLE_CODE, concept: [{ code: 'SEE', display: 'Seeing-eye doggo' }] }] } });
        const r = await exp(s, `url=${E(url)}&count=200&filter=doggo`);
        expect(contains(r)).toEqual([{ system: ROLE_CODE, code: 'SEE', display: 'Seeing-eye doggo' }]);
        return r;
      });
    });

    test('Expand › Minimum filter size for hierarchical expansion [server/src/fhir/operations/expand.test.ts]', async () => {
      const url = `http://example.com/ValueSet/reference-${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ system: ROLE_CODE, filter: [{ property: 'concept', op: 'is-a', value: '_PersonalRelationshipRoleType' }] }] } });
        const r = await exp(s, `url=${E(url)}&filter=a&count=200`);
        expect([r.status, contains(r)]).toEqual([200, undefined]);
        return r;
      });
    });

    test('Expand › Expand with empty filter [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, 'url=http://hl7.org/fhir/ValueSet/task-status|4.0.1&filter=');
      expect([r.status, contains(r)?.length]).toEqual([200, 12]);
      return r;
    }));

    test('Expand › Expand with trailing quote [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, "url=http://hl7.org/fhir/ValueSet/task-status|4.0.1&filter=a'");
      expect([r.status, contains(r)]).toEqual([200, undefined]);
      return r;
    }));

    test('Expand › Exact code match [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, 'url=http://terminology.hl7.org/ValueSet/v3-RoleCode&filter=MT');
      expect(contains(r)).toEqual([{ system: ROLE_CODE, code: 'MT', display: 'Meat' }]);
      return r;
    }));

    test('Expand › Exact code match with abstract filter [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
      const r = await exp(s, 'url=http://terminology.hl7.org/ValueSet/v3-RoleCode&filter=MT&excludeNotForUI=true');
      expect(contains(r)).toEqual([{ system: ROLE_CODE, code: 'MT', display: 'Meat' }]);
      return r;
    }));

    test('Expand › Include pre-expanded ValueSet [server/src/fhir/operations/expand.test.ts]', async () => {
      const pre = `http://example.com/ValueSet/pre-expanded-${randomUUID()}`, url = `http://example.com/ValueSet/include-expanded-${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'draft', url: pre, expansion: { timestamp: new Date().toISOString(), contains: [{ system: LOINC, code: '82810-3', display: 'Pregnancy status',
          contains: [{ system: LOINC, code: '86645-9', display: 'Pregnancy intention in the next year - Reported' }] }] } },
        { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ valueSet: [pre] },
          { system: LOINC, concept: [{ code: '8480-6', display: 'Systolic BP - Reported' }, { code: '8462-4', display: 'Diastolic BP - Reported' }] }] } });
        const r = await exp(s, `url=${E(url)}&filter=reported`);
        expect(contains(r)).toEqual([{ system: LOINC, code: '86645-9', display: 'Pregnancy intention in the next year - Reported' },
          { system: LOINC, code: '8480-6', display: 'Systolic BP - Reported' }, { system: LOINC, code: '8462-4', display: 'Diastolic BP - Reported' }]);
        return r;
      });
    });

    test('Expand › Resolve synonyms [server/src/fhir/operations/expand.test.ts]', async () => {
      const system = `http://example.com/CodeSystem/${randomUUID()}`, url = `https://example.com/ValueSet/${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'CodeSystem', url: system, property: [{ code: 'SY', uri: 'http://hl7.org/fhir/concept-properties#synonym', type: 'string' }], content: 'example', status: 'draft',
          concept: [{ code: 'UTIC', display: 'Uticarial rash', property: [{ code: 'SY', valueString: 'Hives' }] }] },
        { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ system }] } });
        const r = await exp(s, `url=${E(url)}&filter=hives`);
        expect(contains(r)).toEqual([{ code: 'UTIC', display: 'Hives', system }]);
        return r;
      });
    });

    test('Expand › Condenses multiple synonyms in expansion [server/src/fhir/operations/expand.test.ts]', async () => {
      const system = `urn:uuid:${randomUUID()}`, url = `https://example.com/ValueSet/${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'CodeSystem', url: system, status: 'draft', content: 'example', name: 'Example allergy manifestations', property: [{ code: 'status', type: 'code' }],
          concept: [{ code: 'HIV', display: 'Hives', designation: [{ value: 'Wheal' }, { language: 'fr', value: 'éruption urticaire' }] }] },
        { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ system }] } });
        const r = await exp(s, `url=${url}`);
        expect(contains(r)).toEqual([{ system, code: 'HIV', display: 'Hives', designation: [{ value: 'Wheal' }] }]);
        return r;
      });
    });

    const invalidId = (system: string): CodeSystem => ({ resourceType: 'CodeSystem', url: system, content: 'example', status: 'draft',
      concept: [{ code: 'MSG_INVALID_ID', display: 'ID not accepted', designation: [{ language: 'fr', value: 'ID non accepté' }, { language: 'zh', value: 'ID不被接受' }] }] });
    const translated = (query: string, display: string) => async () => {
      const system = `http://example.com/CodeSystem/${randomUUID()}`, url = `https://example.com/ValueSet/${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, invalidId(system), { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ system }] } });
        const r = await exp(s, `url=${E(url)}&${query}`);
        expect(contains(r)).toEqual([{ code: 'MSG_INVALID_ID', display, system }]);
        return r;
      });
    };
    test('Expand › Searches translated designations [server/src/fhir/operations/expand.test.ts]', translated('filter=non&displayLanguage=fr', 'ID non accepté'));
    test('Expand › Only returns one (default) matching translation [server/src/fhir/operations/expand.test.ts]', translated('filter=accepted', 'ID not accepted'));

    test('Expand › Honors ValueSet designation overrides [server/src/fhir/operations/expand.test.ts]', async () => {
      const system = `http://example.com/CodeSystem/${randomUUID()}`, url = `https://example.com/ValueSet/${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, invalidId(system), { resourceType: 'ValueSet', status: 'draft', url, compose: { include: [{ system, concept: [{ code: 'MSG_INVALID_ID', display: 'Invalid ID',
          designation: [{ language: 'fr', value: 'Identifiant invalide' }, { language: 'es', value: 'ID inválido' }] }] }] } });
        const fr = await exp(s, `url=${E(url)}&filter=invalid&displayLanguage=fr`), es = await exp(s, `url=${E(url)}&displayLanguage=es`);
        expect([contains(fr), contains(es)]).toEqual([[{ code: 'MSG_INVALID_ID', display: 'Identifiant invalide', system }], [{ code: 'MSG_INVALID_ID', display: 'ID inválido', system }]]);
        return [fr, es];
      });
    });

    describe('Display language', () => {
      const flat = `http://example.com/CodeSystem/${randomUUID()}`, hier = `http://example.com/CodeSystem/${randomUUID()}`;
      const abs = `http://example.com/CodeSystem/${randomUUID()}`, prop = `http://example.com/CodeSystem/${randomUUID()}`, paging = `http://example.com/CodeSystem/${randomUUID()}`;
      const vs = { flat: '', concepts: '', pre: '', isa: '', descendent: '', abs: '', prop: '', paging: '' };
      for (const k of Object.keys(vs) as (keyof typeof vs)[]) vs[k] = `http://example.com/ValueSet/${randomUUID()}`;
      beforeAll(() => both(sides, (s) => created(s,
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: flat, concept: [
          { code: 'FVR', display: 'Fever', designation: [{ language: 'fr', value: 'Fièvre' }, { language: 'es', value: 'Fiebre' }] },
          { code: 'NOFR', display: 'Fieval English-only term' }, { code: 'LYMPH', display: 'Naïve lymphocyte' },
          { code: 'TOUX', display: 'Cough', designation: [{ language: 'fr', value: 'Toux' }] }, { code: 'RHUME', display: 'Cold', designation: [{ language: 'fr', value: 'Rhume' }] }] },
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: hier, hierarchyMeaning: 'is-a', concept: [{ code: 'SYMPTOM', display: 'Symptom',
          designation: [{ language: 'fr', value: 'Symptôme' }], concept: [{ code: 'FVR', display: 'Fever', designation: [{ language: 'fr', value: 'Fièvre' }] },
            { code: 'COUGH', display: 'Cough', designation: [{ language: 'fr', value: 'Toux' }] }] }] },
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: abs, property: [{ code: 'notSelectable', uri: ABSTRACT, type: 'boolean' }], concept: [
          { code: 'GRP', display: 'Grouper', designation: [{ language: 'fr', value: 'Groupeur' }], property: [{ code: 'notSelectable', valueBoolean: true }] },
          { code: 'LEAF', display: 'Leaf', designation: [{ language: 'fr', value: 'Feuille' }] }] },
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: prop, property: [{ code: 'status', type: 'code' }], concept: [
          { code: 'ACT', display: 'Active thing', designation: [{ language: 'fr', value: 'Chose active' }], property: [{ code: 'status', valueCode: 'active' }] },
          { code: 'RET', display: 'Retired thing', designation: [{ language: 'fr', value: 'Chose retirée' }], property: [{ code: 'status', valueCode: 'retired' }] }] },
        { resourceType: 'CodeSystem', status: 'active', content: 'complete', url: paging, concept: [
          { code: 'P1', display: 'Item one', designation: [{ language: 'fr', value: 'Article un' }, { language: 'fr', value: 'Article premier' }] },
          { code: 'P2', display: 'Item two', designation: [{ language: 'fr', value: 'Article deux' }] },
          { code: 'P3', display: 'Item three', designation: [{ language: 'fr', value: 'Article trois' }] },
          { code: 'P4', display: 'Item four', designation: [{ language: 'fr', value: 'Article quatre' }] }] },
        { resourceType: 'ValueSet', status: 'active', url: vs.flat, compose: { include: [{ system: flat }] } },
        { resourceType: 'ValueSet', status: 'active', url: vs.concepts, compose: { include: [{ system: flat, concept: [{ code: 'FVR', display: 'Fever' }, { code: 'TOUX', display: 'Cough' },
          { code: 'RHUME', display: 'Cold', designation: [{ language: 'fr', value: 'Rhume sévère' }] }, { code: 'LYMPH', display: 'Naïve lymphocyte', designation: [{ language: 'fr', value: 'Lymphocyte naïf' }] }] }] } },
        { resourceType: 'ValueSet', status: 'active', url: vs.pre, expansion: { timestamp: '2024-05-02T06:30:00.000Z', total: 3, contains: [
          { system: flat, code: 'LYMPH', display: 'Naïve lymphocyte' }, { system: flat, code: 'TCELL', display: 'Naive T cell' }, { system: flat, code: 'TOUX', display: 'Cough' }] } },
        { resourceType: 'ValueSet', status: 'active', url: vs.isa, compose: { include: [{ system: hier, filter: [{ property: 'concept', op: 'is-a', value: 'SYMPTOM' }] }] } },
        { resourceType: 'ValueSet', status: 'active', url: vs.descendent, compose: { include: [{ system: hier, filter: [{ property: 'concept', op: 'descendent-of', value: 'SYMPTOM' }] }] } },
        { resourceType: 'ValueSet', status: 'active', url: vs.abs, compose: { include: [{ system: abs }] } },
        { resourceType: 'ValueSet', status: 'active', url: vs.prop, compose: { include: [{ system: prop, filter: [{ property: 'status', op: '=', value: 'active' }] }] } },
        { resourceType: 'ValueSet', status: 'active', url: vs.paging, compose: { include: [{ system: paging }] } })));

      test('Expand › Display language › $name [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
        const cases: [keyof typeof vs, string, string, [string, string][]][] = [
          ['flat', 'filter=fiev&displayLanguage=fr', flat, [['FVR', 'Fièvre']]],
          ['flat', 'filter=naive', flat, [['LYMPH', 'Naïve lymphocyte']]],
          ['flat', 'filter=fiev', flat, [['NOFR', 'Fieval English-only term']]],
          ['flat', 'filter=fiev&displayLanguage=es', flat, []],
          ['flat', 'filter=fieb&displayLanguage=es', flat, [['FVR', 'Fiebre']]],
          ['flat', 'filter=FVR&displayLanguage=fr', flat, [['FVR', 'Fièvre']]],
          ['concepts', 'filter=FVR&displayLanguage=fr', flat, [['FVR', 'Fièvre']]],
          ['concepts', 'displayLanguage=fr', flat, [['FVR', 'Fièvre'], ['TOUX', 'Toux'], ['RHUME', 'Rhume sévère'], ['LYMPH', 'Lymphocyte naïf']]],
          ['concepts', 'filter=naif&displayLanguage=fr', flat, [['LYMPH', 'Lymphocyte naïf']]],
          ['concepts', 'filter=vre&displayLanguage=fr', flat, [['FVR', 'Fièvre']]],
          ['concepts', 'filter=fiev&displayLanguage=fr', flat, [['FVR', 'Fièvre']]],
          ['concepts', 'filter=sever&displayLanguage=fr', flat, [['RHUME', 'Rhume sévère']]],
          ['pre', 'filter=naive', flat, [['LYMPH', 'Naïve lymphocyte'], ['TCELL', 'Naive T cell']]],
          ['pre', 'filter=na%C3%AFve', flat, [['LYMPH', 'Naïve lymphocyte'], ['TCELL', 'Naive T cell']]],
          ['paging', 'filter=premier&displayLanguage=fr', paging, [['P1', 'Article premier']]],
          ['concepts', 'filter=toux&displayLanguage=fr', flat, [['TOUX', 'Toux']]],
          ['concepts', 'filter=cough&displayLanguage=fr', flat, []],
          ['isa', 'displayLanguage=fr', hier, [['COUGH', 'Toux'], ['FVR', 'Fièvre'], ['SYMPTOM', 'Symptôme']]],
          ['descendent', 'displayLanguage=fr', hier, [['COUGH', 'Toux'], ['FVR', 'Fièvre']]],
          ['isa', 'filter=fiev&displayLanguage=fr', hier, [['FVR', 'Fièvre']]],
          ['abs', 'displayLanguage=fr&excludeNotForUI=true', abs, [['LEAF', 'Feuille']]],
          ['prop', 'displayLanguage=fr', prop, [['ACT', 'Chose active']]],
        ];
        const out = [];
        for (const [v, query, system, expected] of cases) {
          const r = await exp(s, `url=${E(vs[v])}&${query}`);
          // Sorted, as Medplum's test: an expansion without a text filter has no order of its own.
          expect([r.status, [...(contains(r) ?? [])].sort((a, b) => a.code!.localeCompare(b.code!))], `${v} ${query}`)
            .toEqual([200, expected.map(([code, display]) => ({ system, code, display })).sort((a, b) => a.code.localeCompare(b.code))]);
          out.push(r);
        }
        return out;
      }));

      test('Expand › Display language › Paging counts codes, not translation rows [server/src/fhir/operations/expand.test.ts]', () => same(sides, async (s) => {
        const r = await exp(s, `url=${E(vs.paging)}&filter=article&displayLanguage=fr&count=2`);
        const c = contains(r) ?? [];
        expect([c.length, new Set(c.map((x) => x.code)).size, c.every((x) => /^Article /.test(x.display!))]).toEqual([2, 2, true]);
        return r;
      }));
    });
  });

  // valuesetvalidatecode.test.ts. Medplum's Super Admin is the parity project's admin (R7).
  describe('ValueSet validate-code', () => {
    const system = ROLE_CODE, url = `http://example.com/test-valueset-${randomUUID()}`;
    const ids: Record<string, string> = {};
    beforeAll(() => both(sides, async (s) => {
      ids[s.name] = (await s.create<ValueSet>({ resourceType: 'ValueSet', url, name: 'testValueSet', title: 'Test Value Set', status: 'active', compose: { include: [
        { system, concept: [{ code: 'WARD' }] },
        { system, filter: [{ property: 'concept', op: 'descendent-of', value: '_PersonalRelationshipRoleType' }] },
        { system, filter: [{ property: 'status', op: '=', value: 'deprecated' }] },
        { system, filter: [{ property: 'child', op: 'in', value: 'PEDICU,PEDE' }] },
      ] } })).id;
    }));
    const call = async (s: Side, method: string, path: string, body?: unknown) => { const g = await s.call(method, path, body); return { status: g.status, body: g.json }; };
    const post = (s: Side, ...parameter: ParametersParameter[]) => call(s, 'POST', 'ValueSet/$validate-code', P(...parameter));
    const out = (r: { body: any }, name: string) => r.body?.parameter?.find((p: ParametersParameter) => p.name === name);
    const ok = (r: { status: number; body: any }, result: boolean, display?: string) => {
      expect([r.status, r.body.resourceType, out(r, 'result')?.valueBoolean, out(r, 'display')?.valueString]).toEqual([200, 'Parameters', result, display]);
      return r;
    };

    test('ValueSet validate-code › Explicitly included code succeeds [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) => ok(await post(s, { name: 'url', valueUri: url }, { name: 'coding', valueCoding: { system, code: 'WARD' } }), true, 'ward')));

    test('ValueSet validate-code › Filter included code succeeds: %j [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) => {
      const rs = [];
      for (const params of [
        [{ name: 'system', valueUri: system }, { name: 'code', valueCode: 'ITWINBRO' }],
        [{ name: 'coding', valueCoding: { system, code: 'ITWINBRO' } }],
        [{ name: 'codeableConcept', valueCodeableConcept: { coding: [{ system, code: 'VET' }, { system, code: 'ITWINBRO' }] } }],
      ] as ParametersParameter[][]) rs.push(ok(await post(s, { name: 'url', valueUri: url }, ...params), true, 'identical twin brother'));
      return rs;
    }));

    test('ValueSet validate-code › Filter excluded code fails [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) => ok(await post(s, { name: 'url', valueUri: url }, { name: 'coding', valueCoding: { system, code: 'RETIREE' } }), false)));

    test('ValueSet validate-code › Returns negative result on display mismatch [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) =>
      ok(await post(s, { name: 'url', valueUri: url }, { name: 'coding', valueCoding: { system, code: 'AUNT' } }, { name: 'display', valueString: 'ant' }), false, 'aunt')));

    test('ValueSet validate-code › Returns negative result when no coding matches [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) =>
      ok(await post(s, { name: 'url', valueUri: url }, { name: 'coding', valueCoding: { system: 'http://example.com/other', code: 'foo' } }), false)));

    test('ValueSet validate-code › Returns error when no coding specified [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'url', valueUri: url }, { name: 'code', valueCode: 'RETIREE' });
      expect([r.status, r.body.resourceType]).toEqual([400, 'OperationOutcome']);
      return r;
    }));

    test('ValueSet validate-code › Validates coding via property filter [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) => ok(await post(s, { name: 'url', valueUri: url }, { name: 'coding', valueCoding: { system, code: 'NOK' } }), true, 'next of kin')));

    test('ValueSet validate-code › Validates coding via property filter with multiple values [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) =>
      ok(await post(s, { name: 'url', valueUri: url }, { name: 'coding', valueCoding: { system, code: 'PEDC' } }), true, 'Pediatrics clinic')));

    test('ValueSet validate-code › Validates code when only example CodeSystem is present [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) =>
      ok(await post(s, { name: 'url', valueUri: OBS }, { name: 'coding', valueCoding: { system: LOINC, code: '10727-6' } }), true)));

    test('ValueSet validate-code › Does not validate display without authoritative CodeSystem [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) =>
      ok(await post(s, { name: 'url', valueUri: OBS }, { name: 'coding', valueCoding: { system: LOINC, code: '10727-6' } }, { name: 'display', valueString: 'Cat parasites' }), false)));

    test('ValueSet validate-code › GET endpoint [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) => ok(await call(s, 'GET', `ValueSet/$validate-code?url=${url}&system=${system}&code=WARD`), true, 'ward')));

    test('ValueSet validate-code › GET instance endpoint [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) => ok(await call(s, 'GET', `ValueSet/${ids[s.name]}/$validate-code?system=${system}&code=WARD`), true, 'ward')));

    test('ValueSet validate-code › Instance endpoint with coding [server/src/fhir/operations/valuesetvalidatecode.test.ts]', () => same(sides, async (s) =>
      ok(await call(s, 'POST', `ValueSet/${ids[s.name]}/$validate-code`, P({ name: 'coding', valueCoding: { system, code: 'WARD' } })), true, 'ward')));

    test('ValueSet validate-code › Validates code against an include with multiple filters [server/src/fhir/operations/valuesetvalidatecode.test.ts]', async () => {
      const multi = `http://example.com/multi-filter-${randomUUID()}`, vsUrl = `http://example.com/multi-filter-vs-${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'CodeSystem', url: multi, status: 'active', content: 'complete', hierarchyMeaning: 'is-a', property: [{ code: 'kind', type: 'code' }],
          concept: [{ code: 'ROOT', display: 'Root', concept: [{ code: 'CHILD1', display: 'Child One', property: [{ code: 'kind', valueCode: 'primary' }] },
            { code: 'CHILD2', display: 'Child Two', property: [{ code: 'kind', valueCode: 'secondary' }] }] }] },
        { resourceType: 'ValueSet', url: vsUrl, status: 'active', compose: { include: [{ system: multi, filter: [{ property: 'concept', op: 'descendent-of', value: 'ROOT' }, { property: 'kind', op: '=', value: 'primary' }] }] } });
        const r = await post(s, { name: 'url', valueUri: vsUrl }, { name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: multi, code: 'ROOT' }, { system: multi, code: 'CHILD2' }, { system: multi, code: 'CHILD1' }] } });
        expect(r.body.parameter).toEqual([{ name: 'result', valueBoolean: true }, { name: 'display', valueString: 'Child One' }]);
        return r;
      });
    });

    test('ValueSet validate-code › Validates system-less coding matched by a later include [server/src/fhir/operations/valuesetvalidatecode.test.ts]', async () => {
      const a = `http://example.com/system-a-${randomUUID()}`, b = `http://example.com/system-b-${randomUUID()}`, vsUrl = `http://example.com/two-system-vs-${randomUUID()}`;
      await same(sides, async (s) => {
        await created(s, { resourceType: 'CodeSystem', url: a, status: 'active', content: 'complete', concept: [{ code: 'ALPHA', display: 'Alpha from A' }] },
          { resourceType: 'CodeSystem', url: b, status: 'active', content: 'complete', concept: [{ code: 'TARGET', display: 'Target from B' }] },
          { resourceType: 'ValueSet', url: vsUrl, status: 'active', compose: { include: [{ system: a, concept: [{ code: 'ALPHA' }] }, { system: b, concept: [{ code: 'TARGET' }] }] } });
        const r = await post(s, { name: 'url', valueUri: vsUrl }, { name: 'coding', valueCoding: { code: 'TARGET' } });
        expect(r.body.parameter).toEqual([{ name: 'result', valueBoolean: true }, { name: 'display', valueString: 'Target from B' }]);
        return r;
      });
    });

    test('ValueSet validate-code › Falls back to validating system URL when CodeSystem unavailable [server/src/fhir/operations/valuesetvalidatecode.test.ts]', async () => {
      const other = `http://example.com/other-codes-${randomUUID()}`, vsUrl = `http://example.com/test-valueset-${randomUUID()}`, code = randomUUID();
      await same(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', url: vsUrl, status: 'active', compose: { include: [{ system: other }] } });
        return ok(await post(s, { name: 'url', valueUri: vsUrl }, { name: 'coding', valueCoding: { system: other, code } }), true);
      });
    });
  });

  // Review Focus 2: a large built-in ValueSet (a whole v3 CodeSystem) pages as Medplum does.
  test('a large built-in ValueSet pages by count and offset [store-plan-2]', () => same(sides, async (s) => {
    const r = await exp(s, 'url=http://terminology.hl7.org/ValueSet/v3-RoleCode&count=10&offset=10');
    expect([r.status, r.body.expansion.total, contains(r)?.length]).toEqual([200, 11, 10]);
    return r;
  }));

  // Where the store follows R4 and Medplum does not (README "Deliberate differences from Medplum").
  describe('differs on purpose', () => {
    test('differs on purpose: compose.exclude removes codes from $expand and $validate-code [store-plan-2]', async () => {
      const url = `http://example.com/ValueSet/exclude-${randomUUID()}`;
      const [medplum, store] = await both(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url, compose: { include: [{ system: 'http://hl7.org/fhir/task-status' }],
          exclude: [{ system: 'http://hl7.org/fhir/task-status', concept: [{ code: 'draft' }] }] } });
        const r = await exp(s, `url=${E(url)}`);
        const v = (await s.call('GET', `ValueSet/$validate-code?url=${E(url)}&system=http://hl7.org/fhir/task-status&code=draft`)).json;
        return [contains(r)?.some((c) => c.code === 'draft'), v.parameter[0].valueBoolean];
      });
      expect(medplum).toEqual([true, true]); // Medplum ignores compose.exclude
      expect(store).toEqual([false, false]);
    });

    test('differs on purpose: a filter op $expand does not implement is 400 [store-plan-2]', async () => {
      const url = `http://example.com/ValueSet/regex-${randomUUID()}`;
      const [medplum, store] = await both(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url, compose: { include: [{ system: ROLE_CODE, filter: [{ property: 'code', op: 'regex', value: 'MT.*' }] }] } });
        const r = await exp(s, `url=${E(url)}`);
        return [r.status, contains(r)?.length ?? text(r)];
      });
      expect(medplum).toEqual([200, undefined]); // no codes
      expect(store).toEqual([400, 'ValueSet filter op regex is not supported']);
    });

    test('differs on purpose: a nested ValueSet in $validate-code; instance-level $expand [store-plan-2]', async () => {
      const inner = `http://example.com/ValueSet/inner-${randomUUID()}`, outer = `http://example.com/ValueSet/outer-${randomUUID()}`;
      const [medplum, store] = await both(sides, async (s) => {
        await created(s, { resourceType: 'ValueSet', status: 'active', url: inner, compose: { include: [{ system: 'http://hl7.org/fhir/task-status' }] } });
        const o = await s.create<ValueSet>({ resourceType: 'ValueSet', status: 'active', url: outer, compose: { include: [{ valueSet: [inner] }] } });
        const v = await s.call('GET', `ValueSet/$validate-code?url=${E(outer)}&system=http://hl7.org/fhir/task-status&code=draft`);
        const x = await s.call('GET', `ValueSet/${o.id}/$expand?count=1`);
        return [v.status, v.json?.parameter?.[0]?.valueBoolean ?? v.json?.issue?.[0]?.details?.text, x.status, x.json?.expansion?.contains?.[0]?.code];
      });
      expect(medplum).toEqual([400, 'Missing system URL for ValueSet include', 404, undefined]);
      expect(store).toEqual([200, true, 200, 'draft']);
    });

    test('differs on purpose: unsupported $expand and ValueSet $validate-code inputs are 400 [store-plan-2]', async () => {
      const [medplum, store] = await both(sides, async (s) => {
        const out: unknown[] = [];
        for (const [name, v] of [['valueSetVersion', '1'], ['date', '2024'], ['activeOnly', 'true'], ['designation', 'en']]) {
          const r = await exp(s, `url=${E(OBS)}&${name}=${v}`);
          out.push([r.status, text(r)]);
        }
        for (const [name, v] of [['systemVersion', '1'], ['date', '2024'], ['abstract', 'true'], ['displayLanguage', 'en']]) {
          const g = await s.call('GET', `ValueSet/$validate-code?url=${E(OBS)}&system=${LOINC}&code=x&${name}=${v}`);
          out.push([g.status, g.json?.issue?.[0]?.details?.text]);
        }
        return out;
      });
      expect(medplum).toEqual(Array(8).fill([200, undefined])); // Medplum ignores them
      expect(store).toEqual([...['valueSetVersion', 'date', 'activeOnly', 'designation'].map((n) => [400, `$expand: parameter ${n} is not supported`]),
        ...['systemVersion', 'date', 'abstract', 'displayLanguage'].map((n) => [400, `$validate-code: parameter ${n} is not supported`])]);
    });
  });
});
