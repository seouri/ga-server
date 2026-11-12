// POST [base]/$graphql, store-only behaviour: introspection off (the default), a store that holds only some types, and $graphql
// as a batch entry. One Patient-only store for the file (the definitions are loaded once per process).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationOutcomeToString } from '@medplum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveStore } from '../server.ts';

let server: Server, dir: string, base: string, headers: Record<string, string>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'store-graphql-'));
  server = await serveStore({ file: join(dir, 'x.db'), port: 0, tokenFile: join(dir, 'token'), types: ['Patient'] });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fhir/R4/`;
  headers = { authorization: `Bearer ${readFileSync(join(dir, 'token'), 'utf8').trim()}`, 'content-type': 'application/json' };
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const gql = (query: string) => post('$graphql', { query });
const count = async () => (await (await fetch(base + 'Patient?_summary=count', { headers })).json()).total;

describe('$graphql (store-only)', () => {
  it('introspection is 403 when disabled; __typename is allowed', async () => {
    expect((await gql('{ __schema { types { name } } }')).status).toBe(403);
    expect((await gql('{ __type(name: "Patient") { name } }')).status).toBe(403);
    expect(await gql('{ __typename }')).toEqual({ status: 200, json: { data: { __typename: 'QueryType' } } });
  });

  it('introspection through an alias or fragment is 403 when disabled', async () => {
    const r = await gql('{ s: __schema { types { name } } }');
    expect(r.status).toBe(403);
    expect(r.json.issue[0].code).toBe('forbidden');
    expect((await gql('{ ...F } fragment F on QueryType { s: __schema { types { name } } }')).status).toBe(403);
  });

  it('a field for an unstored type is a 400 validation error', async () => {
    const r = await gql('{ ConditionList { id } }');
    expect(r.status).toBe(400);
    expect(r.json.issue[0].details.text).toMatch(/Cannot query field "ConditionList" on type "QueryType"/);
    expect((await gql('{ PatientList(_count: 1) { id } }'))).toEqual({ status: 200, json: { data: { PatientList: [] } } });
  });

  it('a read by a dot-segment id is not found, never another route', async () => {
    for (const id of ['.', '..', '%2e', '%2E', '']) {
      const r = await gql(`{ Patient(id: "${id}") { id resourceType } }`);
      expect(r, id).toMatchObject({ status: 200, json: { data: { Patient: null }, errors: [{ message: 'Not found' }] } });
    }
  });

  it('a transaction with a failing $graphql entry fails whole', async () => {
    const family = `tx-${Date.now()}`;
    const r = await post('', { resourceType: 'Bundle', type: 'transaction', entry: [
      { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', name: [{ family }] } },
      { request: { method: 'POST', url: '$graphql' }, resource: { query: '{ ConditionList { id } }' } },
    ] });
    expect(r.status).toBe(400);
    expect(r.json.issue[0].details.text).toMatch(/ConditionList/);
    expect((await gql(`{ PatientList(family: "${family}") { id } }`)).json).toEqual({ data: { PatientList: [] } });
  });

  it('$graphql works as a batch entry', async () => {
    const r = await post('', { resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'POST', url: '$graphql' }, resource: { query: '{ __typename }' } }] });
    expect(r.status).toBe(200);
    expect(r.json.entry[0].response.status).toBe('200');
    expect(r.json.entry[0].resource).toEqual({ data: { __typename: 'QueryType' } });
  });

  it('invalid create writes nothing and gives the REST error text', async () => {
    const before = await count();
    const rest = await post('Patient', { resourceType: 'Patient', birthDate: "x" });
    expect(rest.status).toBe(400);
    const r = await gql('mutation { PatientCreate(res: { resourceType: "Patient", birthDate: "x" }) { id } }');
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ PatientCreate: null });
    expect(r.json.errors[0].message).toBe(operationOutcomeToString(rest.json));
    // Medplum's own checks, before any write
    const wrongType = await gql('mutation { PatientCreate(res: { resourceType: "Observation" }) { id } }');
    expect(wrongType.json.errors[0].message).toBe('Invalid resourceType');
    const wrongId = await gql('mutation { PatientUpdate(id: "a", res: { resourceType: "Patient", id: "b" }) { id } }');
    expect(wrongId.json.errors[0].message).toBe('Invalid ID');
    // a missing required input field (Extension.url) is a GraphQL validation error, before any write (as Medplum)
    const noUrl = await gql('mutation { PatientCreate(res: { resourceType: "Patient", extension: [{ valueString: "a" }] }) { id } }');
    expect(noUrl.status).toBe(400);
    expect(noUrl.json.issue[0].details.text).toMatch(/Expected value of type "ExtensionCreate" to include required field "url"/);
    expect(await count()).toBe(before);
  });

  it('a write in a request is what a later reference in that request reads', async () => {
    const p = (await post('Patient', { resourceType: 'Patient', gender: 'female' })).json;
    const linked = (alias: string, id: string) => `${alias}: PatientCreate(res: { resourceType: "Patient", link: [{ type: "seealso", other: { reference: "Patient/${id}" } }] }) { link { other { resource { ... on Patient { gender } } } } }`;
    const gender = (data: any, alias: string) => data[alias]?.link[0].other.resource?.gender ?? null;
    // update and patch prime the per-request read: a read before them is not reused after
    let r = await gql(`mutation { ${linked('a', p.id)} u: PatientUpdate(id: "${p.id}", res: { resourceType: "Patient", id: "${p.id}", gender: "male" }) { id } ${linked('b', p.id)}
      x: PatientPatch(id: "${p.id}", patch: [{ op: "replace", path: "/gender", value: "other" }]) { id } ${linked('c', p.id)} }`);
    expect([gender(r.json.data, 'a'), gender(r.json.data, 'b'), gender(r.json.data, 'c')]).toEqual(['female', 'male', 'other']);
    // delete clears it: the deleted record is not read from the cache
    r = await gql(`mutation { ${linked('a', p.id)} d: PatientDelete(id: "${p.id}") { id } ${linked('b', p.id)} }`);
    expect([gender(r.json.data, 'a'), gender(r.json.data, 'b')]).toEqual(['other', null]);
    expect(r.json.errors.map((e: { path: unknown[] }) => e.path[0])).toEqual(['b']);
  });

  it('a mutation in a transaction is kept with it, or rolled back with it', async () => {
    const family = `txm-${Date.now()}`;
    const mutation = { request: { method: 'POST', url: '$graphql' }, resource: { query: `mutation { PatientCreate(res: { resourceType: "Patient", name: [{ family: "${family}" }] }) { id } }` } };
    const ok = await post('', { resourceType: 'Bundle', type: 'transaction', entry: [
      { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', name: [{ family }] } }, mutation] });
    expect(ok.status).toBe(200);
    expect((await gql(`{ PatientList(family: "${family}") { id } }`)).json.data.PatientList).toHaveLength(2);
    const failed = await post('', { resourceType: 'Bundle', type: 'transaction', entry: [
      mutation, { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', name: [{ family }], birthDate: 'x' } }] });
    expect(failed.status).toBe(400);
    expect((await gql(`{ PatientList(family: "${family}") { id } }`)).json.data.PatientList).toHaveLength(2);
  });
});
