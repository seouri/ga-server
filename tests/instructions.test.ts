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
    expect(t).toContain('lab_results');
    for (const n of ['hospital_status', 'hospital_connect', 'hospital_sync']) expect(t).toContain(n);
    expect(t).toContain('upload_link');
    expect(t).toContain('fileId');
    expect(t).toContain('`confirm` code');
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
  it('drops included admin entries; Observation still works', async () => {
    const r = await call(await mk({ resourceType: 'Observation', id: 'o' }), 'fhir_search', { resourceType: 'Observation' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('Observation');
    expect(r.content[0].text).not.toContain('ClientApplication');
  });
});
