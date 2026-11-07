import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MedplumClient } from '@medplum/core';
import { takeConfirmPage } from '../src/confirm.ts';
import { registerHospitalTools } from '../src/tools/hospitals.ts';
import { resultName } from '../src/smart/auth.ts';
import { readApp, readSources, saveSecret, writeApp, writeSources } from '../src/smart/store.ts';

const src = { key: 'h-example-org', name: 'Hosp', fhirBase: 'https://h.example.org/fhir', patient: 'p' };
const setup = async (app: object = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-hosp-'));
  writeApp(dir, app);
  writeSources(dir, [src]);
  const calls: string[] = [];
  const fake = {
    startLogin: async () => ({ url: 'https://portal.example/auth?x=1', state: 's' }),
    readStatus: async () => [{ source: src.key, name: 'Hosp', status: 'active', stale: false, enabledTypes: [] }],
    syncAll: async () => [{ source: src.key, status: 'active' as const }],
    syncSource: async (_c: unknown, _d: unknown, s: { key: string }, _p: unknown, o?: { dryRun?: boolean }) => {
      calls.push(o?.dryRun ? 'dry' : 'real');
      return { source: s.key, status: 'active' as const, fetched: { Condition: 4 } };
    },
  };
  const server = new McpServer({ name: 't', version: '0' });
  registerHospitalTools(server, { client: {} as MedplumClient, cfg: {} as never, patientId: 'p', remote: { publicUrl: 'https://x.example', clientName: 'c', log: async () => {} } }, dir, fake as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { isError: r.isError, msg: r.content[0].text!, json: r.isError ? undefined : JSON.parse(r.content[0].text!) };
  };
  return { dir, call, calls };
};

describe('hospital tools', () => {
  it('connect refuses without an https redirect, returns a url with one', async () => {
    const no = await setup({ clientId: 'c', redirectUri: 'http://localhost:8765/callback' });
    const r = await no.call('hospital_connect', { fhirBase: src.fhirBase });
    expect(r.isError).toBe(true);
    expect(r.msg).toContain('ga connect');
    const ok = await setup({ clientId: 'c', redirectUri: 'https://x.example/callback' });
    expect((await ok.call('hospital_connect', { fhirBase: src.fhirBase })).json.url).toMatch(/^https:/);
  });
  it('enable previews without writing; only the page confirm sets types and syncs', async () => {
    const { dir, call, calls } = await setup();
    const p = await call('hospital_enable', { source: src.key, types: ['Condition', 'Procedure'] });
    expect(p.json.fetched).toEqual({ Condition: 4, Procedure: 0 });
    expect(readSources(dir)[0].enabledTypes).toBeUndefined();
    const code = p.json.confirmUrl.split('/').pop();
    await call('hospital_enable', { source: src.key, types: ['Condition', 'Procedure'], confirm: code }); // the agent cannot confirm
    expect(readSources(dir)[0].enabledTypes).toBeUndefined();
    const r = await takeConfirmPage(code)!.run();
    expect(r.done).toContain('Enabled Condition, Procedure');
    expect(readSources(dir)[0].enabledTypes).toEqual(['Condition', 'Procedure']);
    expect(calls).toEqual(['dry', 'dry', 'real']);
  });
  it('enable refuses unknown types with the known list', async () => {
    const { dir, call } = await setup();
    const r = await call('hospital_enable', { source: src.key, types: ['Nope'] });
    expect(r.isError).toBe(true);
    expect(r.msg).toMatch(/unknown type: Nope; known: .*Condition/);
    expect(readSources(dir)[0].enabledTypes).toBeUndefined();
  });
  it('status shows a finished login with its fetched counts, and uses them for the enable preview', async () => {
    const { dir, call, calls } = await setup();
    saveSecret(dir, resultName('st'), { source: src, result: { source: src.key, status: 'pending', fetched: { Condition: 9 } } });
    const s = await call('hospital_status');
    expect(s.json.sources).toHaveLength(1);
    expect(s.json.pendingLogins).toMatchObject([{ fhirBase: src.fhirBase, status: 'finished', fetched: { Condition: 9 } }]);
    expect((await call('hospital_enable', { source: src.key, types: ['Condition'] })).json.fetched).toEqual({ Condition: 9 });
    expect(calls).toEqual([]);
  });
  it('sync one or all', async () => {
    const { call } = await setup();
    expect((await call('hospital_sync', {})).json).toHaveLength(1);
    expect((await call('hospital_sync', { source: 'nope' })).isError).toBe(true);
  });
});
