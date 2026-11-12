// POST [base]/$graphql, store-only behaviour: introspection off (the default), a store that holds only some types, and $graphql
// as a batch entry. One Patient-only store for the file (the definitions are loaded once per process).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
