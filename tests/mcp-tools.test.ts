import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MedplumClient } from '@medplum/core';
import { buildMcpServer, pageParams, portalWarning } from '../src/mcp.ts';

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

test('read tools put portalWarning first; no Endpoints adds nothing; a failed check says status unknown', async () => {
  let reads = 0;
  const connect = async (eps: object[]) => {
    const client = {
      search: async () => ({ resourceType: 'Bundle', entry: [] }),
      searchResources: async () => (reads++, eps),
      searchResourcePages: async function* () { yield []; }, searchOne: async () => undefined,
      readResource: async () => ({ resourceType: 'Patient', birthDate: '1980-01-01' }),
    } as unknown as MedplumClient;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([buildMcpServer({ client, cfg: {} as never, patientId: 'p' }).connect(a), c.connect(b)]);
    return async (name = 'fhir_search', args: Record<string, unknown> = { resourceType: 'Observation' }) => ((await c.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
  };
  const stale = { resourceType: 'Endpoint', status: 'off', identifier: [{ system: 'urn:ga-server:id:smart-source', value: 'h' }], extension: [{ url: 'urn:ga-server:ext:smart-patient', valueReference: { reference: 'Patient/p' } }] };
  const search = await connect([stale]);
  expect((await search()).startsWith('{"portalWarning":"Hospital records may be out of date.')).toBe(true);
  expect(reads).toBe(1);
  expect((await search('whats_new', { since: '2026-11-01' })).startsWith('{"portalWarning":')).toBe(true);
  expect(JSON.parse(await (await connect([]))())).toEqual({ resourceType: 'Bundle', entry: [] });
  const broken = { search: async () => ({ resourceType: 'Bundle' }), readResource: async () => ({ resourceType: 'Observation', id: 'o' }), searchResources: async () => { throw new Error('down'); } } as unknown as MedplumClient;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([buildMcpServer({ client: broken, cfg: {} as never, patientId: 'p' }).connect(a), c.connect(b)]);
  for (const [name, args] of [['fhir_read', { resourceType: 'Observation', id: 'o' }], ['cardiovascular_risk_10yr', { age: 50, sex: 'male', sbp: 120, bpTx: false, totalC: 200, hdlC: 50, statin: false, diabetes: false, smoker: false, egfr: 90 }]] as const)
    expect(JSON.parse(((await c.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text).portalWarning).toBe('Hospital connection status unknown: run `ga status`.');
});

test('fhir_search paging: nextPage carries the next link params only; page searches the given type; tampered tokens refused', async () => {
  const calls: [string, string][] = [];
  const client = {
    search: async (t: string, q: URLSearchParams) => (
      calls.push([t, q.toString()]),
      { resourceType: 'Bundle', entry: [], link: [{ relation: 'next', url: 'http://medplum:8103/fhir/R4/Observation?date=ge2024-01-01&date=lt2025-01-01&_count=5&_offset=5' }] }
    ),
  } as unknown as MedplumClient;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([buildMcpServer({ client, cfg: {} as never, patientId: 'p' }).connect(a), c.connect(b)]);
  const call = async (args: object) => (await c.callTool({ name: 'fhir_search', arguments: { resourceType: 'Observation', ...args } })) as { isError?: boolean; content: { text: string }[] };
  const first = JSON.parse((await call({ params: { _count: '5' } })).content[0].text);
  // Warning and cursor ahead of the entries (the remote cap cuts the end); no link with Medplum's base URL.
  expect(Object.keys(first)).toEqual(['portalWarning', 'nextPage', 'resourceType', 'entry']);
  const { nextPage } = first;
  expect(pageParams(nextPage).getAll('date')).toEqual(['ge2024-01-01', 'lt2025-01-01']);
  await call({ page: nextPage, params: { code: 'ignored' } });
  expect(calls[1]).toEqual(['Observation', 'date=ge2024-01-01&date=lt2025-01-01&_count=5&_offset=5']);
  for (const page of ['not-a-token', Buffer.from('"http://evil.example/x"').toString('base64url'), Buffer.from('[["a",1]]').toString('base64url')]) {
    const r = await call({ page });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('invalid page token');
  }
  expect(calls).toHaveLength(2);
  expect((await call({ page: nextPage, resourceType: 'ClientApplication' })).content[0].text).toContain('not available');
});
