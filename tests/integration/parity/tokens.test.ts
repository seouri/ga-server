// Medplum 5.2.14 packages/server/src/fhir/tokens.test.ts, ported side by side (see harness.ts). Operator.EQUALS etc. become the
// query strings parseSearchRequest reads back into them; NOT_EQUALS on a token has no HTTP prefix and is :not.
// Medplum gives each describe its own project; here one project is shared, so fixtures use values made per run where they can.
import type { Bundle, Condition, Patient } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, paritySides, q, ref, same, search, type Side } from './harness.ts';

const has = (b: Bundle, r: { id: string }) => !!b.entry?.some((e) => e.resource?.id === r.id);
const ids = (b: Bundle) => (b.entry ?? []).map((e) => (e.resource as Condition | Patient).identifier?.[0]?.value as string).sort();
const SNOMED = 'http://snomed.info/sct';

describe.skipIf(SQLITE)('Medplum tokens.test.ts (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);
  const once = <T>(make: (s: Side) => Promise<T>) => {
    const made = new Map<string, Promise<T>>();
    return (s: Side) => { if (!made.has(s.name)) made.set(s.name, make(s)); return made.get(s.name)!; };
  };

  test('Token-based searches › With systemRepo › Identifier [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const identifier = crypto.randomUUID(), text = 'this is some text';
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system: 'https://www.example.com', value: identifier, type: { text } }] });
    const searchResult = await search(s, q('Patient', ['identifier', identifier]));
    expect(searchResult.entry?.length).toBe(1);
    expect(has(searchResult, patient)).toBe(true);
    const goodTextResult = await search(s, q('Patient', ['identifier', identifier], ['identifier:text', text]));
    expect(goodTextResult.entry?.length).toBe(1);
    expect(has(goodTextResult, patient)).toBe(true);
    const badTextResult = await search(s, q('Patient', ['identifier:text', identifier]));
    expect(badTextResult.entry?.length ?? 0).toBe(0);
  }));

  // TokenQueryOperators: TEXT, CONTAINS, EQUALS, EXACT, NOT, NOT_EQUALS (sent as :not). R4 defines :contains and :exact for
  // string parameters only: the store refuses them on a token (README, "Deliberate differences").
  test('differs on purpose: Token-based searches › With systemRepo › %s with empty value does not throw errors [server/src/fhir/tokens.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const out = [];
      for (const code of ['identifier:text', 'identifier:contains', 'identifier', 'identifier:exact', 'identifier:not']) out.push((await s.call('GET', q('Patient', [code, '']))).status);
      return out;
    });
    expect(medplum).toEqual([200, 200, 200, 200, 200]);
    expect(store).toEqual([200, 400, 200, 400, 200]);
  });

  test('Token-based searches › With systemRepo › Multiple identifiers [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const identifier = crypto.randomUUID(), other = crypto.randomUUID();
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }],
      identifier: [{ system: 'https://www.example.com', value: identifier }, { system: 'https://www.example.com', value: identifier }, { system: 'other', value: other }] });
    for (const v of [identifier, other]) {
      const r = await search(s, q('Patient', ['identifier', v]));
      expect(r.entry?.length).toBe(1);
      expect(has(r, patient)).toBe(true);
    }
  }));

  test('Token-based searches › With systemRepo › Update identifier [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const identifier1 = crypto.randomUUID(), identifier2 = crypto.randomUUID();
    const patient1 = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system: 'https://www.example.com', value: identifier1 }] });
    const count = async (v: string) => (await search(s, q('Patient', ['identifier', v]))).entry?.length ?? 0;
    expect([await count(identifier1), await count(identifier2)]).toEqual([1, 0]);
    const u = await s.call('PUT', `Patient/${patient1.id}`, { ...patient1, identifier: [{ system: 'https://www.example.com', value: identifier2 }] });
    expect(u.status).toBe(200);
    expect([await count(identifier1), await count(identifier2)]).toEqual([0, 1]);
  }));

  const exactPair = async (s: Side) => {
    const identifier = crypto.randomUUID();
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system: 'https://www.example.com', value: identifier }] });
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Jones' }], identifier: [{ system: 'https://www.example.com', value: identifier + 'xyz' }] });
    return { identifier, patient1, patient2 };
  };
  test('Token-based searches › With systemRepo › Implicit exact [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const { identifier, patient1, patient2 } = await exactPair(s);
    const searchResult1 = await search(s, q('Patient', ['identifier', identifier]));
    expect(searchResult1.entry?.length).toBe(1);
    expect([has(searchResult1, patient1), has(searchResult1, patient2)]).toEqual([true, false]);
  }));

  // :exact on a token: Medplum treats it as plain equality, the store refuses it (R4 defines :exact for strings only).
  const exact = (title: string, run: (s: Side) => Promise<{ path: string; want: boolean[]; got: (b: Bundle) => boolean[] }[]>) =>
    test(title, async () => {
      const [medplum, store] = await both(sides, async (s) => {
        const out = [];
        for (const c of await run(s)) {
          const g = await s.call('GET', c.path);
          out.push(g.status === 200 ? JSON.stringify(c.got(g.json)) === JSON.stringify(c.want) : g.status);
        }
        return out;
      });
      expect(medplum.every((x) => x === true)).toBe(true);
      expect(store.every((x) => x === 400)).toBe(true);
    });
  exact('differs on purpose: Token-based searches › With systemRepo › Explicit exact [server/src/fhir/tokens.test.ts]', async (s) => {
    const { identifier, patient1, patient2 } = await exactPair(s);
    return [{ path: q('Patient', ['identifier:exact', identifier]), want: [true, false], got: (b) => [has(b, patient1), has(b, patient2)] }];
  });
  exact('differs on purpose: Token-based searches › With systemRepo › Search comma separated identifier exact [server/src/fhir/tokens.test.ts]', async (s) => {
    const identifier1 = crypto.randomUUID(), identifier2 = crypto.randomUUID();
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system: 'https://www.example.com', value: identifier1 }] });
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Jones' }], identifier: [{ system: 'https://www.example.com', value: identifier2 }] });
    return [{ path: q('Patient', ['identifier:exact', `${identifier1},${identifier2}`]), want: [true, true], got: (b) => [has(b, patient1), has(b, patient2)] }];
  });
  exact('differs on purpose: Token-based searches › With systemRepo › Search on system [server/src/fhir/tokens.test.ts]', async (s) => {
    const system1 = 'https://foo.com', system2 = 'https://bar.com', identifier = crypto.randomUUID();
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system: system1, value: identifier }] });
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Jones' }], identifier: [{ system: system2, value: identifier }] });
    return [
      { path: q('Patient', ['identifier:exact', `${system1}|${identifier}`]), want: [true, false], got: (b) => [has(b, patient1), has(b, patient2)] },
      { path: q('Patient', ['identifier:exact', `${system2}|${identifier}`]), want: [false, true], got: (b) => [has(b, patient1), has(b, patient2)] },
    ];
  });

  // R4 defines :contains for string parameters only: the store answers 400 on a token (README, "Deliberate differences").
  const containsFixture = once(async (s) => {
    const baseIdentifierValue = crypto.randomUUID(), identifier = crypto.randomUUID();
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }],
      telecom: [{ system: 'email', value: 'prefix-email-postfix' }, { system: 'phone', value: 'prefix-phone-postfix' }, { system: 'pager', value: 'prefix-pager-postfix' }],
      identifier: [{ system: 'https://hi.com', value: baseIdentifierValue }, { system: 'https://www.example.com', value: identifier }] });
    return { baseIdentifierValue, identifier, patient1 };
  });
  const containsCase = (title: string, values: (f: { identifier: string }) => [string, string][], medplumCount: number) =>
    test(title, async () => {
      const [medplum, store] = await both(sides, async (s) => {
        const f = await containsFixture(s);
        const out = [];
        for (const [code, value] of values(f)) {
          const g = await s.call('GET', q('Patient', ['identifier', f.baseIdentifierValue], [`${code}:contains`, value]));
          out.push(g.status === 200 ? (g.json as Bundle).entry?.filter((e) => e.resource?.id === f.patient1.id).length ?? 0 : g.status);
        }
        return out;
      });
      expect(medplum).toEqual(values({ identifier: 'x'.repeat(36) }).map(() => medplumCount));
      expect(store).toEqual(values({ identifier: 'x'.repeat(36) }).map(() => 400));
    });
  containsCase('differs on purpose: Token-based searches › With systemRepo › :contains › prefix on Patient-identifier [server/src/fhir/tokens.test.ts]', (f) => [['identifier', f.identifier.slice(0, 5)]], 0);
  containsCase('differs on purpose: Token-based searches › With systemRepo › :contains › infix on Patient-identifier [server/src/fhir/tokens.test.ts]', (f) => [['identifier', f.identifier.slice(5, 10)]], 0);
  containsCase('differs on purpose: Token-based searches › With systemRepo › :contains › infix on Patient-telecom [server/src/fhir/tokens.test.ts]', () => ['pager', 'PAGER', 'PaGeR'].map((v) => ['telecom', v]), 1);
  containsCase('differs on purpose: Token-based searches › With systemRepo › :contains › infix on Patient-email [server/src/fhir/tokens.test.ts]', () => [['email', 'email']], 1);
  containsCase('differs on purpose: Token-based searches › With systemRepo › :contains › infix on Patient-phone [server/src/fhir/tokens.test.ts]', () => [['phone', 'phone']], 1);

  test('Token-based searches › With systemRepo › Not equals [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const identifier = crypto.randomUUID(), name = crypto.randomUUID();
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: name }], identifier: [{ system: 'https://www.example.com', value: identifier }] });
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: name }], identifier: [{ system: 'https://www.example.com', value: identifier + 'xyz' }] });
    const patient3 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: name }] });
    const searchResult1 = await search(s, q('Patient', ['identifier:not', identifier], ['name', name]));
    expect(searchResult1.entry?.length).toBe(2);
    expect([has(searchResult1, patient1), has(searchResult1, patient2), has(searchResult1, patient3)]).toEqual([false, true, true]);
  }));

  test('Token-based searches › With systemRepo › Non-array identifier [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const identifier = crypto.randomUUID();
    const resource = await s.create({ resourceType: 'SpecimenDefinition', identifier: { system: 'https://www.example.com', value: identifier } });
    const searchResult = await search(s, q('SpecimenDefinition', ['identifier', identifier]));
    expect(searchResult.entry?.length).toBe(1);
    expect(has(searchResult, resource)).toBe(true);
  }));

  test('Token-based searches › With systemRepo › Leading whitespace [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const identifier = crypto.randomUUID();
    const resource = await s.create({ resourceType: 'Patient', identifier: [{ system: 'https://www.example.com', value: ' ' + identifier }] });
    const searchResult = await search(s, q('Patient', ['identifier', identifier]));
    expect(searchResult.entry?.length).toBe(1);
    expect(has(searchResult, resource)).toBe(true);
  }));

  // A token without a modifier matches codes (R4); a CodeableConcept's text is matched by :text. Medplum also matches the
  // text by plain equality; the store does not.
  test('differs on purpose: Token-based searches › With systemRepo › CodeableConcept text [server/src/fhir/tokens.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const sr = (text: string) => s.create({ resourceType: 'ServiceRequest', intent: 'order', status: 'active', subject: { reference: 'Patient/1' }, category: [{ text }] });
      const sr1 = await sr(crypto.randomUUID()), sr2 = await sr(crypto.randomUUID());
      const b = await search(s, q('ServiceRequest', ['category', sr1.category[0].text]));
      const t = await search(s, q('ServiceRequest', ['category:text', sr1.category[0].text]));
      return [[has(b, sr1), has(b, sr2)], [has(t, sr1), has(t, sr2)]];
    });
    expect(medplum).toEqual([[true, false], [true, false]]);
    expect(store).toEqual([[false, false], [true, false]]);
  });

  test('Token-based searches › With systemRepo › Identifier value with pipe [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const system = crypto.randomUUID(), base = crypto.randomUUID();
    const p1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system, value: base + '|1' }] });
    await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system, value: base + '|2' }] });
    const r1 = await search(s, q('Patient', ['identifier', `${system}|${base}|1`]));
    expect(r1.entry?.length).toBe(1);
    expect(has(r1, p1)).toBe(true);
  }));

  // Medplum's check of its own column strategy (getSearchParameterImplementation) is internal and left out.
  // Operator.PRESENT is Medplum's :present (not an R4 modifier).
  test('Token-based searches › With systemRepo › Missing/present › %s :%s %s [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const family = crypto.randomUUID(), email = crypto.randomUUID(), identifier = crypto.randomUUID();
    const p1 = await s.create({ resourceType: 'Patient', meta: { security: [{ code: '123' }] }, name: [{ family }], telecom: [{ system: 'email', value: email + 'abc' }] });
    const p2 = await s.create({ resourceType: 'Patient', name: [{ family }], telecom: [{ system: 'email', value: email + 'xyz' }], identifier: [{ system: 'https://www.example.com', value: identifier }] });
    const cases: [string, string, string, boolean, boolean][] = [
      ['identifier', 'missing', 'true', true, false], ['identifier', 'missing', 'false', false, true],
      ['identifier', 'present', 'true', false, true], ['identifier', 'present', 'false', true, false],
      ['telecom', 'missing', 'true', false, false], ['telecom', 'missing', 'false', true, true],
      ['telecom', 'present', 'true', true, true], ['telecom', 'present', 'false', false, false],
      ['_security', 'missing', 'true', false, true], ['_security', 'missing', 'false', true, false],
      ['_security', 'present', 'true', true, false], ['_security', 'present', 'false', false, true],
    ];
    const out = [];
    for (const [code, operator, value, expected1, expected2] of cases) {
      const res = await search(s, q('Patient', ['name', family], [`${code}:${operator}`, value]));
      expect([code, operator, value, has(res, p1), has(res, p2)]).toEqual([code, operator, value, expected1, expected2]);
      out.push([has(res, p1), has(res, p2)]);
    }
    return out;
  }));

  // :in and :not-in need a ValueSet expansion: Medplum refuses them on Condition.code (Invalid modifier), as the store does.
  test('Token-based searches › With systemRepo › Condition.code :%s search [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const p = await s.create({ resourceType: 'Patient', name: [{ family: crypto.randomUUID() }] });
    await s.create({ resourceType: 'Condition', subject: ref(p), code: { coding: [{ system: SNOMED, code: '165002' }] } });
    await s.create({ resourceType: 'Condition', subject: ref(p), code: { coding: [{ system: 'https://example.com', code: 'test' }] } });
    const out = [];
    for (const op of ['in', 'not-in']) {
      const g = await s.call('GET', q('Condition', ['subject', `Patient/${p.id}`], [`code:${op}`, 'http://hl7.org/fhir/ValueSet/condition-code']));
      expect(g.status).toBe(400);
      out.push(g.status);
    }
    return out;
  }));

  // describe 'Condition.code token queries': one fixture per side, its Conditions named by identifier.
  const sys1 = 'http://sys.one', sys2 = 'http://sys.two', val1 = 'ABCDEFGHIJ', val2 = '0123456789', disp1 = 'The Quick Brown Fox';
  const conditions = once(async (s) => {
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Henry'] }] });
    const subject = ref(patient);
    const c = (value: string, extra: Partial<Condition>) => s.create({ resourceType: 'Condition', subject, identifier: [{ value }], ...extra });
    await c('noCodeNoCat', {});
    await c('noCodeCatOne', { category: [{ coding: [{ system: sys1, code: val1, display: disp1 }] }] });
    await c('codeOneNoCat', { code: { coding: [{ system: sys1, code: val1, display: disp1 }] } });
    await c('codeOneCatOne', { code: { coding: [{ system: sys1, code: val1 }] }, category: [{ coding: [{ system: sys1, code: val1 }] }] });
    await c('codeOneCatTwo', { code: { coding: [{ system: sys1, code: val1 }] }, category: [{ coding: [{ system: sys2, code: val2 }] }] });
    await c('codeOneWithoutSystemNoCat', { code: { coding: [{ code: val1 }] } });
    await c('codeTwoWithoutSystemCatTwo', { code: { coding: [{ code: val2 }] }, category: [{ coding: [{ system: sys2, code: val2 }] }] });
    return { subject };
  });
  const condIds = async (s: Side, ...params: [string, string][]) => { await conditions(s); return ids(await search(s, q('Condition', ...params))); };

  test('Token-based searches › Condition.code token queries › Sort by identifier [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const system = crypto.randomUUID();
    for (const [family, value] of [['None', undefined], ['AAA', 'AAA'], ['ZZZ', 'ZZZ']]) await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family }], identifier: [{ system, value }] });
    const families = async (sort: string) => (await search(s, q('Patient', ['identifier', system + '|'], ['_sort', sort]))).entry?.map((e) => (e.resource as Patient).name?.[0]?.family);
    expect(await families('identifier')).toEqual(['AAA', 'ZZZ', 'None']);
    expect(await families('-identifier')).toEqual(['None', 'ZZZ', 'AAA']);
  }));

  // Medplum sorts both ways by one value (its test notes the ideal: AAA ascending, ZZZ descending); the store sorts by the
  // lowest value ascending and the highest descending, as it does dates.
  test('differs on purpose: Token-based searches › Condition.code token queries › Sort by identifier with multiple values [server/src/fhir/tokens.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const system = crypto.randomUUID();
      await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'First' }], identifier: [{ system, value: 'AAA' }, { system, value: 'ZZZ' }] });
      await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Second' }], identifier: [{ system, value: 'LLL' }] });
      const families = async (sort: string) => (await search(s, q('Patient', ['identifier', system + '|'], ['_sort', sort]))).entry?.map((e) => (e.resource as Patient).name?.[0]?.family);
      return [await families('identifier'), await families('-identifier')];
    });
    expect(medplum).toEqual([['First', 'Second'], ['Second', 'First']]);
    expect(store).toEqual([['First', 'Second'], ['First', 'Second']]);
  });

  test('Token-based searches › Condition.code token queries › code by system %s [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    for (const [value, expected] of [[sys1, ['codeOneCatOne', 'codeOneCatTwo', 'codeOneNoCat']], [sys2, []], [val1, []]] as const) {
      expect(await condIds(s, ['code', value + '|'])).toEqual(expected);
    }
  }));

  // The :contains half differs (400 in the store; see :contains above).
  test('differs on purpose: Token-based searches › Condition.code token queries › code by value %s [server/src/fhir/tokens.test.ts]', async () => {
    const cases = [[sys1, []], [val1, ['codeOneCatOne', 'codeOneCatTwo', 'codeOneNoCat', 'codeOneWithoutSystemNoCat']], [val2, ['codeTwoWithoutSystemCatTwo']]] as const;
    const [medplum, store] = await both(sides, async (s) => {
      const out = [];
      for (const [value, expected] of cases) {
        expect(await condIds(s, ['code', value])).toEqual(expected);
        const g = await s.call('GET', q('Condition', ['code:contains', value]));
        out.push(g.status === 200 ? ids(g.json).length : g.status);
      }
      return out;
    });
    expect(medplum).toEqual([0, 0, 0]);
    expect(store).toEqual([400, 400, 400]);
  });

  test('Token-based searches › Condition.code token queries › code by system and value %s|%s [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    for (const [system, value, expected] of [[sys1, val1, ['codeOneCatOne', 'codeOneCatTwo', 'codeOneNoCat']], [sys1, val2, []], [sys2, val1, []], [sys2, val2, []]] as const) {
      expect(await condIds(s, ['code', `${system}|${value}`])).toEqual(expected);
    }
  }));

  test('Token-based searches › Condition.code token queries › code by missing system and value %s [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    for (const [value, expected] of [[val1, ['codeOneWithoutSystemNoCat']], [val2, ['codeTwoWithoutSystemCatTwo']]] as const) {
      expect(await condIds(s, ['code', '|' + value])).toEqual(expected);
    }
  }));

  test('Token-based searches › Condition.code token queries › code and category by code=%s category=%s [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    for (const [code, category, expected] of [
      [val1, val1, ['codeOneCatOne']], [val1, val2, ['codeOneCatTwo']], [val2, val1, []], [sys1 + '|', val2, ['codeOneCatTwo']],
      ['|' + val1, val1, []], ['|' + val2, sys2 + '|' + val2, ['codeTwoWithoutSystemCatTwo']],
    ] as const) {
      expect(await condIds(s, ['code', code], ['category', category])).toEqual(expected);
    }
  }));

  const containsCodes = (title: string, values: string[]) => test(title, async () => {
    const [medplum, store] = await both(sides, async (s) => {
      await conditions(s);
      const out = [];
      for (const value of values) {
        const g = await s.call('GET', q('Condition', ['code:contains', value]));
        out.push(g.status === 200 ? ids(g.json).length : g.status);
      }
      return out;
    });
    expect(medplum).toEqual(values.map(() => 0));
    expect(store).toEqual(values.map(() => 400));
  });
  containsCodes('differs on purpose: Token-based searches › Condition.code token queries › code :contains beginning of value %s [server/src/fhir/tokens.test.ts]', [val1, val1.slice(0, 3)]);
  containsCodes('differs on purpose: Token-based searches › Condition.code token queries › code :contains middle of value %s [server/src/fhir/tokens.test.ts]', [val1.slice(1, 3), val2.slice(1, 3)]);

  test('Token-based searches › Condition.code token queries › code :text %s [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    for (const value of [disp1, 'The Quick', 'Quick Brown', 'Brown Fox']) expect(await condIds(s, ['code:text', value])).toEqual(['codeOneNoCat']);
  }));

  // Both test.each tables of this title (Medplum lists it twice): the first holds on token columns and lookup tables alike,
  // the second differs between Medplum's two token implementations.
  test('Token-based searches › Condition.code token queries › code :text search for special chars › :text search for %s should match? %s [server/src/fhir/tokens.test.ts]', () => same(sides, async (s) => {
    const { subject } = await conditions(s);
    const identifier = crypto.randomUUID();
    const cond = await s.create({ resourceType: 'Condition', code: { coding: [{ system: sys1, code: 'some-value', display: '.^$*+?()[]{}\\|hello|' }] }, subject, identifier: [{ system: sys1, value: identifier }] });
    const cases: [string, boolean][] = [
      ['.', true], ['^', true], ['$', true], ['*', true], ['+', true], ['?', true], ['(', true], [')', true], ['[', true], [']', true], ['{', true], ['}', true],
      ['\\', true], ['()', true], ['[]', true], ['{}', true], ['.^', true], ['.^$*+', true], ['$', true], ['+?', true], [']{', true], ['hello', true], ['||', false],
      ['|', true], ['|hello|', true], ['.()', false],
    ];
    const out = [];
    for (const [query, shouldBeFound] of cases) {
      const res = await search(s, q('Condition', ['subject', subject.reference], ['identifier', identifier], ['code:text', query]));
      expect([query, (res.entry ?? []).map((e) => e.resource?.id === cond.id)]).toEqual([query, shouldBeFound ? [true] : []]);
      out.push(shouldBeFound);
    }
    return out;
  }));
});
