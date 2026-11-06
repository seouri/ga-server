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
  const client = { search: async () => ({ blob: 'x'.repeat(200_000) }) } as unknown as MedplumClient;
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
