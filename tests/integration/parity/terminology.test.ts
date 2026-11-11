// Terminology (store plan 2). Built-ins: Medplum shows its R4 project's CodeSystems and ValueSets to every project, read-only;
// the store seeds the same bundles (not Medplum ports: titles carry [store-plan-2]; built-in ids differ between the two
// servers, so records are found by url). Then the ported Medplum operation tests, one describe per file, sharing one login.
// Medplum's database assertions (assertCodeExists, assertPropertyExists, assertCodeMissing) become $lookup calls.
import { randomUUID } from 'node:crypto';
import type { CodeSystem, Parameters, ParametersParameter, ValueSet } from '@medplum/fhirtypes';
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

  // codesystemvalidatecode.test.ts (Medplum's beforeAll uses a Super Admin; a project admin makes the same calls)
  describe('CodeSystem validate-code', () => {
    const testCodeSystem: CodeSystem = { resourceType: 'CodeSystem', url: `http://example.com/test-code-system-${randomUUID()}`, name: 'testCodeSystem',
      title: 'Test Code System', status: 'active', hierarchyMeaning: 'is-a', content: 'not-present' };
    const url = testCodeSystem.url!;
    const cs: Record<string, CodeSystem & { id: string }> = {};
    beforeAll(async () => {
      await both(sides, async (s) => {
        cs[s.name] = await s.create(testCodeSystem);
        const r = await call(s, 'POST', 'CodeSystem/$import', P({ name: 'system', valueUri: url }, { name: 'concept', valueCoding: { code: '1', display: 'Biopsy of brain' } },
          { name: 'designation', part: [{ name: 'code', valueCode: '1' }, { name: 'language', valueCode: 'fr' }, { name: 'value', valueString: 'biopsie du tissu encéphalique' }] },
          { name: 'concept', valueCoding: { code: '2', display: 'Biopsy of head' } }));
        expect(r.status, s.name).toBe(200);
      });
    });
    const yes = (display: string) => ({ status: 200, body: { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }, { name: 'display', valueString: display }] } });
    const no = { status: 200, body: { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: false }] } };
    const post = (s: Side, ...parameter: ParametersParameter[]) => call(s, 'POST', 'CodeSystem/$validate-code', P(...parameter));

    test('CodeSystem validate-code › Success [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'url', valueUri: url }, { name: 'code', valueCode: '1' });
      expect(r).toEqual(yes('Biopsy of brain'));
      return r;
    }));

    test('CodeSystem validate-code › Coding parameter [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'coding', valueCoding: { system: url, code: '1' } });
      expect(r).toEqual(yes('Biopsy of brain'));
      return r;
    }));

    test('CodeSystem validate-code › Not found [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'url', valueUri: url }, { name: 'code', valueCode: 'wrong code' });
      expect(r).toEqual(no);
      return r;
    }));

    test('CodeSystem validate-code › No full coding specified [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await post(s, { name: 'code', valueCode: 'wrong code' });
      expect(r).toMatchObject({ status: 400, body: { issue: [{ severity: 'error', code: 'invalid', details: { text: 'No code system specified' } }] } });
      return r;
    }));

    test('CodeSystem validate-code › Falls back to validating system URL [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const system = `https://example.com/${randomUUID()}`;
      const y = await post(s, { name: 'coding', valueCoding: { system, code: '1' } });
      expect(y).toEqual({ status: 200, body: { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] } });
      const n = await post(s, { name: 'url', valueUri: 'http://example.com/other-system' }, { name: 'coding', valueCoding: { system, code: '1' } });
      expect(n).toEqual(no);
      return [y, n];
    }));

    test('CodeSystem validate-code › Lookup using specific CodeSystem version [server/src/fhir/operations/codesystemvalidatecode.test.ts]', async () => {
      const versionedUrl = `http://example.com/versioned-code-system-${randomUUID()}`;
      await same(sides, async (s) => {
        for (const [version, display] of [['2.7.1', 'Archaism'], ['3.1.4', 'Neologism']]) {
          await s.create<CodeSystem>({ ...testCodeSystem, url: versionedUrl, content: 'complete', version, concept: [{ code: '5', display }] });
        }
        const r = await post(s, { name: 'coding', valueCoding: { system: versionedUrl, code: '5' } }, { name: 'version', valueString: '2.7.1' });
        expect(r).toEqual(yes('Archaism'));
        return r;
      });
    });

    test('CodeSystem validate-code › GET endpoint [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'GET', q('CodeSystem/$validate-code', ['url', url], ['code', '1']));
      expect(r).toEqual(yes('Biopsy of brain'));
      return r;
    }));

    test('CodeSystem validate-code › GET instance endpoint [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'GET', `CodeSystem/${cs[s.name].id}/$validate-code?code=1`);
      expect(r).toEqual(yes('Biopsy of brain'));
      return r;
    }));

    test('CodeSystem validate-code › Fail on instance system URL mismatch [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'GET', `CodeSystem/${cs[s.name].id}/$validate-code?url=incorrect&code=1`);
      expect(r).toEqual(no);
      return r;
    }));

    test('CodeSystem validate-code › Instance endpoint with coding [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'POST', `CodeSystem/${cs[s.name].id}/$validate-code`, P({ name: 'coding', valueCoding: { code: '1' } }));
      expect(r).toEqual(yes('Biopsy of brain'));
      return r;
    }));

    test('CodeSystem validate-code › Fail on instance coding system mismatch [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'POST', `CodeSystem/${cs[s.name].id}/$validate-code`, P({ name: 'coding', valueCoding: { system: 'incorrect', code: '1' } }));
      expect(r).toEqual(no);
      return r;
    }));

    test('CodeSystem validate-code › Returns specified displayLanguage [server/src/fhir/operations/codesystemvalidatecode.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'POST', `CodeSystem/${cs[s.name].id}/$validate-code`, P({ name: 'coding', valueCoding: { system: url, code: '1' } }, { name: 'displayLanguage', valueCode: 'fr' }));
      expect(r).toEqual(yes('biopsie du tissu encéphalique'));
      return r;
    }));

    // R4 defines these inputs; Medplum ignores them, the store refuses them (unsupported is loud).
    test('differs on purpose: unsupported $validate-code inputs are 400 [store-plan-2]', async () => {
      const extras: ParametersParameter[] = [{ name: 'codeSystem', resource: { resourceType: 'CodeSystem', status: 'active', content: 'not-present' } },
        { name: 'codeableConcept', valueCodeableConcept: { text: 'x' } }, { name: 'date', valueDateTime: '2020-01-01' }, { name: 'abstract', valueBoolean: true },
        { name: 'display', valueString: 'Biopsy of brain' }];
      const [medplum, store] = await both(sides, async (s) => {
        const out = [];
        for (const extra of extras) {
          const r = await post(s, { name: 'url', valueUri: url }, { name: 'code', valueCode: '1' }, extra);
          out.push([r.status, r.body.issue?.[0]?.details?.text]);
        }
        return out;
      });
      expect(medplum.map((x) => x[0])).toEqual([200, 200, 200, 200, 200]);
      expect(store).toEqual(extras.map((x) => [400, `$validate-code: parameter ${x.name} is not supported`]));
    });
  });

  // subsumes.test.ts: over the built-in v3-RoleCode (Medplum's test uses a Super Admin to read it; every project sees it)
  describe('CodeSystem subsumes', () => {
    const run = async (s: Side, codeA: string, codeB: string) => {
      const r = await call(s, 'POST', 'CodeSystem/$subsumes', P({ name: 'system', valueUri: ROLE_CODE }, { name: 'codeA', valueCode: codeA }, { name: 'codeB', valueCode: codeB }));
      expect(r.status).toBe(200);
      return r.body.parameter?.find((p: ParametersParameter) => p.name === 'outcome')?.valueCode;
    };
    const outcome = (a: string, b: string, expected: string) => () => same(sides, async (s) => {
      const o = await run(s, a, b);
      expect(o).toBe(expected);
      return o;
    });
    test('CodeSystem subsumes › Subsumes [server/src/fhir/operations/subsumes.test.ts]', outcome('SIB', 'ITWINBRO', 'subsumes'));
    test('CodeSystem subsumes › Subsumed by [server/src/fhir/operations/subsumes.test.ts]', outcome('WIFE', 'SIGOTHR', 'subsumed-by'));
    test('CodeSystem subsumes › Equivalent [server/src/fhir/operations/subsumes.test.ts]', outcome('INLAW', 'INLAW', 'equivalent'));
    test('CodeSystem subsumes › Not subsumed [server/src/fhir/operations/subsumes.test.ts]', outcome('BRO', 'VET', 'not-subsumed'));

    test('CodeSystem subsumes › Returns error on incomplete input [server/src/fhir/operations/subsumes.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'POST', 'CodeSystem/$subsumes', P({ name: 'system', valueUri: ROLE_CODE }, { name: 'codeA', valueCode: 'SIB' }));
      expect([r.status, r.body.resourceType]).toEqual([400, 'OperationOutcome']);
      return r;
    }));

    test('CodeSystem subsumes › GET endpoint [server/src/fhir/operations/subsumes.test.ts]', () => same(sides, async (s) => {
      const r = await call(s, 'GET', q('CodeSystem/$subsumes', ['system', ROLE_CODE], ['codeA', 'SIB'], ['codeB', 'ITWINBRO']));
      expect(r).toEqual({ status: 200, body: { resourceType: 'Parameters', parameter: [{ name: 'outcome', valueCode: 'subsumes' }] } });
      return r;
    }));

    test('CodeSystem subsumes › GET instance endpoint [server/src/fhir/operations/subsumes.test.ts]', () => same(sides, async (s) => {
      const codeSystem = (await search(s, q('CodeSystem', ['url', ROLE_CODE]))).entry?.[0]?.resource;
      const r = await call(s, 'GET', `CodeSystem/${codeSystem?.id}/$subsumes?codeA=SIB&codeB=ITWINBRO`);
      expect(r).toEqual({ status: 200, body: { resourceType: 'Parameters', parameter: [{ name: 'outcome', valueCode: 'subsumes' }] } });
      return r;
    }));

    // R4 defines codingA and codingB; Medplum ignores them (and then asks for codeA and codeB), the store refuses them.
    test('differs on purpose: unsupported $subsumes inputs are 400 [store-plan-2]', async () => {
      const [medplum, store] = await both(sides, async (s) => {
        const r = await call(s, 'POST', 'CodeSystem/$subsumes', P({ name: 'system', valueUri: ROLE_CODE }, { name: 'codingA', valueCoding: { system: ROLE_CODE, code: 'SIB' } },
          { name: 'codingB', valueCoding: { system: ROLE_CODE, code: 'ITWINBRO' } }));
        return [r.status, r.body.issue?.[0]?.details?.text];
      });
      expect(medplum).toEqual([400, 'Must specify codeA and codeB parameters']);
      expect(store).toEqual([400, '$subsumes: parameter codingA is not supported']);
    });
  });

  // codesystemimport.test.ts. Medplum's beforeEach replaces its one http://snomed.info/sct CodeSystem; here each test makes its
  // own with a unique url. Medplum's Super Admin calls are made by the parity project's admin (project-admin semantics, R7).
  describe('CodeSystem $import', () => {
    const snomedJSON: CodeSystem = {
      resourceType: 'CodeSystem', url: 'http://snomed.info/sct', name: 'SNOMEDCT_US', title: 'SNOMED CT (US Edition)', status: 'active', experimental: false,
      hierarchyMeaning: 'is-a', versionNeeded: false, content: 'not-present',
      property: [{ code: 'parent', uri: 'http://hl7.org/fhir/concept-properties#parent', description: 'A SNOMED CT concept id that has the target of a direct is-a relationship from the concept', type: 'code' },
        { code: 'active', type: 'boolean' }],
    };
    let suffix: string;
    beforeAll(async () => {
      // An import into a built-in by a Super Admin would write Medplum's server-wide R4 tables, which no cleanup undoes.
      const me = (await sides[0].call('GET', '../../auth/me')).json;
      expect(me?.project?.id).toBeTruthy();
      expect(me.project.superAdmin).toBeFalsy();
    });
    const snomed = (s: Side) => s.create<CodeSystem>({ ...snomedJSON, url: `http://snomed.info/sct-${suffix}` });
    const imp = (s: Side, ...parameter: ParametersParameter[]) => call(s, 'POST', 'CodeSystem/$import', P(...parameter));
    const imports = (s: Side, cs: CodeSystem, ...parameter: ParametersParameter[]) => imp(s, { name: 'system', valueUri: cs.url }, ...parameter);
    const concept = (code: string, display?: string): ParametersParameter => ({ name: 'concept', valueCoding: { code, display } });
    // Medplum's assertCodeExists / assertPropertyExists / assertCodeMissing, by $lookup: the code's display, designations and properties.
    const look = (s: Side, cs: { id?: string }, code: string) => call(s, 'GET', `CodeSystem/${cs.id}/$lookup?code=${encodeURIComponent(code)}`);
    const run = <T>(fn: (s: Side) => Promise<T>) => () => { suffix = randomUUID(); return same(sides, fn).then(() => undefined); };

    test('CodeSystem $import › Imports concepts and properties separately [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = await imports(s, cs, concept('37931006', 'Auscultation (procedure)'), concept('315306007', 'Examination by method (procedure)'));
      const res2 = await imports(s, cs, prop('37931006', 'parent', '315306007'));
      expect([res.status, res2.status]).toEqual([200, 200]);
      const found = await look(s, cs, '37931006');
      expect(found.body.parameter).toEqual(expect.arrayContaining([{ name: 'display', valueString: 'Auscultation (procedure)' },
        { name: 'property', part: [{ name: 'code', valueCode: 'parent' }, { name: 'value', valueCode: '315306007' }, { name: 'description', valueString: 'Examination by method (procedure)' }] }]));
      expect((await look(s, cs, '315306007')).status).toBe(200);
      return [res, res2, found];
    }));

    test('CodeSystem $import › Imports concepts and associated relationships [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = await imports(s, cs, concept('184598004', 'Needle biopsy of brain (procedure)'), concept('702707005', 'Biopsy of head (procedure)'),
        concept('118690002', 'Procedure on head (procedure)'), concept('71388002', 'Procedure (procedure)'),
        prop('184598004', 'parent', '702707005'), prop('702707005', 'parent', '118690002'), prop('118690002', 'parent', '71388002'));
      expect(res.status).toBe(200);
      const found = await look(s, cs, '702707005');
      // the relationship's target is set: its display describes the property
      expect(found.body.parameter).toContainEqual({ name: 'property', part: [{ name: 'code', valueCode: 'parent' }, { name: 'value', valueCode: '118690002' },
        { name: 'description', valueString: 'Procedure on head (procedure)' }] });
      return [res, found];
    }));

    test('CodeSystem $import › Returns error on unknown code system [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const res = await imp(s, { name: 'system', valueUri: 'http://example.com/unknown' }, concept('1', 'Aspirin'));
      expect([res.status, res.body.issue?.[0]?.code]).toEqual([400, 'invalid']);
      return res;
    }));

    test('CodeSystem $import › Returns error on unknown code for property [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = await imports(s, cs, prop('not a real code', 'parent', '71388002'));
      expect([res.status, res.body.issue?.[0]?.code]).toEqual([400, 'invalid']);
      return res;
    }));

    test('CodeSystem $import › Returns error on unknown property [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = await imports(s, cs, concept('184598004', 'Needle biopsy of brain (procedure)'), prop('184598004', 'not a real property', '71388002'));
      expect([res.status, res.body.issue?.[0]?.code]).toEqual([400, 'invalid']);
      const after = await look(s, cs, '184598004'); // the import is one transaction
      expect(after.status).toBe(404);
      return [res, after];
    }));

    test('CodeSystem $import › Allows access by Project admin [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = await imports(s, cs, concept('184598004', 'Needle biopsy of brain (procedure)'));
      expect(res.status).toBe(200);
      const found = await look(s, cs, '184598004');
      expect(found.status).toBe(200);
      return [res, found];
    }));

    // Medplum (ownProjectOnly) does not see another project's CodeSystem by url: 400 not found. The store has no projects; the url
    // names a built-in, and a write to a built-in is 403 (R2), as Medplum answers the same import by id.
    test('differs on purpose: CodeSystem $import › Prevents writes by Project admin to linked Project systems [server/src/fhir/operations/codesystemimport.test.ts]', async () => {
      const [medplum, store] = await both(sides, async (s) => {
        const res = await imp(s, { name: 'system', valueUri: ROLE_CODE }, concept('NIBL', 'nibling'));
        return [res.status, res.body.issue?.[0]?.code, res.body.issue?.[0]?.details?.text];
      });
      expect(medplum).toEqual([400, 'invalid', `CodeSystem ${ROLE_CODE} not found`]);
      expect(store).toEqual([403, 'forbidden', 'Forbidden']);
      await same(sides, async (s) => {
        const base = (await search(s, q('CodeSystem', ['url', ROLE_CODE]))).entry?.[0]?.resource as CodeSystem;
        const r = await look(s, base, 'NIBL');
        expect(r.status).toBe(404);
        return r;
      });
    });

    test('CodeSystem $import › Prevents writes by Project admin to base CodeSystem by ID [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const base = (await search(s, q('CodeSystem', ['url', ROLE_CODE]))).entry?.[0]?.resource as CodeSystem;
      expect(base?.id).toBeDefined();
      const code = `ZZ${suffix}`;
      const res = await call(s, 'POST', `CodeSystem/${base.id}/$import`, P(concept(code, 'Injected concept')), { 'x-medplum': 'extended' });
      expect(res.status).toBe(403);
      const missing = await look(s, base, code);
      expect(missing.status).toBe(404);
      return [res, missing];
    }));

    const byId = (headers: Record<string, string>) => run(async (s) => {
      const cs = await s.create<CodeSystem>({ ...snomedJSON, url: `http://example.com/CodeSystem/${suffix}` });
      const code = `ZZ${suffix}`;
      const res = await call(s, 'POST', `CodeSystem/${cs.id}/$import`, P(concept(code, 'Own project concept')), headers);
      expect(res.status).toBe(200);
      const found = await look(s, cs, code);
      expect(found.status).toBe(200);
      return [res, found];
    });
    test('CodeSystem $import › Imports into own Project CodeSystem by ID [server/src/fhir/operations/codesystemimport.test.ts]', byId({ 'x-medplum': 'extended' }));
    test('CodeSystem $import › Imports into own Project CodeSystem by ID without extended mode [server/src/fhir/operations/codesystemimport.test.ts]', byId({}));

    test('CodeSystem $import › Imports concepts and synonym designations [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = await imports(s, cs, concept('37931006', 'Auscultation (procedure)'),
        { name: 'designation', part: [{ name: 'code', valueCode: '37931006' }, { name: 'value', valueString: 'Listening' }] },
        { name: 'designation', part: [{ name: 'code', valueCode: '37931006' }, { name: 'language', valueCode: 'fr' }, { name: 'value', valueString: 'auscultation (intervention)' }] });
      expect(res.status).toBe(200);
      const found = await look(s, cs, '37931006');
      expect(found.body.parameter).toEqual(expect.arrayContaining([{ name: 'display', valueString: 'Auscultation (procedure)' },
        { name: 'designation', part: [{ name: 'value', valueString: 'Listening' }] },
        { name: 'designation', part: [{ name: 'language', valueCode: 'fr' }, { name: 'value', valueString: 'auscultation (intervention)' }] }]));
      return [res, found];
    }));

    test('CodeSystem $import › Attaches imported properties to primary coding instead of synonym [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = [await imports(s, cs, concept('12345', 'Test code'), { name: 'designation', part: [{ name: 'code', valueCode: '12345' }, { name: 'value', valueString: 'Test designation' }] }),
        await imports(s, cs, concept('12345', 'Test code')), await imports(s, cs, prop('12345', 'parent', '98765'))];
      expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
      // assertPropertyExists on the primary coding: $lookup lists the property (a synonym's would not show)
      const found = await look(s, cs, '12345');
      expect(found.body.parameter).toContainEqual({ name: 'property', part: [{ name: 'code', valueCode: 'parent' }, { name: 'value', valueCode: '98765' },
        { name: 'description', valueString: 'A SNOMED CT concept id that has the target of a direct is-a relationship from the concept' }] });
      const vs = await s.create<ValueSet>({ resourceType: 'ValueSet', url: `http://example.com/ValueSet/${suffix}`, status: 'active',
        compose: { include: [{ system: cs.url, filter: [{ property: 'parent', op: '=', value: '98765' }] }] } });
      const expanded = await call(s, 'GET', `ValueSet/$expand?url=${vs.url}`);
      expect([expanded.status, expanded.body.expansion?.contains?.length]).toEqual([200, 1]);
      delete expanded.body.expansion.timestamp;
      return [res, found, expanded];
    }));

    test('CodeSystem $import › Rejects excessively large batches [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const res = await imports(s, cs, ...Array.from({ length: 1001 }, (_, i) => ({ name: 'concept', valueCoding: { code: i.toString() } })));
      expect(res.status).toBe(400);
      expect(res.body.issue?.[0]).toStrictEqual({ code: 'invalid', details: { text: 'Expected 0..1000 value(s) for input parameter concept, but 1001 provided' }, severity: 'error' });
      return res;
    }));

    test('CodeSystem $import › Accepts batch of max size [server/src/fhir/operations/codesystemimport.test.ts]', run(async (s) => {
      const cs = await snomed(s);
      const parameter: ParametersParameter[] = [];
      for (let i = 0; i < 1000; i++) {
        parameter.push({ name: 'concept', valueCoding: { code: i.toString() } }, prop(i.toString(), 'active', '1'),
          { name: 'designation', part: [{ name: 'code', valueCode: i.toString() }, { name: 'language', valueCode: 'en-GB' }, { name: 'value', valueString: i.toLocaleString('en-GB') }] });
      }
      const res = await imports(s, cs, ...parameter);
      expect(res.status).toBe(200);
      const found = await look(s, cs, '999');
      expect(found.status).toBe(200);
      return [res, found];
    }), 120_000);
  });
});
