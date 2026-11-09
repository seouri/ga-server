// Medplum 5.2.14 packages/server/src/fhir/metadata.test.ts, references.test.ts and operations/patienteverything.test.ts, ported
// side by side (see harness.ts). Medplum's buildCapabilityStatement() becomes GET metadata on each server.
import type { Bundle, Observation, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { paritySides, ref, same, type Side } from './harness.ts';

const LOINC = 'http://loinc.org';
const modes = (b: Bundle) => (b.entry ?? []).map((e) => `${e.search?.mode}:${e.resource?.resourceType}/${e.resource?.id}`).sort();

describe.skipIf(SQLITE)('Medplum metadata, references and $everything tests (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  // Medplum's title, its system interactions and its supported profiles are its own: the shared facts only.
  test('CapabilityStatement › Default statement [server/src/fhir/metadata.test.ts]', () => same(sides, async (s) => {
    const stmt = (await s.call('GET', 'metadata')).json;
    expect(stmt.resourceType).toBe('CapabilityStatement');
    expect(stmt.rest[0].interaction.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['transaction', 'batch']));
    const patient = stmt.rest[0].resource.find((r: { type: string }) => r.type === 'Patient');
    expect(patient.interaction.map((i: { code: string }) => i.code)).toContain('create');
    expect(patient.searchParam.length).toBeGreaterThan(0);
    expect(stmt.rest[0].resource.some((r: { type: string }) => r.type === 'Claim')).toBe(true);
  }));

  // Medplum's checkReferencesOnWrite project setting does not change this one: a display-only reference is not checked.
  test('Reference checks › Check references with non-literal reference [server/src/fhir/references.test.ts]', () => same(sides, async (s) => {
    expect((await s.call('POST', 'Patient', { resourceType: 'Patient', link: [{ type: 'refer', other: { display: 'J. Smith' } }] })).status).toBe(201);
  }));

  test('Patient Everything Operation › Success [server/src/fhir/operations/patienteverything.test.ts]', () => same(sides, async (s) => {
    const organization = await s.create({ resourceType: 'Organization' });
    const practitioner = await s.create({ resourceType: 'Practitioner', qualification: [{ code: { text: 'MD' }, issuer: ref(organization) }] });
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }],
      address: [{ use: 'home', line: ['123 Main St'], city: 'Anywhere', state: 'CA', postalCode: '90210' }],
      telecom: [{ system: 'phone', value: '555-555-5555' }, { system: 'email', value: 'alice@example.com' }], managingOrganization: ref(organization) });
    const obs = () => s.create<Observation>({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: LOINC, code: '12345-6' }] }, subject: ref(patient), performer: [ref(practitioner), ref(organization)] });
    const observation = await obs();
    const condition = await s.create({ resourceType: 'Condition', code: { coding: [{ system: LOINC, code: '12345-6' }] }, asserter: ref(patient), subject: ref(patient), recorder: ref(practitioner) });
    const key = (r: Resource) => `${r.resourceType}/${r.id}`;
    const everything = async (query = '') => { const g = await s.call('GET', `Patient/${patient.id}/$everything${query}`); expect(g.status).toBe(200); return g.json as Bundle; };
    const result = await everything();
    expect(result.entry?.length).toBe(5);
    expect(modes(result)).toEqual([`include:${key(organization)}`, `include:${key(practitioner)}`, `match:${key(condition)}`, `match:${key(observation)}`, `match:${key(patient)}`].sort());
    const newObservation = await obs();
    expect(modes(await everything(`?_since=${encodeURIComponent(newObservation.meta!.lastUpdated!)}`)))
      .toEqual([`include:${key(organization)}`, `include:${key(practitioner)}`, `match:${key(newObservation)}`].sort());
    const bundle = await everything('?_count=1&_offset=1');
    expect(['next', 'first', 'previous'].map((r) => bundle.link?.some((l) => l.relation === r))).toEqual([true, true, true]);
    for (const link of bundle.link ?? []) {
      const url = new URL(link.url!);
      expect(url.pathname).toBe(`/fhir/R4/Patient/${patient.id}/$everything`);
      for (const k of ['_compartment', '_sort', '_type', '_inlineAttachments']) expect(url.searchParams.has(k)).toBe(false);
      expect(url.searchParams.get('_count')).toBe('1');
    }
    expect(new URL(bundle.link!.find((l) => l.relation === 'next')!.url!).searchParams.get('_offset')).toBe('2');
    for (const link of (await everything('?_count=1&_type=Observation')).link ?? []) {
      const url = new URL(link.url!);
      expect([url.pathname, url.searchParams.get('_type'), url.searchParams.has('_compartment')]).toEqual([`/fhir/R4/Patient/${patient.id}/$everything`, 'Observation', false]);
    }
    await everything('?start=2020-01-01&end=2040-01-01');
    return [result.entry?.length, bundle.link?.map((l) => l.relation).sort()];
  }));

  // Medplum pages a _type'd $everything by cursor, the store by offset: each side's next link is checked for its own.
  test('Patient Everything Operation › Cursor pagination with _type [server/src/fhir/operations/patienteverything.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const expectedIds = new Set<string>([patient.id]);
    for (let i = 0; i < 24; i++) expectedIds.add((await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'patient_everything_cursor_test' }, subject: ref(patient) })).id);
    let path = `Patient/${patient.id}/$everything?_count=20&_type=Observation`;
    const seenIds = new Set<string>();
    while (path) {
      const g = await s.call('GET', path);
      expect(g.status).toBe(200);
      for (const e of (g.json as Bundle).entry ?? []) seenIds.add(e.resource!.id!);
      const nextUrl = (g.json as Bundle).link?.find((l) => l.relation === 'next')?.url;
      if (!nextUrl) break;
      const next = new URL(nextUrl);
      expect(next.pathname).toBe(`/fhir/R4/Patient/${patient.id}/$everything`);
      expect([next.searchParams.get('_type'), next.searchParams.get('_count')]).toEqual(['Observation', '20']);
      expect(next.searchParams.has(s.name === 'medplum' ? '_cursor' : '_offset')).toBe(true);
      for (const k of ['_compartment', '_sort']) expect(next.searchParams.has(k)).toBe(false);
      path = next.pathname.replace('/fhir/R4/', '') + next.search;
    }
    expect(seenIds).toEqual(expectedIds);
    return seenIds.size;
  }));
});
