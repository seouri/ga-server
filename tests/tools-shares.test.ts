import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MedplumClient } from '@medplum/core';
import { registerShareTools } from '../src/tools/shares.ts';
import { listShares } from '../src/share/store.ts';

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-shares-'));
  const client = { searchResources: async () => [] } as unknown as MedplumClient;
  const server = new McpServer({ name: 't', version: '0' });
  registerShareTools(server, { client, cfg: {} as never, patientId: 'p', remote: { publicUrl: 'https://x.example', clientName: 'c', log: async () => {} } }, dir);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    return { ...r, json: r.content[0]?.type === 'text' && !r.isError ? JSON.parse(r.content[0].text!) : undefined, msg: r.content[0]?.text };
  };
  return { dir, call };
};
const args = { audience: 'family', label: 'Mom', scope: ['labs'] };

describe('share tools', () => {
  it('preview creates nothing; confirm creates one share at publicUrl with a QR', async () => {
    const { dir, call } = await setup();
    const p = await call('share_create', args);
    expect(p.json.scope).toBe('labs');
    expect(listShares(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    const r = await call('share_create', { ...args, confirm: p.json.confirm });
    expect(r.json.link).toMatch(/^https:\/\/x\.example\/s\/.+/);
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    const all = listShares(dir);
    expect(all).toHaveLength(1);
    expect(all[0].baseUrl).toBe('https://x.example');
  });
  it('doctor preview shows the 7 day default expiry', async () => {
    const { call } = await setup();
    const p = await call('share_create', { audience: 'doctor', label: 'Dr' });
    expect(p.json.expires).toBe('7d');
  });
  it('refuses changed arguments and reused codes', async () => {
    const { dir, call } = await setup();
    const p = await call('share_create', args);
    const bad = await call('share_create', { ...args, label: 'Dad', confirm: p.json.confirm });
    expect(bad.isError).toBe(true);
    expect(bad.msg).toContain('arguments changed since the preview');
    expect(listShares(dir)).toEqual([]);
    const p2 = await call('share_create', args);
    expect((await call('share_create', { ...args, confirm: p2.json.confirm })).isError).toBeUndefined();
    expect((await call('share_create', { ...args, confirm: p2.json.confirm })).isError).toBe(true);
    expect(listShares(dir)).toHaveLength(1);
  });
  it('revoke shows in list; log works', async () => {
    const { call } = await setup();
    const p = await call('share_create', args);
    await call('share_create', { ...args, confirm: p.json.confirm });
    const [row] = (await call('share_list')).json;
    expect(row.status).toBe('active');
    expect(row.accesses).toBe(0);
    await call('share_revoke', { id: row.id });
    expect((await call('share_list')).json[0].status).toBe('revoked');
    expect((await call('share_log', { id: row.id })).json).toEqual([]);
    expect((await call('share_revoke', { id: 'nope' })).isError).toBe(true);
  });
});
