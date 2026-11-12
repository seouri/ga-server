import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MedplumClient } from '@medplum/core';
import { chatInstructions } from '../src/instructions.ts';
import { buildMcpServer } from '../src/mcp.ts';

describe('chatInstructions', () => {
  const t = chatInstructions();
  it('carries the skill and the tool-based fixes', () => {
    expect(t).toContain('Cite every value');
    expect(t).toContain('cardiovascular_risk_10yr');
    expect(t).toContain('liver_fibrosis_risk');
    expect(t).toContain('lab_results');
    expect(t).toContain('whats_new');
    for (const n of ['hospital_status', 'hospital_connect', 'hospital_sync']) expect(t).toContain(n);
    expect(t).toContain('upload_link');
    expect(t).toContain('fileId');
    expect(t).toContain('`confirmUrl`');
    expect(t).toContain('you cannot confirm it yourself');
    expect(t).not.toContain('`confirm` code');
    expect(t).toContain('record_followup');
    expect(t).toContain('health_maintenance');
    // hospital_sync takes only a source: enabling or dropping types is hospital_enable (it replaces the enabled set).
    expect(t).not.toContain('`hospital_sync` with `enable`');
    expect(t).toContain('`hospital_enable` with the enabled types without them');
  });
  it('has no CLI or repo-only references', () => {
    for (const s of ['ga share', '/ga-import', 'AGENTS.md', 'ga connect', 'ga sync', 'sourceFile']) expect(t).not.toContain(s);
    expect(t.length).toBeLessThan(20_000);
  });
});

const connect = async (remote: boolean, logs: string[] = []) => {
  const client = { search: async () => ({ blob: 'x'.repeat(200_000) }), searchResources: async () => [] } as unknown as MedplumClient;
  const server = buildMcpServer({ client, cfg: {} as never, patientId: 'p', ...(remote ? { remote: { publicUrl: 'u', clientName: 'c', log: async (n: string) => void logs.push(n) } } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
};
const search = (c: Client) => c.callTool({ name: 'fhir_search', arguments: { resourceType: 'Observation' } }) as Promise<{ content: { text: string }[] }>;

describe('remote output cap and logging', () => {
  it('cuts a 200k result at 150k with a marker and logs the tool', async () => {
    const logs: string[] = [];
    const r = await search(await connect(true, logs));
    expect(r.content[0].text.startsWith('{"blob":"xxx')).toBe(true);
    expect(r.content[0].text).toMatch(/^.{150000}\[truncated: narrow the search, e\.g\. _count, _elements or a date range\]$/s);
    expect(logs).toEqual(['fhir_search']);
  });
  it('whats_new and the maintenance tools are registered on stdio and remote', async () => {
    for (const remote of [false, true]) {
      const names = (await (await connect(remote)).listTools()).tools.map((t) => t.name);
      for (const n of ['whats_new', 'health_maintenance', 'postpone', 'record_followup']) expect(names).toContain(n);
    }
  });
  it('logs every call, and a failing log fails the call', async () => {
    const logs: string[] = [];
    const c = await connect(true, logs);
    await search(c);
    await c.callTool({ name: 'fhir_read', arguments: { resourceType: 'Observation', id: 'o' } });
    expect(logs).toEqual(['fhir_search', 'fhir_read']);
    const server = buildMcpServer({ client: {} as MedplumClient, cfg: {} as never, patientId: 'p', remote: { publicUrl: 'u', clientName: 'c', log: async () => { throw new Error('log down'); } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const d = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), d.connect(b)]);
    const r = (await d.callTool({ name: 'fhir_read', arguments: { resourceType: 'Observation', id: 'o' } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
  it('a write tool whose log fails does not run; a read-only tool still logs', async () => {
    let ran = 0;
    const logs: string[] = [];
    const client = { searchResources: async () => [], search: async () => ({ resourceType: 'Bundle' }), createResource: async () => { ran++; return {}; } } as unknown as MedplumClient;
    const mk = async (log: (n: string) => Promise<void>) => {
      const server = buildMcpServer({ client, cfg: {} as never, patientId: 'p', remote: { publicUrl: 'u', clientName: 'c', log } });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: 't', version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      return c;
    };
    const down = await mk(async () => { throw new Error('log down'); });
    const w = (await down.callTool({ name: 'postpone', arguments: { topic: 'colorectal' } })) as { isError?: boolean };
    expect(w.isError).toBe(true);
    expect(ran).toBe(0);
    await (await mk(async (n) => void logs.push(n))).callTool({ name: 'fhir_search', arguments: { resourceType: 'Observation' } });
    expect(logs).toEqual(['fhir_search']);
  });
  it('stdio is untouched', async () => {
    expect((await search(await connect(false))).content[0].text.length).toBeGreaterThan(200_000);
  });
});

describe('admin types are refused', () => {
  const mk = async (resource: object) => {
    const client = { search: async () => ({ entry: [{ resource: { resourceType: 'ClientApplication', secret: 's' } }, { resource }] }), readResource: async () => ({ resourceType: 'ClientApplication' }) } as unknown as MedplumClient;
    const server = buildMcpServer({ client, cfg: {} as never, patientId: 'p' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, string>) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  it('refuses fhir_read and fhir_search of ClientApplication', async () => {
    const c = await mk({ resourceType: 'Observation', id: 'o' });
    for (const r of [await call(c, 'fhir_read', { resourceType: 'ClientApplication', id: '1' }), await call(c, 'fhir_search', { resourceType: 'ClientApplication' })]) {
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('not available');
    }
  });
  it('fhir_read ids: parallel, missing ones as {id, error}; id alone keeps its shape', async () => {
    const client = { searchResources: async () => [], readResource: async (_t: string, id: string) => { if (id === 'gone') throw new Error('Not found'); return { resourceType: 'Observation', id }; } } as unknown as MedplumClient;
    const server = buildMcpServer({ client, cfg: {} as never, patientId: 'p' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const read = async (args: Record<string, unknown>) => JSON.parse(((await c.callTool({ name: 'fhir_read', arguments: { resourceType: 'Observation', ...args } })) as { content: { text: string }[] }).content[0].text);
    expect(await read({ id: 'o1' })).toEqual({ resourceType: 'Observation', id: 'o1' });
    expect(await read({ ids: ['o1', 'gone', 'o2'] })).toEqual({ resources: [{ resourceType: 'Observation', id: 'o1' }, { id: 'gone', error: 'Not found' }, { resourceType: 'Observation', id: 'o2' }] });
  });
  it('drops included admin entries; Observation still works', async () => {
    const r = await call(await mk({ resourceType: 'Observation', id: 'o' }), 'fhir_search', { resourceType: 'Observation' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('Observation');
    expect(r.content[0].text).not.toContain('ClientApplication');
  });
});
