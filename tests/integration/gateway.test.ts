// Full chat-app flow against the running Medplum: DCR, PKCE authorize, passkey (injected) and consent, token, MCP tools, refresh, disconnect.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as oidc from 'openid-client';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { createProvider, disconnectClient } from '../../src/gateway/oauth.ts';
import { REMOTE_TAG, remoteTools } from '../../src/gateway/remote-log.ts';
import { createGateway } from '../../src/gateway/server.ts';
import { writeJson } from '../../src/gateway/store.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const PUBLIC = 'https://ga-test.example.ts.net';
const RESOURCE = `${PUBLIC}/mcp`;
const REDIRECT = 'http://localhost:9/cb';
let client: MedplumClient;
let pid: string;
let dir: string;
let server: Server;
let base: string;
const start = new Date().toISOString();

beforeAll(async () => {
  const cfg = loadConfig();
  client = await getClient(cfg);
  pid = await createTestPatient(client);
  dir = mkdtempSync(join(tmpdir(), 'ga-gw-int-'));
  writeJson(dir, 'passkeys.json', [{ id: 'AAAA', publicKey: 'AAAA', counter: 0 }]); // so the sign-in page offers a passkey
  server = createGateway({
    publicUrl: PUBLIC,
    dir,
    tools: remoteTools(client, cfg, pid),
    share: { dir: join(dir, 'share'), load: async () => { throw new Error('unused'); }, log: async () => {}, fetchBinary: async () => { throw new Error('unused'); } },
    completeLogin: async () => ({}),
    verifyPasskey: async () => true,
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((ok) => server?.close(ok));
  for (const a of await client.searchResources('AuditEvent', { _tag: `${REMOTE_TAG}|Claude Code`, date: `ge${start}`, _count: '100' }, { cache: 'no-cache' })) {
    if (a.entity?.[0]?.what?.display === 'fhir_search') await client.deleteResource('AuditEvent', a.id!);
  }
  if (pid) await cleanupTestPatient(client, pid);
  rmSync(dir, { recursive: true, force: true });
});

// A browser: follows redirects on the local server (the public host is not reachable here), keeping cookies.
const jar = new Map<string, string>();
async function go(url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url, PUBLIC);
  const r = await fetch(`${base}${u.pathname}${u.search}`, { ...init, redirect: 'manual', headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  for (const c of r.headers.getSetCookie()) {
    const kv = c.split(';')[0];
    const k = kv.slice(0, kv.indexOf('='));
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(k);
    else jar.set(k, kv.slice(k.length + 1));
  }
  return r;
}

// Follows redirects until a page (200) or the app's redirect URI.
async function follow(r: Response): Promise<{ page?: { path: string; html: string }; code?: URLSearchParams }> {
  let path = '';
  for (let i = 0; i < 10; i++) {
    const loc = r.headers.get('location');
    if (!loc) return { page: { path, html: await r.text() } };
    if (loc.startsWith(REDIRECT)) return { code: new URL(loc).searchParams };
    path = new URL(loc, PUBLIC).pathname;
    r = await go(loc);
  }
  throw new Error('too many redirects');
}

async function authorize(clientId: string, verifier: string) {
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: 'ga offline_access', resource: RESOURCE, state: 's',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  });
  return follow(await go(`/auth?${q}`));
}

const token = (body: Record<string, string>) =>
  fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function mcp(accessToken: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return c;
}
// Only the throwaway patient, so a failure never prints real records.
const searchSelf = async (c: Client) => {
  const r = await c.callTool({ name: 'fhir_search', arguments: { resourceType: 'Patient', params: { _id: pid } } });
  return JSON.parse((r.content as { text: string }[])[0].text) as { entry?: { resource: { id: string } }[] };
};

test('chat app connects, uses tools, refreshes, and is cut off when disconnected', async () => {
  const reg = await fetch(`${base}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'test' }) });
  expect(reg.status).toBe(201);
  const clientId = (await reg.json()).client_id as string;

  const verifier = oidc.randomPKCECodeVerifier();
  const login = await authorize(clientId, verifier);
  expect(login.page?.html).toContain('Sign in with passkey');
  const signed = await go(`${login.page!.path}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"AAAA"}' });
  expect(signed.status).toBe(200);
  expect(jar.has('ga_owner')).toBe(true);
  const consent = await follow(await go((await signed.json()).redirect));
  expect(consent.page?.html).toContain('Claude Code wants to use your GA record');
  const done = await follow(await go(`${consent.page!.path}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=allow' }));
  expect(done.code?.get('iss')).toBe(PUBLIC);

  const t = await token({ grant_type: 'authorization_code', code: done.code!.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  expect(t.status).toBe(200);
  expect(t.body.refresh_token).toBeTruthy();

  const c1 = await mcp(t.body.access_token);
  const names = (await c1.listTools()).tools.map((x) => x.name);
  expect(names).toEqual(expect.arrayContaining(['fhir_search', 'fhir_read', 'vaccine_gaps']));
  expect((await searchSelf(c1)).entry?.map((e) => e.resource.id)).toEqual([pid]);
  await c1.close();

  const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: clientId });
  expect(r.status).toBe(200);
  const c2 = await mcp(r.body.access_token);
  expect((await searchSelf(c2)).entry).toHaveLength(1);
  await c2.close();

  // Signed in already: the owner cookie skips the passkey, never the consent.
  for (const k of [...jar.keys()]) if (k !== 'ga_owner') jar.delete(k);
  const again = await authorize(clientId, oidc.randomPKCECodeVerifier());
  expect(again.page?.html).toContain('Claude Code wants to use your GA record');

  await disconnectClient(createProvider({ publicUrl: PUBLIC, dir }), dir, clientId);
  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${r.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(after.status).toBe(401);

  const logged = await client.searchResources('AuditEvent', { _tag: `${REMOTE_TAG}|Claude Code`, date: `ge${start}`, _count: '100' }, { cache: 'no-cache' });
  expect(logged.filter((a) => a.entity?.[0]?.what?.display === 'fhir_search')).toHaveLength(2);
  expect(logged.every((a) => !a.entity?.[0]?.detail)).toBe(true);
});
