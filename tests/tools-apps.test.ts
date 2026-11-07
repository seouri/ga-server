import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MedplumClient } from '@medplum/core';
import { createProvider, disconnectClient } from '../src/gateway/oauth.ts';
import { registerAppTools } from '../src/tools/apps.ts';

const PUBLIC = 'https://ga.example.ts.net';

test('lists apps by name with last use, disconnects one and its refresh token stops working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-apps-'));
  const provider = createProvider({ publicUrl: PUBLIC, dir });
  // Two clients with a refresh token each, written the way the provider would (Task 8 tests drive the full flow).
  const mk = async (redirect: string, id: string) => {
    await provider.Client.adapter.upsert(id, { client_id: id, redirect_uris: [redirect], client_id_issued_at: 1_700_000_000 }, 1e9);
    const grant = new provider.Grant({ accountId: 'owner', clientId: id });
    const grantId = await grant.save();
    await provider.RefreshToken.adapter.upsert(`rt-${id}`, { jti: `rt-${id}`, grantId, clientId: id }, 3600);
  };
  await mk('https://grok.com/connectors/oauth/callback', 'c-grok');
  await mk('https://claude.ai/api/mcp/auth_callback', 'c-claude');

  const searched: unknown[] = [];
  const client = { searchResources: async (_t: string, q: { _tag: string }) => (searched.push(q._tag), q._tag.endsWith('|Grok') ? [{ recorded: '2026-11-01T00:00:00Z' }] : []) } as unknown as MedplumClient;
  const server = new McpServer({ name: 't', version: '0' });
  registerAppTools(server, { client, cfg: {} as never, patientId: 'p', remote: { publicUrl: PUBLIC, clientName: 'Grok', dir, log: async () => {}, disconnect: (id) => disconnectClient(provider, dir, id) } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const call = async (name: string, args = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError, text: r.content[0].text };
  };

  const list = JSON.parse((await call('connected_apps')).text).apps;
  expect(list).toHaveLength(2);
  expect(list).toContainEqual({ name: 'Grok', clientId: 'c-grok', connected: '2023-11-14T22:13:20.000Z', lastUse: '2026-11-01T00:00:00Z' });
  expect(list.find((x: { name: string }) => x.name === 'claude.ai').lastUse).toBeNull();

  expect((await call('disconnect_app', { clientId: 'nope' })).isError).toBe(true);
  const r = await call('disconnect_app', { clientId: 'c-grok' });
  expect(r.text).toContain('making this call');
  expect(JSON.parse((await call('connected_apps')).text).apps.map((x: { clientId: string }) => x.clientId)).toEqual(['c-claude']);
  expect(await provider.RefreshToken.find('rt-c-grok')).toBeUndefined();
  expect(await provider.RefreshToken.find('rt-c-claude')).toBeDefined();
});
