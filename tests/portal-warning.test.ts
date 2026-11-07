import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MedplumClient } from '@medplum/core';
import { buildMcpServer, portalWarning } from '../src/mcp.ts';

const s = (o: object) => ({ source: 'h', name: 'Hosp', status: 'active', stale: true, enabledTypes: [], ...o });

test('portalWarning: none without stale sources; fix per status and transport', () => {
  expect(portalWarning([], false)).toBeUndefined();
  expect(portalWarning([s({ stale: false })], false)).toBeUndefined();
  expect(portalWarning([s({ status: 'off' })], false)).toContain('`ga connect <its FHIR address>`');
  expect(portalWarning([s({ status: 'off' })], true)).toContain('hospital_connect');
  expect(portalWarning([s({ status: 'error', lastSuccess: '2026-11-01T00:00:00Z' })], true)).toMatch(/last success 2026-11-01T00:00:00Z: sync: hospital_sync$/);
  expect(portalWarning([s({ status: 'off', error: 'disconnected' })], false)).toContain('disconnected it on purpose');
  expect(portalWarning([s({ status: 'error', error: 'not_enabled' })], false)).toContain('ga sync --enable');
});

test('read tools put portalWarning first, cached per server; no Endpoints adds nothing', async () => {
  let reads = 0;
  const connect = async (eps: object[]) => {
    const client = {
      search: async () => ({ resourceType: 'Bundle', entry: [] }),
      searchResources: async () => (reads++, eps),
    } as unknown as MedplumClient;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([buildMcpServer({ client, cfg: {} as never, patientId: 'p' }).connect(a), c.connect(b)]);
    return async () => ((await c.callTool({ name: 'fhir_search', arguments: { resourceType: 'Observation' } })) as { content: { text: string }[] }).content[0].text;
  };
  const stale = { resourceType: 'Endpoint', status: 'off', identifier: [{ system: 'urn:ga-server:id:smart-source', value: 'h' }], extension: [{ url: 'urn:ga-server:ext:smart-patient', valueReference: { reference: 'Patient/p' } }] };
  const search = await connect([stale]);
  expect((await search()).startsWith('{"portalWarning":"Hospital records may be out of date.')).toBe(true);
  await search();
  expect(reads).toBe(1);
  expect(JSON.parse(await (await connect([]))())).toEqual({ resourceType: 'Bundle', entry: [] });
});
