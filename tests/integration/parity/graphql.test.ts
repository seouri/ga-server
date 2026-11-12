// GraphQL (store plan 3): Medplum's fhir-router graphql.test.ts and server operations/graphql.test.ts, each body an HTTP call to
// POST $graphql on both sides. Medplum's fixtures (two patients, a service request, two encounters, three observations) are made
// per side, and every search is scoped to them by a marker (family name, encounter identifier, ids): the parity project is shared.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Bundle, Encounter, HumanName, Patient, Resource, StructureDefinition } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, error, marker, paritySides, ref, same, type Side } from './harness.ts';

type Fixtures = { patient: Patient & { id: string }; patient2: Patient & { id: string }; serviceRequest: { id: string }; encounter1: Encounter & { id: string }; encounter2: Encounter & { id: string } };

// POST $graphql: status, the media type without parameters, and the body.
const gql = async (s: Side, query: string) => {
  const g = await s.call('POST', '$graphql', { query });
  return { status: g.status, type: g.headers.get('content-type')?.split(';')[0], json: g.json };
};

describe.skipIf(SQLITE)('GraphQL (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  const family = marker(), miller = marker(), enc = marker();
  const fx: Record<string, Fixtures> = {};
  beforeAll(async () => {
    ({ sides, close } = await paritySides());
    await both(sides, async (s) => {
      const binary = await s.call('POST', 'Binary', 'photo', { 'content-type': 'image/jpeg' });
      const patient = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Alice'], family }], photo: [{ contentType: 'image/jpeg', url: `Binary/${binary.json.id}` }] });
      const patient2 = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Bill'], family: miller }] });
      const serviceRequest = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', code: { text: 'Chest CT' }, subject: ref(patient) });
      const encounter = (subject: { reference: string }, basedOn?: { reference: string }[]) => s.create<Encounter>({
        resourceType: 'Encounter', identifier: [{ value: enc }], status: 'in-progress', class: { code: 'HH' }, subject, ...(basedOn && { basedOn }) });
      const encounter1 = await encounter(ref(patient), [ref(serviceRequest)]);
      await new Promise((r) => setTimeout(r, 10)); // distinct lastUpdated: the sort rows compare the order
      const encounter2 = await encounter({ reference: `Patient/${randomUUID()}` });
      // Medplum's "Reverse lookup with _reference" makes these; its Connection rows count them (patient 1, patient2 2)
      for (const [p, text] of [[patient, 'Blood pressure'], [patient2, 'Blood pressure'], [patient2, 'Heart rate']] as const) {
        await s.create({ resourceType: 'Observation', status: 'final', subject: ref(p), code: { text } });
      }
      fx[s.name] = { patient, patient2, serviceRequest, encounter1, encounter2 };
    });
  }, 240_000);
  afterAll(async () => close?.(), 120_000);

  const both2 = (s: Side) => `_id: "${fx[s.name].patient.id},${fx[s.name].patient2.id}"`;
  // A record's fixture name.
  const named = (s: Side, id: string) => (['patient', 'patient2'] as const).find((k) => fx[s.name][k].id === id) ?? '?';
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

  // Task 3: references, reverse lookups, list arguments, the Connection API.

  const readByReference = () => same(sides, async (s) => {
    const { encounter1, patient } = fx[s.name];
    const g = await gql(s, `{
        Encounter(id: "${encounter1.id}") {
          id
          meta {
            lastUpdated
          }
          subject {
            id
            reference
            resource {
              ... on Patient {
                id
                name {
                  given
                  family
                }
              }
            }
          }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.Encounter.id).toStrictEqual(encounter1.id);
    expect(g.json.data.Encounter.subject.resource.id).toStrictEqual(patient.id);
    expect(g.json.data.Encounter.subject.resource.name[0].given[0]).toStrictEqual('Alice');
    expect(g.type).toBe('application/json');
    return { type: g.type, json: g.json };
  });

  const readByReferenceNotFound = () => same(sides, async (s) => {
    const g = await gql(s, `{
        Encounter(id: "${fx[s.name].encounter2.id}") {
          id
          meta {
            lastUpdated
          }
          subject {
            id
            reference
            resource {
              ... on Patient {
                name {
                  given
                  family
                }
              }
            }
          }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.Encounter).toBeDefined();
    expect(g.json.data.Encounter.subject.resource).toBeNull();
    return g.json; // both sides add a `Not found` error at subject.resource
  });

  // Medplum's PatientList(_count: 2) and (_count: 1) are scoped to the fixtures by _id.
  const reverseLookup = (count: number) => () => same(sides, async (s) => {
    const g = await gql(s, `{
        PatientList(_count: ${count}, ${count === 2 ? both2(s) : `_id: "${fx[s.name].patient.id}"`}) {
          id
          ObservationList(_reference: subject, _sort: "_lastUpdated") {
            id
            status
            code {
              text
            }
          }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.PatientList).toBeDefined();
    expect(g.json.data.PatientList[0].ObservationList).toBeDefined();
    return g.json.data.PatientList.map((p: { id: string; ObservationList: { status: string; code: { text: string } }[] }) =>
      [named(s, p.id), p.ObservationList.map((o) => [o.status, o.code.text])]).sort();
  });

  const reverseLookupWithoutReference = () => same(sides, async (s) => {
    const g = await gql(s, `{
        PatientList(_count: 1) {
          id
          ObservationList(subject: "xyz") {
            id
            status
            code {
              text
            }
          }
        }
      }`);
    const r = { status: g.status, text: g.json?.issue?.[0]?.details?.text };
    expect(r).toEqual({ status: 400, text: 'Argument "Patient.ObservationList(_reference:)" of type "Patient_Observation_reference!" is required, but it was not provided.' });
    return r;
  });

  const cursorPagination = () => same(sides, async (s) => {
    const page = (cursor?: string) => gql(s, `
          {
            EncounterConnection(_count: 1, _sort: "_lastUpdated", identifier: "${enc}"${cursor === undefined ? '' : `, _cursor: "${cursor}"`}) {
              edges {
                resource {
                  id
                }
              }
              next
            }
          }
        `);
    const ids = [fx[s.name].encounter1.id, fx[s.name].encounter2.id];
    const out = [];
    let next: string | undefined;
    for (const cursor of [undefined, 'next']) {
      const g = await page(cursor && next);
      expect(g.status).toBe(200);
      expect(g.json.data.EncounterConnection.edges).toHaveLength(1);
      expect(ids).toContain(g.json.data.EncounterConnection.edges[0].resource.id);
      expect(g.json.data.EncounterConnection.next).toBeDefined();
      next = g.json.data.EncounterConnection.next;
      out.push(g.json.data.EncounterConnection.edges.length);
    }
    return out; // the cursor itself differs: Medplum answers next: null here (offset paging), the store a cursor
  });

  test('GraphQL › Read resource by reference [fhir-router/src/graphql/graphql.test.ts]', readByReference);
  test('GraphQL › Read resource by reference not found [fhir-router/src/graphql/graphql.test.ts]', readByReferenceNotFound);
  test('GraphQL › Reverse lookup with _reference [fhir-router/src/graphql/graphql.test.ts]', reverseLookup(2));
  test('GraphQL › Reverse lookup without _reference [fhir-router/src/graphql/graphql.test.ts]', reverseLookupWithoutReference);
  test('GraphQL › Cursor pagination [fhir-router/src/graphql/graphql.test.ts]', cursorPagination);
  test('GraphQL › Read resource by reference [server/src/fhir/operations/graphql.test.ts]', readByReference);
  test('GraphQL › Read resource by reference not found [server/src/fhir/operations/graphql.test.ts]', readByReferenceNotFound);
  test('GraphQL › Reverse lookup with _reference [server/src/fhir/operations/graphql.test.ts]', reverseLookup(1));
  test('GraphQL › Reverse lookup without _reference [server/src/fhir/operations/graphql.test.ts]', reverseLookupWithoutReference);
  test('GraphQL › Cursor pagination [server/src/fhir/operations/graphql.test.ts]', cursorPagination);

  test(`GraphQL › Reverse lookup on contained resource with invalid id [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const parent = await s.create<Patient>({ resourceType: 'Patient', contained: [{ resourceType: 'Patient', id: 'not valid' }] });
    const g = await gql(s, `{
        Patient(id: "${parent.id}") {
          contained {
            ... on Patient {
              ObservationList(_reference: subject) { id }
            }
          }
        }
      }`);
    expect(g.json.errors[0].message).toBe('Invalid reference');
    return g.json;
  }));

  test(`GraphQL › Reverse lookup with Connection API and count [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, `{
        PatientList(_count: 2, ${both2(s)}) {
          id
          ObservationConnection(_reference: subject) {
            count
            edges {
              resource {
                id
                status
                code {
                  text
                }
              }
            }
          }
        }
      }`);
    expect(g.status).toBe(200);
    const list = g.json.data.PatientList as { id: string; ObservationConnection: { count: number; edges: { resource: { code: { text: string } } }[] } }[];
    expect(typeof list[0].ObservationConnection.count).toBe('number');
    const count = Object.fromEntries(list.map((p) => [named(s, p.id), p.ObservationConnection.count]));
    expect(count).toEqual({ patient: 1, patient2: 2 });
    return list.map((p) => [named(s, p.id), p.ObservationConnection.count, p.ObservationConnection.edges.map((e) => e.resource.code.text).sort()]).sort();
  }));

  test(`GraphQL › Reverse lookup with Connection API count only (no edges) [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, `{
        Patient(id: "${fx[s.name].patient.id}") {
          id
          ObservationConnection(_reference: subject) {
            count
          }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.Patient.ObservationConnection.count).toBe(1);
    expect(g.json.data.Patient.ObservationConnection.edges).toBeUndefined();
    return g.json;
  }));

  // List-field arguments: a Patient of three names (or extensions), the field read with one argument.
  const listArg = (resource: Omit<Patient, 'resourceType'>, field: string, expected: (p: Patient) => unknown) => () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', ...resource });
    const g = await gql(s, `{
        Patient(id: "${patient.id}") {
          id
          ${field}
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.Patient).toBeDefined();
    expect(g.json.data.Patient[field.split('(')[0]]).toMatchObject(expected(patient) as object);
    return g.json;
  });
  const names3 = { name: [{ given: ['given1'], family: 'family1' }, { given: ['given2'], family: 'family2' }, { given: ['given3'], family: 'family3' }] };
  const exts3 = { extension: [1, 2, 3].map((i) => ({ url: `https://example.com/${i}`, valueString: `value${i}` })) };
  test('GraphQL › _offset list field argument [fhir-router/src/graphql/graphql.test.ts]',
    listArg(names3, 'name(_offset: 1) { given family }', (p) => [p.name?.[1], p.name?.[2]]));
  test('GraphQL › _count list field argument [fhir-router/src/graphql/graphql.test.ts]',
    listArg(names3, 'name(_count: 1) { given family }', (p) => [p.name?.[0]]));
  test('GraphQL › fhirpath list field argument [fhir-router/src/graphql/graphql.test.ts]',
    listArg({ name: [{ given: ['given1'], suffix: ['suffix1'] }, ...names3.name.slice(1)] }, 'name(fhirpath: "family.exists()") { given family }', (p) => [p.name?.[1], p.name?.[2]]));
  test('GraphQL › List field argument by name [fhir-router/src/graphql/graphql.test.ts]',
    listArg({ name: names3.name.map((n, i) => ({ use: (['official', 'maiden', 'nickname'] as HumanName['use'][])[i], ...n })) }, 'name(use: "maiden") { use given family }', (p) => [p.name?.[1]]));
  test('GraphQL › Extension list field argument [fhir-router/src/graphql/graphql.test.ts]',
    listArg(exts3, 'extension(url: "https://example.com/2") { url valueString }', (p) => [p.extension?.[1]]));

  test(`GraphQL › List field argument null values [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const family = marker();
    const p1 = await s.create<Patient>({ resourceType: 'Patient', name: [{ family }] });
    const p2 = await s.create<Patient>({ resourceType: 'Patient', name: [{ family }] });
    const p3 = await s.create<Patient>({ resourceType: 'Patient', name: [{ family }], ...exts3 });
    const g = await gql(s, `{
        PatientList(name: "${family}") {
          id
          extension(url: "https://example.com/2") {
            url
            valueString
          }
        }
      }`);
    expect(g.status).toBe(200);
    const list = g.json.data.PatientList as { id: string; extension: unknown }[];
    expect(list).toHaveLength(3);
    const by = (p: { id: string }) => list.find((x) => x.id === p.id)?.extension;
    expect(by(p1)).toBeNull();
    expect(by(p2)).toBeNull();
    expect(by(p3)).toMatchObject([p3.extension?.[1]]);
    return [by(p1), by(p2), by(p3)];
  }));

  // Medplum's name "Smith" is the fixture family (Alice alone).
  const connection = (fields: string) => same(sides, async (s) => {
    const g = await gql(s, `{
        PatientConnection(name: "${family}") { ${fields} }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.PatientConnection).toBeDefined();
    return g.json;
  });
  const edges = 'edges { mode, score, resource { id name { given } } }';
  test('GraphQL › Connection API [fhir-router/src/graphql/graphql.test.ts]', async () => {
    const [r] = await connection(`count offset pageSize ${edges} first previous next last`);
    expect(r.data.PatientConnection).toMatchObject({ count: 1, offset: 0, pageSize: 20, edges: [{ resource: { name: [{ given: ['Alice'] }] } }] });
  });
  test('GraphQL › Connection API without count field [fhir-router/src/graphql/graphql.test.ts]', async () => {
    const [r] = await connection(`offset pageSize ${edges} first previous next last`);
    expect(r.data.PatientConnection).toMatchObject({ offset: 0, pageSize: 20, edges: [{ resource: { name: [{ given: ['Alice'] }] } }] });
  });
  test('GraphQL › Connection API without edges field [fhir-router/src/graphql/graphql.test.ts]', async () => {
    const [r] = await connection('count');
    expect(r.data.PatientConnection.count).toBe(1);
    expect(r.data.PatientConnection.edges).toBeUndefined();
  });

  // Medplum's test stores an ExplanationOfBenefit of only `facility` (its in-memory repository doesn't validate); both servers
  // need the required fields.
  test(`GraphQL › Reference missing reference property [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const eob = await s.create({
      resourceType: 'ExplanationOfBenefit', status: 'active', type: { text: 'claim' }, use: 'claim', patient: ref(fx[s.name].patient), created: '2026-01-01',
      insurer: { display: 'insurer' }, provider: { display: 'provider' }, outcome: 'complete', insurance: [{ focal: true, coverage: { display: 'coverage' } }],
      facility: { display: 'test' },
    });
    const g = await gql(s, `{
        ExplanationOfBenefit(id: "${eob.id}") {
          facility {
            display
            resource {
              ... on Organization {
                resourceType
                name
              }
            }
          }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.errors).toBeUndefined();
    return g.json;
  }));

  test(`GraphQL › Fragment inclusion [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const { encounter1, patient } = fx[s.name];
    const g = await gql(s, `query Visit {
          Encounter(id: "${encounter1.id}") {
            id
            meta {
              lastUpdated
            }
            subject {
              reference
              resource {
                ...PatientInfo
              }
            }
          }

        }

        fragment PatientInfo on Patient {
          id name { given family }
        }`);
    expect(g.status).toBe(200);
    expect(g.json.data.Encounter.id).toStrictEqual(encounter1.id);
    expect(g.json.data.Encounter.subject.resource.id).toStrictEqual(patient.id);
    expect(g.json.data.Encounter.subject.resource.name[0].given[0]).toStrictEqual('Alice');
    expect(g.type).toBe('application/json');
    return g.json;
  }));

  // Mutations (Task 4). A record a mutation creates answers 200, not 201, so the harness doesn't remember it: each row deletes its own.
  const status400 = async (s: Side, query: string) => {
    const g = await gql(s, query);
    return { status: g.status, text: g.json?.issue?.[0]?.details?.text };
  };

  test(`GraphQL › Create Patient Record [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, `mutation {
        PatientCreate(
          res: {
            resourceType: "Patient"
            gender: "male"
            name: [
              {
                given: "Bob"
              }
            ]
          }
        ) {
          id
          gender
          name { given }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.PatientCreate).toBeDefined();
    const read = await s.call('GET', `Patient/${g.json.data.PatientCreate.id}`);
    await s.call('DELETE', `Patient/${g.json.data.PatientCreate.id}`);
    expect(read.json.gender).toStrictEqual('male');
    expect(read.json.name?.[0].given).toStrictEqual(['Bob']);
    return { g: g.json, read: { gender: read.json.gender, name: read.json.name } };
  }));

  test(`GraphQL › Create wrong resourceType error [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const g = await gql(s, `mutation {
        PatientCreate(res: { resourceType: "ServiceRequest" }) { id }
      }`);
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ errors: [{ message: 'Invalid resourceType', locations: [{ line: 2, column: 9 }], path: ['PatientCreate'] }], data: { PatientCreate: null } });
    expect(g.type).toBe('application/json');
    return g;
  }));

  test(`GraphQL › Updating Patient Record [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', gender: 'female', name: [{ given: ['Alice'] }] });
    const g = await gql(s, `mutation {
        PatientUpdate(
          id: "${patient.id}"
          res: {
            id: "${patient.id}"
            resourceType: "Patient"
            gender: "male"
            name: [
              { given: "Bob" },
              { family: "Smith" }
            ]
          }
        ) {
          id
          gender
          name {
            given
          }
        }
      }`);
    expect(g.status).toBe(200);
    const read = (await s.call('GET', `Patient/${patient.id}`)).json as Patient;
    expect(read.gender).toStrictEqual('male');
    expect(read.name?.[1].family).toStrictEqual('Smith');
    return { g: g.json, read: { gender: read.gender, name: read.name } };
  }));

  test(`GraphQL › Invalid Update Mutation [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', gender: 'female', name: [{ given: ['Alice'] }] });
    const r = await status400(s, `mutation {
        PatientUpdate(
          id: "${patient.id}"
        ) {
          id
          gender
          name {
            given
          }
        }
      }`);
    expect(r.text).toStrictEqual('Argument "MutationType.PatientUpdate(res:)" of type "PatientCreate!" is required, but it was not provided.');
    return r;
  }));

  const wrongUpdate = (message: string, res: (s: Side, id: string) => string) => () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient' });
    const g = await gql(s, `mutation {
        PatientUpdate(
          id: "${patient.id}"
          res: {
            ${res(s, patient.id)}
          }
        ) { id }
      }`);
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ errors: [{ message, locations: [{ line: 2, column: 9 }], path: ['PatientUpdate'] }], data: { PatientUpdate: null } });
    expect(g.type).toBe('application/json');
    return g;
  });
  test('GraphQL › Update wrong resourceType error [fhir-router/src/graphql/graphql.test.ts]',
    wrongUpdate('Invalid resourceType', (_s, id) => `resourceType: "ServiceRequest"\n            id: "${id}"`));
  test('GraphQL › Update wrong ID error [fhir-router/src/graphql/graphql.test.ts]',
    wrongUpdate('Invalid ID', () => `resourceType: "Patient"\n            id: "${randomUUID()}"`));

  test(`GraphQL › Delete Patient Record [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const patient = await s.create<Patient>({ resourceType: 'Patient', gender: 'female', name: [{ given: ['Alice'] }] });
    const g = await gql(s, `mutation {
        PatientDelete(
          id: "${patient.id}"
        ) { id }
      }`);
    expect(g.status).toBe(200);
    const read = await error(s, `Patient/${patient.id}`);
    expect(read.status).toBe(410); // Medplum's repository read of a deleted record: gone
    return { g: g.json, read: read.status };
  }));

  test(`GraphQL › Patch Patient Record [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const testPatient = await s.create<Patient>({ resourceType: 'Patient', gender: 'female', name: [{ given: ['Alice'], family: 'Original' }] });
    const g = await gql(s, `mutation {
        PatientPatch(
          id: "${testPatient.id}"
          patch: [
            { op: "replace", path: "/name/0/family", value: "Smith" },
            { op: "replace", path: "/gender", value: "male" }
          ]
        ) {
          id
          gender
          name { family given }
        }
      }`);
    expect(g.status).toBe(200);
    expect(g.json.data.PatientPatch.gender).toBe('male');
    expect(g.json.data.PatientPatch.name[0].family).toBe('Smith');
    const updated = (await s.call('GET', `Patient/${testPatient.id}`)).json as Patient;
    expect(updated.gender).toBe('male');
    expect(updated.name?.[0].family).toBe('Smith');
    return g.json;
  }));

  test(`GraphQL › Invalid Patch Mutation [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const testPatient = await s.create<Patient>({ resourceType: 'Patient', gender: 'female', name: [{ given: ['Alice'], family: 'Original' }] });
    const r = await status400(s, `mutation {
        PatientPatch(
          id: "${testPatient.id}"
        ) {
          id
        }
      }`);
    expect(r.text).toMatch('Argument "MutationType.PatientPatch(patch:)" of type "[PatchOperationInput!]!" is required');
    return r;
  }));

  test(`GraphQL › Invalid Patch Operations [fhir-router/src/graphql/graphql.test.ts]`, () => same(sides, async (s) => {
    const testPatient = await s.create<Patient>({ resourceType: 'Patient', gender: 'female', name: [{ given: ['Alice'], family: 'Original' }] });
    const r = await status400(s, `mutation {
        PatientPatch(
          id: "${testPatient.id}"
          patch: "not-an-array"
        ) {
          id
        }
      }`);
    expect(r.text).toMatch(/Expected value of type "PatchOperationInput" to be an object, found: "not-an-array"/);
    return r;
  }));

  // README: the depth (12) and cost (10,000) limits refuse a query, with Medplum's commented-out texts; Medplum 5.2.14 only logs.
  test('differs on purpose: a query over the depth or cost limit is refused [store-plan-3]', async () => {
    const careTeams = (inner: string, n: number): string => (n ? `participant { member { resource { ... on CareTeam { ${careTeams(inner, n - 1)} } } } }` : inner);
    const [medplum, store] = await both(sides, async (s) => {
      const out = [];
      for (const query of [
        `{ CareTeamList(identifier: "${enc}") { ${careTeams('identifier { system value }', 4)} } }`,
        `{ PatientList(_count: 1000, name: "${family}") { ObservationList(_reference: subject) { subject { resource { ... on Patient { id } } } } } }`,
      ]) {
        const g = await gql(s, query);
        out.push([g.status, g.json?.issue?.[0]?.details?.text]);
      }
      return out;
    });
    expect(medplum).toEqual([[200, undefined], [200, undefined]]);
    expect(store).toEqual([[400, 'Field "system" exceeds max depth (depth=14, max=12)'], [400, 'Query too complex']]);
  });
});
