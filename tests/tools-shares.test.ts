import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MedplumClient } from '@medplum/core';
import { takeConfirmPage } from '../src/confirm.ts';
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
// The person pressing Confirm on the gateway page.
const confirmOnPage = (p: { json: { confirmUrl: string } }) => takeConfirmPage(p.json.confirmUrl.split('/').pop()!)!.run();

describe('share tools', () => {
  it('preview shows the exact expiry and confirming creates the same one', async () => {
    const { dir, call } = await setup();
    const p = await call('share_create', { ...args, expires: '1d' });
    expect(Math.abs(Date.parse(p.json.expires) - Date.now() - 864e5)).toBeLessThan(5000);
    expect((await call('share_create', args)).json.expires).toBe('never');
    await confirmOnPage(p);
    expect(listShares(dir)[0].expires).toBe(p.json.expires);
  });
  it('preview creates nothing; the page confirm creates one share at publicUrl with a QR', async () => {
    const { dir, call } = await setup();
    const p = await call('share_create', args);
    expect(p.json.scope).toBe('labs');
    expect(p.json.confirmUrl).toMatch(/^https:\/\/x\.example\/confirm\/[A-Za-z0-9_-]{43}$/);
    expect(p.json.confirm).toBeUndefined();
    expect(listShares(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    const r = await confirmOnPage(p);
    expect(r.link).toMatch(/^https:\/\/x\.example\/s\/.+/);
    expect(r.qr).toMatch(/^data:image\/png;base64,/);
    const all = listShares(dir);
    expect(all).toHaveLength(1);
    expect(all[0].baseUrl).toBe('https://x.example');
  });
  it('doctor preview shows the 7 day default expiry', async () => {
    const { call } = await setup();
    const p = await call('share_create', { audience: 'doctor', label: 'Dr' });
    expect(Date.parse(p.json.expires) - Date.now()).toBeGreaterThan(7 * 864e5 - 5000);
    expect(Date.parse(p.json.expires) - Date.now()).toBeLessThanOrEqual(7 * 864e5);
  });
  it('the agent cannot confirm: the code from the link creates nothing in a tool call', async () => {
    const { dir, call } = await setup();
    const p = await call('share_create', args);
    const code = p.json.confirmUrl.split('/').pop();
    const again = await call('share_create', { ...args, confirm: code });
    expect(again.json?.link).toBeUndefined();
    expect(listShares(dir)).toEqual([]);
  });
  it('revoke shows in list; log works', async () => {
    const { call } = await setup();
    await confirmOnPage(await call('share_create', args));
    const [row] = (await call('share_list')).json;
    expect(row.status).toBe('active');
    expect(row.accesses).toBe(0);
    await call('share_revoke', { id: row.id });
    expect((await call('share_list')).json[0].status).toBe('revoked');
    expect((await call('share_log', { id: row.id })).json).toEqual([]);
    expect((await call('share_revoke', { id: 'nope' })).isError).toBe(true);
  });
});

describe('preview scope defaults', () => {
  it('shows what will be created: doctor groups, or all for family', async () => {
    const { call } = await setup();
    expect((await call('share_create', { audience: 'doctor', label: 'D' })).json.scope).toBe('labs, medications, problems, allergies, immunizations, vitals');
    expect((await call('share_create', { audience: 'family', label: 'F' })).json.scope).toBe('all records');
  });
});
