// GraphQL (store plan 3): Medplum's fhir-router graphql.test.ts and server operations/graphql.test.ts, each body an HTTP call to
// POST $graphql on both sides. Medplum's fixtures (two patients, a service request, two encounters) are made per side, and every
// search is scoped to them by a marker (family name, encounter identifier): the parity project is shared.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Bundle, Encounter, Patient, Resource, StructureDefinition } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, error, marker, paritySides, ref, same, type Side } from './harness.ts';

type Fixtures = { patient: Patient & { id: string }; serviceRequest: { id: string }; encounter1: Encounter & { id: string }; encounter2: Encounter & { id: string } };

// POST $graphql: status, the media type without parameters, and the body.
const gql = async (s: Side, query: string) => {
  const g = await s.call('POST', '$graphql', { query });
  return { status: g.status, type: g.headers.get('content-type')?.split(';')[0], json: g.json };
};

describe.skipIf(SQLITE)('GraphQL (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  const family = marker(), enc = marker();
  const fx: Record<string, Fixtures> = {};
  beforeAll(async () => {
    ({ sides, close } = await paritySides());
    await both(sides, async (s) => {
      const binary = await s.call('POST', 'Binary', 'photo', { 'content-type': 'image/jpeg' });
      const patient = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Alice'], family }], photo: [{ contentType: 'image/jpeg', url: `Binary/${binary.json.id}` }] });
      await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Bill'], family: `${family}-miller` }] });
      const serviceRequest = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', code: { text: 'Chest CT' }, subject: ref(patient) });
      const encounter = (subject: { reference: string }, basedOn?: { reference: string }[]) => s.create<Encounter>({
        resourceType: 'Encounter', identifier: [{ value: enc }], status: 'in-progress', class: { code: 'HH' }, subject, ...(basedOn && { basedOn }) });
      const encounter1 = await encounter(ref(patient), [ref(serviceRequest)]);
      await new Promise((r) => setTimeout(r, 10)); // distinct lastUpdated: the sort rows compare the order
      const encounter2 = await encounter({ reference: `Patient/${randomUUID()}` });
      fx[s.name] = { patient, serviceRequest, encounter1, encounter2 };
    });
  }, 240_000);
  afterAll(async () => close?.(), 120_000);

  // The encounters of a list by fixture name, in order.
  const encounters = (s: Side, list: { id: string }[]) => list.map((e) => (e.id === fx[s.name].encounter1.id ? 'encounter1' : e.id === fx[s.name].encounter2.id ? 'encounter2' : '?'));

  test('GET $graphql is answered as Medplum answers it [store-only probe]', () => same(sides, async (s) => {
    const r = await error(s, '$graphql');
    expect(r).toEqual({ status: 400, text: 'Unknown resource type' });
    return r;
  }));

  test(`GraphQL › Missing query [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await s.call('POST', '$graphql', {});
    const r = { status: g.status, text: g.json?.issue?.[0]?.details?.text };
    expect(r).toEqual({ status: 400, text: 'Must provide query.' });
    return r;
  }));

  test(`GraphQL › Syntax error [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, 'This is not valid GraphQL.');
    const r = { status: g.status, text: g.json?.issue?.[0]?.details?.text };
    expect(r).toEqual({ status: 400, text: 'GraphQL syntax error.' });
    return r;
  }));

  // The schemas differ (Medplum's holds its own resource types), so only the answer's kind is compared.
  test(`GraphQL › Introspection allowed [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, `{
          __schema {
            types {
              name
            }
          }
        }`);
    const r = { status: g.status, type: g.type, types: Array.isArray(g.json?.data?.__schema?.types) && g.json.data.__schema.types.length > 0 };
    expect(r).toEqual({ status: 200, type: 'application/json', types: true });
    return r;
  }));

  test(`GraphQL › Allows value introspection [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, `{
        Patient(id: "${randomUUID()}") {
          id
          name { __typename given }
        }
      }`);
    expect(g.status).toBe(200);
    return g;
  }));

  test(`GraphQL › Read by ID [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const { patient } = fx[s.name];
    const g = await gql(s, `{
        Patient(id: "${patient.id}") {
          id
          name { given }
          photo { url }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.Patient.id).toStrictEqual(patient.id);
    expect(g.json.data.Patient.photo[0].url).toBeDefined();
    expect(g.type).toBe('application/json');
    // the url itself differs: Medplum presigns it (see the server row's skip reason)
    return { status: g.status, type: g.type, name: g.json.data.Patient.name, url: typeof g.json.data.Patient.photo[0].url };
  }));

  // Rows in both files: one body, two tests.
  const readNotFound = () => same(sides, async (s) => {
    const g = await gql(s, `{
      Patient(id: "${randomUUID()}") {
        id
        name { given }
      }
    }`);
    expect(g.status).toBe(200);
    expect(g.json.data.Patient).toBeNull();
    expect(g.json.errors[0].message).toStrictEqual('Not found');
    return g;
  });

  const searchByName = () => same(sides, async (s) => {
    const g = await gql(s, `{
      PatientList(name: "${family}") {
        id
        name { given }
      }
    }`);
    expect(g.status).toBe(200);
    expect(g.json.data.PatientList).toBeDefined();
    return g.json.data.PatientList.map((p: Patient) => p.name?.[0]?.given?.[0]).sort(); // unsorted search: order differs
  });

  const searchById = () => same(sides, async (s) => {
    const g = await gql(s, `{
      PatientList(_id: "${fx[s.name].patient.id}") {
        id
      }
    }`);
    expect(g.status).toBe(200);
    expect(g.json.data.PatientList.length).toBe(1);
    expect(g.json.data.PatientList[0].id).toBe(fx[s.name].patient.id);
    return g.json.data.PatientList.length;
  });

  const searchCount = () => same(sides, async (s) => {
    const g = await gql(s, `{
      EncounterList(_count: 1, identifier: "${enc}") {
        id
      }
    }`);
    expect(g.status).toBe(200);
    expect(g.json.data.EncounterList.length).toBe(1);
    return g.json.data.EncounterList.length;
  });

  const searchBasedOn = () => same(sides, async (s) => {
    const g = await gql(s, `{
      EncounterList(based_on: "ServiceRequest/${fx[s.name].serviceRequest.id}") {
        id
      }
    }`);
    expect(g.status).toBe(200);
    expect(g.json.data.EncounterList.length).toBe(1);
    return encounters(s, g.json.data.EncounterList);
  });

  const sortBy = (sort: string, cmp: number) => () => same(sides, async (s) => {
    const g = await gql(s, `{
      EncounterList(_sort: "${sort}", identifier: "${enc}") {
        id
        meta { lastUpdated }
      }
    }`);
    expect(g.status).toBe(200);
    const list = g.json.data.EncounterList;
    expect(list.length >= 2).toBe(true);
    expect(Math.sign(list[0].meta.lastUpdated.localeCompare(list[1].meta.lastUpdated)) * cmp).toBeGreaterThanOrEqual(0);
    return encounters(s, list);
  });

  test('GraphQL › Read by ID not found [fhir-router/src/graphql/graphql.test.ts]', readNotFound);
  test('GraphQL › Search [fhir-router/src/graphql/graphql.test.ts]', searchByName);
  test('GraphQL › Search with _id [fhir-router/src/graphql/graphql.test.ts]', searchById);
  test('GraphQL › Search with _count [fhir-router/src/graphql/graphql.test.ts]', searchCount);
  test('GraphQL › Search with based-on [fhir-router/src/graphql/graphql.test.ts]', searchBasedOn);
  test('GraphQL › Sort by _lastUpdated asc [fhir-router/src/graphql/graphql.test.ts]', sortBy('_lastUpdated', -1));
  test('GraphQL › Sort by _lastUpdated desc [fhir-router/src/graphql/graphql.test.ts]', sortBy('-_lastUpdated', 1));
  test('GraphQL › Read by ID not found [server/src/fhir/operations/graphql.test.ts]', readNotFound);
  test('GraphQL › Search [server/src/fhir/operations/graphql.test.ts]', searchByName);
  test('GraphQL › Search with _id [server/src/fhir/operations/graphql.test.ts]', searchById);
  test('GraphQL › Search with _count [server/src/fhir/operations/graphql.test.ts]', searchCount);
  test('GraphQL › Search with based-on [server/src/fhir/operations/graphql.test.ts]', searchBasedOn);
  test('GraphQL › Sort by _lastUpdated asc [server/src/fhir/operations/graphql.test.ts]', sortBy('_lastUpdated', -1));
  test('GraphQL › Sort by _lastUpdated desc [server/src/fhir/operations/graphql.test.ts]', sortBy('-_lastUpdated', 1));

  test(`GraphQL › Search with _filter [server/src/fhir/operations/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, `{
        PatientList(_filter: "name eq ${family}") {
          id
          name { given }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.PatientList).toBeDefined();
    return g.json.data.PatientList.map((p: Patient) => p.name?.[0]?.given?.[0]).sort();
  }));

  // Medplum serves the R4 StructureDefinitions and SearchParameters as records; the store side is given the Patient one the
  // query finds. Medplum's built-in SearchParameter set is its own: only that the list resolves is compared.
  test(`GraphQL › StructureDefinition query [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    if (s.name === 'store') {
      const all = (JSON.parse(readFileSync(new URL('../fhir/r4/profiles-resources.json', import.meta.resolve('@medplum/definitions')), 'utf8')) as Bundle<Resource>).entry!;
      await s.create(all.map((e) => e.resource as StructureDefinition).find((r) => r.resourceType === 'StructureDefinition' && r.name === 'Patient')!);
    }
    const g = await gql(s, `{
        StructureDefinitionList(name: "Patient") {
          name
          description
          snapshot {
            element {
              id
              path
              min
              max
              type {
                code
                targetProfile
              }
              binding {
                valueSet
              }
              definition
            }
          }
        }
        SearchParameterList(base: "Patient", _count: 100) {
          base
          code
          type
          expression
          target
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.StructureDefinitionList).toBeDefined();
    expect(g.json.data.SearchParameterList).toBeDefined();
    return { errors: g.json.errors, sd: g.json.data.StructureDefinitionList.map((d: StructureDefinition) => [d.name, d.snapshot?.element?.length]), sp: Array.isArray(g.json.data.SearchParameterList) };
  }));

  test(`GraphQL › Get __type [server/src/fhir/operations/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await s.call('POST', '$graphql', { query: `{
          __type(name: "Patient") {
            name
            kind
          }
        }` });
    const r = { status: g.status, type: g.headers.get('content-type'), cache: g.headers.get('cache-control'), json: g.json };
    expect(r.status).toBe(200);
    expect(r.type).toBe('application/json; charset=utf-8');
    expect(r.cache).toBe('no-store, no-cache, must-revalidate');
    return r;
  }));
});
