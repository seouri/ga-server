// POST [base]/$graphql resolvers, store-only: references, the per-query read cache, and the depth and cost limits, against a
// stub of the store's request path that records every read and search. Its own file: the definitions load one type set per process.
import { notFound, OperationOutcomeError } from '@medplum/core';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { getIntrospectionQuery } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions } from '../definitions.ts';
import { type Fhir, graphqlHandler } from '../graphql.ts';
describe('$graphql resolvers (store-only)', () => {
  const types = ['CareTeam', 'Observation', 'Patient', 'ServiceRequest'];
  beforeAll(() => loadDefinitions(types));
  const records: Resource[] = [
    { resourceType: 'Patient', id: 'p1', name: [{ family: 'One' }] },
    { resourceType: 'Patient', id: 'p2', contained: [{ resourceType: 'Condition', id: 'c', subject: { reference: 'Patient/p2' } }] },
    { resourceType: 'Observation', id: 'o1', status: 'final', code: { text: 'a' }, subject: { reference: '#x' }, contained: [{ resourceType: 'Patient', id: 'x' }] },
    { resourceType: 'Observation', id: 'o2', status: 'final', code: { text: 'a' }, subject: { reference: 'http://other/Patient/1' } },
    { resourceType: 'Observation', id: 'o3', status: 'final', code: { text: 'a' }, subject: { reference: 'Patient/unknown' } },
    { resourceType: 'Observation', id: 'o4', status: 'final', code: { text: 'a' }, subject: { reference: 'Patient/p1' } },
    { resourceType: 'Observation', id: 'o5', status: 'final', code: { text: 'a' }, subject: { reference: 'Patient/p1' } },
    { resourceType: 'Observation', id: 'o6', status: 'final', code: { text: 'a' }, subject: { reference: 'Condition/c1' } },
    { resourceType: 'Observation', id: 'o7', status: 'final', code: { text: 'a' }, subject: { display: 'no reference' } },
  ] as Resource[];
  // GET Type/id, or a search of a type (its records, by the `subject` and `_id` params when given).
  const stub = () => {
    const calls: string[] = [];
    const fhir: Fhir = (method, path) => {
      calls.push(`${method} ${path}`);
      const [type, rest] = path.split(/[/?]/, 2);
      if (!path.includes('?')) {
        const r = records.find((x) => x.resourceType === type && x.id === decodeURIComponent(rest));
        if (!r) throw new OperationOutcomeError(notFound);
        return r;
      }
      const q = new URLSearchParams(path.slice(path.indexOf('?') + 1)), subject = q.get('subject'), id = q.get('_id')?.split(',');
      const entry = records.filter((x) => x.resourceType === type && (!subject || (x as Observation).subject?.reference === subject) && (!id || id.includes(x.id!))).map((resource) => ({ resource, search: { mode: 'match' } }));
      return { resourceType: 'Bundle', type: 'searchset', entry };
    };
    return { calls, fhir };
  };
  const run = (query: string, variables?: Record<string, unknown>, introspection = false) => {
    const { calls, fhir } = stub();
    const r = graphqlHandler({ query, variables }, fhir, { introspection, types });
    return { status: r.status, json: JSON.parse(r.json), calls };
  };
  const ids = (list: string[]) => `_id: "${list.join(',')}"`;

  it('resource of a contained, absolute or missing reference is null', () => {
    const r = run(`{ ObservationList { id subject { display resource { ... on Patient { id } } } } }`);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.data.ObservationList.map((o: { id: string; subject: unknown }) => [o.id, o.subject]));
    expect(byId).toEqual({
      o1: { display: null, resource: null }, o2: { display: null, resource: null }, o3: { display: null, resource: null },
      o4: { display: null, resource: { id: 'p1' } }, o5: { display: null, resource: { id: 'p1' } },
      o6: { display: null, resource: null }, // a type the store doesn't hold
      o7: { display: 'no reference', resource: null }, // no reference: no error
    });
    // As Medplum's server answers: each reference it cannot follow is a `Not found` error at its own path, nothing else.
    expect(r.json.errors.map((e: { message: string; path: unknown[] }) => [e.message, e.path])).toEqual([0, 1, 2, 5].map((i) => ['Not found', ['ObservationList', i, 'subject', 'resource']]));
    expect(r.calls.filter((c) => !c.includes('?'))).toEqual(['GET Patient/unknown', 'GET Patient/p1']); // never #x, a URL, or Condition
  });

  it('the same reference is read once per query', () => {
    const r = run(`{ ObservationList(${ids(['o3', 'o4', 'o5'])}) { subject { resource { ... on Patient { id } } } } a: Patient(id: "p1") { id } b: Patient(id: "unknown") { id } }`);
    expect(r.json.data.a).toEqual({ id: 'p1' });
    expect(r.json.errors.map((e: { message: string }) => e.message)).toEqual(['Not found', 'Not found']);
    expect(r.calls.filter((c) => !c.includes('?'))).toEqual(['GET Patient/unknown', 'GET Patient/p1']);
  });

  it('a query over the cost limit is 400 and runs no search', () => {
    const nested = `ObservationList(_reference: subject) { subject { resource { ... on Patient { id } } } }`;
    for (const [query, variables] of [
      [`{ PatientList(_count: 1000) { ${nested} } }`, undefined],
      [`query Q($n: Int) { PatientList(_count: $n) { ${nested} } }`, { n: 1000 }], // a variable counts as its value
      [`{ PatientList(_count: 1000) { ObservationConnection(_reference: subject) { count } ObservationList(_reference: subject) { id } } }`, undefined],
    ] as const) {
      const r = run(query, variables);
      expect(r, query).toMatchObject({ status: 400, json: { issue: [{ details: { text: 'Query too complex' } }] } });
      expect(r.json.issue).toHaveLength(1);
      expect(r.calls).toEqual([]);
    }
    expect(run(`{ PatientList(_count: 2) { ${nested} } }`).status).toBe(200);
  });

  it('a defaulted variable or a negative-count sibling does not evade the cost limit', () => {
    const nested = `ObservationList(_reference: subject) { subject { resource { ... on Patient { id } } } }`;
    for (const query of [
      `query Q($n: Int = 1000) { PatientList(_count: $n) { ${nested} } }`, // no variables sent: the default runs
      `{ a: PatientList(_count: -1000) { ${nested} } b: PatientList(_count: 1000) { ${nested} } }`, // unclamped, a costs -27,992
      // a shared fragment is costed per operation: B's cheap default must not stand for A's
      `query B($n: Int = 2) { ...F } query A($n: Int = 1000) { ...F } fragment F on QueryType { PatientList(_count: $n) { ${nested} } }`,
    ]) {
      const r = run(query);
      expect(r, query).toMatchObject({ status: 400, json: { issue: [{ details: { text: 'Query too complex' } }] } });
      expect(r.calls).toEqual([]);
    }
    expect(run(`query Q($n: Int = 1000) { PatientList(_count: $n) { ${nested} } }`, { n: 2 }).status).toBe(200); // a sent value wins
  });

  it('a contained resource of a type the store does not hold is a field error', () => {
    const r = run(`{ Patient(id: "p2") { id contained { ... on Patient { id } } } }`);
    expect(r.status).toBe(200);
    expect(r.json.data.Patient).toEqual({ id: 'p2', contained: null });
    expect(r.json.errors).toHaveLength(1);
    expect(r.json.errors[0].path).toEqual(['Patient', 'contained', 0]);
  });

  it('a query deeper than 12 fields is 400; fragments count, inline fragments do not', () => {
    const careTeams = (inner: string, n: number): string => (n ? `participant { member { resource { ... on CareTeam { ${careTeams(inner, n - 1)} } } } }` : inner);
    const deep = careTeams('identifier { system value }', 4);
    for (const query of [`{ CareTeamList { ${deep} } }`, `{ CareTeamList { ...F } } fragment F on CareTeam { ${deep} }`]) {
      expect(run(query), query).toMatchObject({ status: 400, json: { issue: [{ details: { text: 'Field "system" exceeds max depth (depth=14, max=12)' } }] } });
    }
    // Medplum's 8 levels (its skipped "Max depth" test) are allowed
    expect(run(`{ ServiceRequestList { id basedOn { resource { ...on ServiceRequest { id basedOn { resource { ...on ServiceRequest {
      id asNeededCodeableConcept { coding { extension { url } } } } } } } } } } }`).status).toBe(200);
  });

  it('a reverse lookup through _compartment or an every-type target is a 400 validation error naming the field', () => {
    expect(run(`{ PatientList { ObservationList(_reference: subject) { id } } }`).status).toBe(200);
    for (const [field, ref] of [['ObservationList', '_compartment'], ['ObservationConnection', 'focus'], ['ObservationList', 'focus']]) {
      const r = run(`{ PatientList { ${field}(_reference: ${ref}) { id } } }`);
      expect(r.status, field + ref).toBe(400);
      expect(r.json.issue[0].details.text, field + ref).toMatch(new RegExp(`Value "${ref}" does not exist in "Patient_Observation_reference" enum`));
    }
    // Observation is a target of no Patient parameter but _compartment: no PatientList under Observation at all
    expect(run(`{ ObservationList { PatientList(_reference: _compartment) { id } } }`).json.issue[0].details.text).toMatch(/Cannot query field "PatientList" on type "Observation"/);
  });

  it('the standard introspection query (depth 15) is not refused for depth', () => {
    expect(run(getIntrospectionQuery(), undefined, true).status).toBe(200);
  });
});
