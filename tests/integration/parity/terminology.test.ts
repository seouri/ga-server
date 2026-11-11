// Terminology (store plan 2). Built-ins: Medplum shows its R4 project's CodeSystems and ValueSets to every project, read-only;
// the store seeds the same bundles (not Medplum ports: titles carry [store-plan-2]; built-in ids differ between the two
// servers, so records are found by url). Then the ported Medplum operation tests, one describe per file, sharing one login.
// Medplum's database assertions (assertCodeExists, assertPropertyExists, assertCodeMissing) become $lookup calls.
import { randomUUID } from 'node:crypto';
import type { CodeSystem, Parameters, ParametersParameter } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, paritySides, q, same, search, type Side } from './harness.ts';

const URL_ = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';

const P = (...parameter: ParametersParameter[]): Parameters => ({ resourceType: 'Parameters', parameter });
const prop = (code: string, property: string, value: string): ParametersParameter =>
  ({ name: 'property', part: [{ name: 'code', valueCode: code }, { name: 'property', valueCode: property }, { name: 'value', valueString: value }] });
// Medplum's $lookup joins rows with no ORDER BY (its tests use arrayContaining): parameters of one name are sorted.
const sorted = (j: any) => {
  if (j?.resourceType !== 'Parameters' || !j.parameter) return j;
  const rank = [...new Set(j.parameter.map((x: ParametersParameter) => x.name))];
  return { ...j, parameter: [...j.parameter].sort((a, b) => rank.indexOf(a.name) - rank.indexOf(b.name) || JSON.stringify(a).localeCompare(JSON.stringify(b))) };
};
// An operation call: status and body (Parameters sorted as above).
const call = async (s: Side, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const g = await s.call(method, path, body, headers);
  return { status: g.status, body: sorted(g.json) };
};

const ROLE_CODE = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode';

describe.skipIf(SQLITE)('built-in terminology (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  test('built-in totals match [store-plan-2]', () => same(sides, async (s) => {
    const totals = [];
    for (const type of ['CodeSystem', 'ValueSet']) totals.push((await search(s, q(type, ['_summary', 'count']))).total);
    expect(totals).toEqual([1108, 1346]);
    return totals;
  }));

  test('a write to a built-in is 403 [store-plan-2]', () => same(sides, async (s) => {
    const cs = (await search(s, q('CodeSystem', ['url', URL_]))).entry?.[0]?.resource as { id: string; status: string };
    expect(cs?.id).toBeTruthy();
    const out = [];
    for (const [method, body] of [['PUT', { ...cs, status: 'retired' }], ['PATCH', [{ op: 'replace', path: '/status', value: 'retired' }]], ['DELETE', undefined]] as const) {
      const g = await s.call(method, `CodeSystem/${cs.id}`, body, method === 'PATCH' ? { 'content-type': 'application/json-patch+json' } : {});
      out.push({ method, status: g.status, code: g.json?.issue?.[0]?.code, text: g.json?.issue?.[0]?.details?.text });
    }
    expect(out.map((o) => o.status)).toEqual([403, 403, 403]);
    expect(((await search(s, q('CodeSystem', ['url', URL_]))).entry?.[0]?.resource as { status?: string } | undefined)?.status).toBe(cs.status); // unchanged
    return out;
  }));

  // codesystemlookup.test.ts
  describe('CodeSystem lookup', () => {
    const url = `http://example.com/test-code-system-${randomUUID()}`;
    const testCodeSystem: CodeSystem = {
      resourceType: 'CodeSystem', url, name: 'testCodeSystem', title: 'Test Code System', status: 'active', hierarchyMeaning: 'is-a', content: 'complete',
      property: [
        { code: 'parent', uri: 'http://hl7.org/fhir/concept-properties#parent', description: 'Test parent property', type: 'code' },
        { code: 'abstract', uri: 'http://hl7.org/fhir/concept-properties#notSelectable', description: 'Code is not a real thing', type: 'boolean' },
        { code: 'deprecated', description: 'Code is no longer in use', type: 'boolean' },
        { code: 'publishedOn', type: 'dateTime' },
        { code: 'rank', type: 'integer' },
      ],
      concept: [{ code: '4', display: 'Procedure', concept: [{ code: '3', display: 'Procedure on head', concept: [{
        code: '2', display: 'Biopsy of head', concept: [{ code: '1', display: 'Biopsy of brain' }], property: [{ code: 'abstract', valueBoolean: true }],
      }] }] }],
    };
    const cs: Record<string, CodeSystem & { id: string }> = {};
    beforeAll(async () => { await both(sides, async (s) => { cs[s.name] = await s.create(testCodeSystem); }); });
    const brain = [{ name: 'name', valueString: 'Test Code System' }, { name: 'display', valueString: 'Biopsy of brain' },
      { name: 'property', part: [{ name: 'code', valueCode: 'parent' }, { name: 'value', valueCode: '2' }, { name: 'description', valueString: 'Biopsy of head' }] }];
    const post = (s: Side, ...parameter: ParametersParameter[]) => call(s, 'POST', 'CodeSystem/$lookup', P(...parameter));

    test('CodeSystem lookup › Success [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'system', valueUri: url }, { name: 'code', valueCode: '1' });
      expect(r).toMatchObject({ status: 200, body: { parameter: brain } });
      return r;
    }));

    test('CodeSystem lookup › Renders description for relationship and simple properties [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'system', valueUri: url }, { name: 'code', valueCode: '2' });
      expect(r.status).toBe(200);
      expect(r.body.parameter).toEqual(expect.arrayContaining([
        { name: 'property', part: [{ name: 'code', valueCode: 'parent' }, { name: 'value', valueCode: '3' }, { name: 'description', valueString: 'Procedure on head' }] },
        { name: 'property', part: [{ name: 'code', valueCode: 'abstract' }, { name: 'value', valueBoolean: true }, { name: 'description', valueString: 'Code is not a real thing' }] },
      ]));
      return r;
    }));

    test('CodeSystem lookup › Coding parameter [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'coding', valueCoding: { system: url, code: '1' } });
      expect(r).toMatchObject({ status: 200, body: { parameter: brain } });
      return r;
    }));

    test('CodeSystem lookup › Not found [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'system', valueUri: url }, { name: 'code', valueCode: 'wrong code' });
      expect(r).toMatchObject({ status: 404, body: { issue: [{ severity: 'error', code: 'not-found', details: { text: 'Not found' } }] } });
      return r;
    }));

    test('CodeSystem lookup › No full coding specified [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'code', valueCode: '1' });
      expect(r).toMatchObject({ status: 400, body: { issue: [{ severity: 'error', code: 'invalid', details: { text: 'No code system specified' } }] } });
      return r;
    }));

    test('CodeSystem lookup › Lookup using specific CodeSystem version [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      await s.create({ ...testCodeSystem, version: '3.1.4', concept: [{ code: '5', display: 'Neologism' }] });
      const r = await post(s, { name: 'coding', valueCoding: { system: url, code: '5' } }, { name: 'version', valueString: '3.1.4' });
      expect(r).toMatchObject({ status: 200, body: { parameter: [{ name: 'name', valueString: 'Test Code System' }, { name: 'display', valueString: 'Neologism' }] } });
      return r;
    }));

    test('CodeSystem lookup › Prefers complete CodeSystem over example even when example is newer [server/src/fhir/operations/codesystemlookup.test.ts]', async () => {
      const sharedUrl = `http://example.com/shared-code-system-${randomUUID()}`;
      await same(sides, async (s) => {
        await s.create<CodeSystem>({ resourceType: 'CodeSystem', url: sharedUrl, name: 'completeCodeSystem', status: 'active', content: 'complete', date: '2024-03-12', concept: [{ code: 'complete-only', display: 'Complete Only' }] });
        await s.create<CodeSystem>({ resourceType: 'CodeSystem', url: sharedUrl, name: 'exampleCodeSystem', status: 'active', content: 'example', date: '2026-06-27', concept: [{ code: 'example-only', display: 'Example Only' }] });
        const found = await post(s, { name: 'system', valueUri: sharedUrl }, { name: 'code', valueCode: 'complete-only' });
        expect(found).toMatchObject({ status: 200, body: { parameter: [{ name: 'name', valueString: 'completeCodeSystem' }, { name: 'display', valueString: 'Complete Only' }] } });
        const notFound = await post(s, { name: 'system', valueUri: sharedUrl }, { name: 'code', valueCode: 'example-only' });
        expect(notFound.status).toBe(404);
        return [found, notFound];
      });
    });

    test('CodeSystem lookup › Excludes retired CodeSystem from selection [server/src/fhir/operations/codesystemlookup.test.ts]', async () => {
      const retiredUrl = `http://example.com/retired-code-system-${randomUUID()}`;
      await same(sides, async (s) => {
        await s.create<CodeSystem>({ resourceType: 'CodeSystem', url: retiredUrl, name: 'retiredCodeSystem', status: 'retired', content: 'complete', concept: [{ code: 'retired-code', display: 'Retired Code' }] });
        const r = await post(s, { name: 'system', valueUri: retiredUrl }, { name: 'code', valueCode: 'retired-code' });
        expect(r.status).toBe(400);
        return r;
      });
    });

    test('CodeSystem lookup › GET endpoint [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'GET', q('CodeSystem/$lookup', ['system', url], ['code', '1']));
      expect(r).toMatchObject({ status: 200, body: { parameter: brain } });
      return r;
    }));

    test('CodeSystem lookup › GET instance endpoint [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'GET', `CodeSystem/${cs[s.name].id}/$lookup?code=1`);
      expect(r).toMatchObject({ status: 200, body: { parameter: brain } });
      return r;
    }));

    test('CodeSystem lookup › Error on instance system URL mismatch [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'GET', `CodeSystem/${cs[s.name].id}/$lookup?system=incorrect&code=1`);
      expect(r).toMatchObject({ status: 404, body: { issue: [{ severity: 'error', code: 'not-found', details: { text: 'Not found' } }] } });
      return r;
    }));

    test('CodeSystem lookup › Instance endpoint with coding [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'POST', `CodeSystem/${cs[s.name].id}/$lookup`, P({ name: 'coding', valueCoding: { code: '1' } }));
      expect(r).toMatchObject({ status: 200, body: { parameter: brain } });
      return r;
    }));

    test('CodeSystem lookup › Error on instance coding system mismatch [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'POST', `CodeSystem/${cs[s.name].id}/$lookup`, P({ name: 'coding', valueCoding: { system: 'incorrect', code: '1' } }));
      expect(r).toMatchObject({ status: 404, body: { issue: [{ severity: 'error', code: 'not-found', details: { text: 'Not found' } }] } });
      return r;
    }));

    test('CodeSystem lookup › Correctly renders imported properties of different types [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const imported = await call(s, 'POST', `CodeSystem/${cs[s.name].id}/$import`, P(prop('1', 'abstract', 'false'), prop('1', 'deprecated', '1'),
        prop('1', 'publishedOn', '2020-01-01'), prop('1', 'rank', '418')), { 'x-medplum': 'extended' });
      expect(imported.status).toBe(200);
      const r = await call(s, 'POST', `CodeSystem/${cs[s.name].id}/$lookup`, P({ name: 'code', valueCode: '1' }));
      expect(r.status).toBe(200);
      expect(r.body.parameter).toEqual(expect.arrayContaining([...brain,
        { name: 'property', part: [{ name: 'code', valueCode: 'abstract' }, { name: 'value', valueBoolean: false }, { name: 'description', valueString: 'Code is not a real thing' }] },
        { name: 'property', part: [{ name: 'code', valueCode: 'deprecated' }, { name: 'value', valueBoolean: true }, { name: 'description', valueString: 'Code is no longer in use' }] },
        { name: 'property', part: [{ name: 'code', valueCode: 'publishedOn' }, { name: 'value', valueDateTime: '2020-01-01' }] },
        { name: 'property', part: [{ name: 'code', valueCode: 'rank' }, { name: 'value', valueInteger: 418 }] },
      ]));
      return [imported, r];
    }));

    // R6: Medplum 5.2.14's findTerminologyResource drops a `|version` suffix (and $lookup then compares the suffixed system with the
    // CodeSystem's url); the store honours the version, as an R4 canonical means.
    test('differs on purpose: url|version selects that version [store-plan-2]', async () => {
      const vUrl = `http://example.com/versioned-${randomUUID()}`;
      const [medplum, store] = await both(sides, async (s) => {
        for (const [version, display] of [['1', 'One'], ['2', 'Two']]) await s.create<CodeSystem>({ resourceType: 'CodeSystem', url: vUrl, version, status: 'active', content: 'complete', concept: [{ code: 'A', display }] });
        return call(s, 'POST', 'CodeSystem/$lookup', P({ name: 'system', valueUri: `${vUrl}|1` }, { name: 'code', valueCode: 'A' }));
      });
      expect(medplum.status).toBe(404);
      expect([store.status, store.body.parameter?.find((x: ParametersParameter) => x.name === 'display')?.valueString]).toEqual([200, 'One']);
    });

    // R4 defines date, displayLanguage and property for $lookup; Medplum ignores them, the store refuses them (unsupported is loud).
    // An operation's POST body is a Parameters (R4); Medplum also reads a plain JSON object of parameter names.
    test('differs on purpose: unsupported $lookup inputs are 400 [store-plan-2]', async () => {
      const [medplum, store] = await both(sides, async (s) => {
        const out = [];
        for (const extra of [{ name: 'date', valueDateTime: '2020-01-01' }, { name: 'displayLanguage', valueCode: 'fr' }, { name: 'property', valueCode: 'parent' }]) {
          const r = await post(s, { name: 'system', valueUri: url }, { name: 'code', valueCode: '1' }, extra);
          out.push([r.status, r.body.issue?.[0]?.details?.text]);
        }
        const plain = await call(s, 'POST', 'CodeSystem/$lookup', { system: url, code: '1' });
        return [...out, [plain.status, plain.body.issue?.[0]?.details?.text]];
      });
      expect(medplum.map((x) => x[0])).toEqual([200, 200, 200, 200]);
      expect(store).toEqual([...['date', 'displayLanguage', 'property'].map((n) => [400, `$lookup: parameter ${n} is not supported`]), [400, 'Expected a Parameters']]);
    });

    test('CodeSystem lookup › Outputs translated designations [server/src/fhir/operations/codesystemlookup.test.ts]', () => same(sides, async (s) => {
      const c = await s.create<CodeSystem>({ resourceType: 'CodeSystem', status: 'draft', content: 'example', name: 'Example allergy manifestations', property: [{ code: 'status', type: 'code' }],
        concept: [{ code: 'HIV', display: 'Hives', designation: [{ value: 'Wheal' }, { language: 'fr', value: 'éruption urticaire' }] }] });
      const r = await call(s, 'GET', `CodeSystem/${c.id}/$lookup?code=HIV`);
      expect(r.status).toBe(200);
      expect(r.body.parameter).toEqual(expect.arrayContaining([
        { name: 'name', valueString: 'Example allergy manifestations' }, { name: 'display', valueString: 'Hives' },
        { name: 'designation', part: [{ name: 'language', valueCode: 'fr' }, { name: 'value', valueString: 'éruption urticaire' }] },
        { name: 'designation', part: [{ name: 'value', valueString: 'Wheal' }] },
      ]));
      return r;
    }));
  });
});
