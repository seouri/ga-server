// Medplum 5.2.14 packages/fhir-router/src/search-include.test.ts, ported side by side (see harness.ts): Medplum searches an
// in-memory repository it clears before each test; here every search is scoped by a marker identifier, and asks for
// `_total=accurate` where Medplum checks the total (the in-memory repository always counts; Medplum's server counts on request).
import type { Bundle, Observation, Patient } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { error, marker, names, paritySides, ref, same, search, type Side } from './harness.ts';

const tagged = (b: Bundle, named: Record<string, { id?: string }>, mode: 'match' | 'include') =>
  names(b, named).filter((n) => n.startsWith('include:') === (mode === 'include')).map((n) => n.replace(/^include:/, '')).sort();

describe.skipIf(SQLITE)('Medplum fhir-router search-include.test.ts (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);
  const id = (m: string) => [{ system: 'urn:parity', value: m }];
  const patient = (s: Side, m: string) => s.create<Patient>({ resourceType: 'Patient', identifier: id(m) });
  const observation = (s: Side, m: string, extra: Partial<Observation>) => s.create<Observation>({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, identifier: id(m), ...extra });

  test('MemoryRepository _include/_revinclude › Search entries are tagged with mode "match" [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    await patient(s, m);
    const bundle = await search(s, `Patient?identifier=${m}`);
    expect(bundle.entry).toHaveLength(1);
    expect(bundle.entry?.[0].search).toStrictEqual({ mode: 'match' });
  }));

  test('MemoryRepository _include/_revinclude › _include resolves a literal reference [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    const o = await observation(s, m, { subject: ref(p) });
    const bundle = await search(s, `Observation?identifier=${m}&_include=Observation:subject&_total=accurate`);
    expect([tagged(bundle, { p, o }, 'match'), tagged(bundle, { p, o }, 'include')]).toEqual([['o'], ['p']]);
    expect(bundle.total).toBe(1); // included resources do not count toward total
  }));

  test('MemoryRepository _include/_revinclude › _include does not throw on a dangling reference [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const o = await observation(s, m, { subject: { reference: 'Patient/00000000-0000-4000-8000-000000000000' } });
    const bundle = await search(s, `Observation?identifier=${m}&_include=Observation:subject`);
    expect([tagged(bundle, { o }, 'match'), tagged(bundle, { o }, 'include')]).toEqual([['o'], []]);
  }));

  test('MemoryRepository _include/_revinclude › _include with a target type filters by that type [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    const e = await s.create({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: ref(p) });
    await observation(s, m, { subject: ref(p), encounter: ref(e) });
    expect(tagged(await search(s, `Observation?identifier=${m}&_include=Observation:subject:Patient`), { p, e }, 'include')).toEqual(['p']);
    expect(tagged(await search(s, `Observation?identifier=${m}&_include=Observation:subject:Group`), { p, e }, 'include')).toEqual([]);
  }));

  // Medplum also checks its repository reads the shared Patient once (a spy on readReferences): internal, left out.
  test('MemoryRepository _include/_revinclude › _include deduplicates resources referenced more than once [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    for (let i = 0; i < 3; i++) await observation(s, m, { subject: ref(p) });
    const bundle = await search(s, `Observation?identifier=${m}&_include=Observation:subject`);
    expect([tagged(bundle, { p }, 'match'), tagged(bundle, { p }, 'include')]).toEqual([['?', '?', '?'], ['p']]);
  }));

  test('MemoryRepository _include/_revinclude › _include does not re-include a resource already in the match set [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    const sr = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: ref(p) });
    const bundle = await search(s, `Patient?identifier=${m}&_revinclude=ServiceRequest:subject`);
    expect([tagged(bundle, { p, sr }, 'match'), tagged(bundle, { p, sr }, 'include')]).toEqual([['p'], ['sr']]);
    expect(bundle.entry).toHaveLength(2); // the patient appears once, as a match
  }));

  test('MemoryRepository _include/_revinclude › _revinclude resolves reverse references [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    const o = await observation(s, m, { subject: ref(p) });
    await observation(s, m, { code: { text: 'other' }, subject: { reference: 'Patient/00000000-0000-4000-8000-000000000000' } }); // must not be pulled in
    const bundle = await search(s, `Patient?identifier=${m}&_revinclude=Observation:subject`);
    expect([tagged(bundle, { p, o }, 'match'), tagged(bundle, { p, o }, 'include')]).toEqual([['p'], ['o']]);
  }));

  test('MemoryRepository _include/_revinclude › _revinclude with a target type filters the base resources [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    await observation(s, m, { subject: ref(p) });
    expect(tagged(await search(s, `Patient?identifier=${m}&_revinclude=Observation:subject:Group`), { p }, 'include')).toEqual([]);
  }));

  test('MemoryRepository _include/_revinclude › _include:iterate follows a chain of references [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    const e = await s.create({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: ref(p) });
    await observation(s, m, { encounter: ref(e) });
    expect(tagged(await search(s, `Observation?identifier=${m}&_include=Observation:encounter&_include:iterate=Encounter:subject`), { p, e }, 'include')).toEqual(['e', 'p']);
  }));

  test('MemoryRepository _include/_revinclude › _include without :iterate does not recurse [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const p = await patient(s, m);
    const e = await s.create({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: ref(p) });
    await observation(s, m, { encounter: ref(e) });
    expect(tagged(await search(s, `Observation?identifier=${m}&_include=Observation:encounter&_include=Encounter:subject`), { p, e }, 'include')).toEqual(['e']);
  }));

  // Canonical urls carry the marker (Medplum's fixed http://example.com/q would collide in the shared project);
  // QuestionnaireResponse.identifier is one Identifier, not a list.
  test('MemoryRepository _include/_revinclude › _include resolves canonical references by exact URL [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const url = `http://example.com/${m}`;
    const q1 = await s.create({ resourceType: 'Questionnaire', status: 'active', url });
    await s.create({ resourceType: 'Questionnaire', status: 'active', url: `${url}-extra` }); // shares a URL prefix with the target; must not be included
    await s.create({ resourceType: 'QuestionnaireResponse', status: 'completed', questionnaire: url, identifier: { system: 'urn:parity', value: m } });
    expect(tagged(await search(s, `QuestionnaireResponse?identifier=${m}&_include=QuestionnaireResponse:questionnaire`), { q1 }, 'include')).toEqual(['q1']);
  }));

  test('MemoryRepository _include/_revinclude › _revinclude resolves canonical references [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const m = marker();
    const url = `http://example.com/${m}`;
    const q1 = await s.create({ resourceType: 'Questionnaire', status: 'active', url, identifier: id(m) });
    const r = await s.create({ resourceType: 'QuestionnaireResponse', status: 'completed', questionnaire: url });
    const bundle = await search(s, `Questionnaire?identifier=${m}&_revinclude=QuestionnaireResponse:questionnaire`);
    expect([tagged(bundle, { q1, r }, 'match'), tagged(bundle, { q1, r }, 'include')]).toEqual([['q1'], ['r']]);
  }));

  test('MemoryRepository _include/_revinclude › Invalid include parameter throws badRequest [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    await patient(s, marker());
    expect((await error(s, 'Patient?_include=Patient:bogus')).status).toBe(400);
  }));

  test('MemoryRepository _include/_revinclude › Empty match set skips include processing [fhir-router/src/search-include.test.ts]', () => same(sides, async (s) => {
    const bundle = await search(s, `Observation?identifier=${marker()}&_include=Observation:subject&_total=accurate`);
    expect([bundle.entry, bundle.total]).toEqual([undefined, 0]);
  }));
});
