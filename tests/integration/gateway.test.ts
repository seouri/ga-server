// Full chat-app flow against the running Medplum: DCR, PKCE authorize, passkey (injected) and consent, token, MCP tools, refresh, disconnect;
// consent Deny; an upload link through to ga_import by fileId.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
let passkeyOk = false;
const seen: string[] = [];

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
    verifyPasskey: async (_r, challenge) => { seen.push(challenge); return passkeyOk; },
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((ok) => server?.close(ok));
  for (const a of await client.searchResources('AuditEvent', { _tag: `${REMOTE_TAG}|Claude Code`, date: `ge${start}`, _count: '100' }, { cache: 'no-cache' })) {
    if (a.entity?.[0]?.what?.display === 'fhir_search') await client.deleteResource('AuditEvent', a.id!);
  }
  for (const d of pid ? await client.searchResources('DocumentReference', { subject: `Patient/${pid}` }, { cache: 'no-cache' }) : []) {
    const bin = d.content?.[0]?.attachment?.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
    if (bin) await client.deleteResource('Binary', bin);
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
  let login = await authorize(clientId, verifier);
  expect(login.page?.html).toContain('Sign in with passkey');
  const signIn = () => go(`${login.page!.path}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"AAAA"}' });
  // No passkey, no consent and no code: a failed passkey, consent posted at the login prompt.
  expect((await signIn()).status).toBe(400);
  expect(jar.has('ga_owner')).toBe(false);
  const early = await go(`${login.page!.path}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=allow' });
  expect(early.status).toBe(400);
  // The verifier gets the challenge shown on the page, once.
  passkeyOk = true;
  login = { page: { path: login.page!.path, html: await (await go(login.page!.path)).text() } };
  const shown = /"challenge":"([^"]+)"/.exec(login.page!.html)?.[1];
  const signed = await signIn();
  expect(signed.status).toBe(200);
  expect(seen.at(-1)).toBe(shown);
  expect(jar.has('ga_owner')).toBe(true);
  expect((await signIn()).status).toBe(400);
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

test('consent Deny returns access_denied; an upload link stores a file once, for the owner only, and ga_import uses it', async () => {
  jar.clear();
  passkeyOk = true;
  const reg = await fetch(`${base}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'test2' }) });
  const clientId = (await reg.json()).client_id as string;
  const login = await authorize(clientId, oidc.randomPKCECodeVerifier());
  await go(login.page!.path);
  const signed = await go(`${login.page!.path}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"AAAA"}' });
  const consent = await follow(await go((await signed.json()).redirect));
  const denied = await follow(await go(`${consent.page!.path}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=deny' }));
  expect(denied.code?.get('error')).toBe('access_denied');
  expect(denied.code?.get('code')).toBeNull();

  const verifier = oidc.randomPKCECodeVerifier();
  const again = await authorize(clientId, verifier);
  const done = await follow(await go(`${again.page!.path}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=allow' }));
  const t = await token({ grant_type: 'authorization_code', code: done.code!.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  const c = await mcp(t.body.access_token);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError, text: r.content[0].text };
  };

  const link = JSON.parse((await call('upload_link', { purpose: 'lab PDF' })).text) as { url: string; fileId: string };
  const path = new URL(link.url).pathname;
  // A unique synthetic PDF, so "imported once" starts fresh each run.
  const pdf = Buffer.concat([readFileSync(join(import.meta.dirname, '..', 'fixtures', 'labs-synthetic.pdf')), Buffer.from(`\n%${randomUUID()}\n`)]);
  const post = () => go(`${path}?name=labs.pdf`, { method: 'POST', body: pdf });
  // A new browser: no owner cookie, so the passkey page, and a POST stores nothing.
  jar.clear();
  expect(await (await go(path)).text()).toContain('Sign in with passkey');
  expect((await post()).status).toBe(403);
  expect(existsSync(join(dir, 'uploads'))).toBe(false);
  const up = await go(`${path}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"AAAA"}' });
  expect(await up.json()).toEqual({ redirect: path });
  const stored = await post();
  expect(stored.status).toBe(200);
  expect((await stored.json()).fileId).toBe(link.fileId);
  expect((await post()).status).toBe(404);
  expect(readdirSync(join(dir, 'uploads'))).toEqual([link.fileId]);

  const obs = { resourceType: 'Observation', status: 'final', code: { text: 'Synthetic upload check' }, valueQuantity: { value: 1, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' }, effectiveDateTime: '2024-03-01' };
  expect((await call('ga_import', { resources: [obs] })).text).toContain('call upload_link first');
  const r = await call('ga_import', { resources: [obs], fileId: link.fileId, documentDate: '2024-03-02' });
  expect(r.isError).toBeUndefined();
  expect(JSON.parse(r.text).created).toBe(1);
  expect((await call('ga_import', { resources: [obs], fileId: link.fileId })).text).toContain('already imported');
  expect((await call('import_file', { fileId: link.fileId })).text).toContain('call ga_import with this fileId');
  await c.close();
});
