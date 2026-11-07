import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { GaError } from '../src/config.ts';
import { createGateway } from '../src/gateway/server.ts';
import { createProvider } from '../src/gateway/oauth.ts';
import { enrollLink, ownerCookie } from '../src/gateway/passkey.ts';
import { writeJson } from '../src/gateway/store.ts';
import { newCalendarToken, revokeCalendar } from '../src/calendar.ts';
import { newUpload, uploadPath } from '../src/gateway/uploads.ts';

const PUBLIC = 'https://ga.example.ts.net';
const RESOURCE = `${PUBLIC}/mcp`;
const WWW = `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`;
const META = { resource: RESOURCE, authorization_servers: [PUBLIC], scopes_supported: ['ga'], bearer_methods_supported: ['header'] };

let dir: string;
let server: Server;
let base: string;
let calls: { publicUrl: string; clientName: string }[];
let logins: string[];
let passkeyOk = false;

function start(publicUrl: string | null = PUBLIC): Promise<void> {
  server = createGateway({
    publicUrl: publicUrl ?? undefined,
    dir,
    tools: (remote) => {
      calls.push(remote);
      return new McpServer({ name: 'fake', version: '0' });
    },
    share: { dir: join(dir, 'share'), load: async () => { throw new Error('unused'); }, log: async () => {}, fetchBinary: async () => { throw new Error('unused'); } },
    completeLogin: async (search) => {
      logins.push(search);
      const state = new URLSearchParams(search).get('state');
      if (state === 'nope') throw new GaError('unknown_state');
      if (state === 'old') throw new GaError('login_expired');
      if (state === 'bad') throw new GaError('token exchange failed: secret detail');
      return {};
    },
    verifyPasskey: async () => passkeyOk,
    calendar: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok(); }));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ga-gw-')); calls = []; logins = []; passkeyOk = false; });
afterEach(async () => { await new Promise((ok) => server?.close(ok)); rmSync(dir, { recursive: true, force: true }); });

// A second provider on the same directory mints tokens the gateway will find.
async function mint(o: { aud?: string; redirect?: string } = {}) {
  const p = createProvider({ publicUrl: PUBLIC, dir });
  const clientId = `c-${Math.random().toString(36).slice(2)}`;
  await p.Client.adapter.upsert(clientId, {
    client_id: clientId, client_id_issued_at: 1, redirect_uris: [o.redirect ?? 'https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  const client = await p.Client.find(clientId);
  const at = new p.AccessToken({ client, accountId: 'owner', grantId: 'g1', scope: 'ga' });
  at.setAudience(o.aud ?? RESOURCE);
  return { p, clientId, token: (await at.save()) as string };
}

const initialize = (token?: string, ip = '198.51.100.1') =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': ip,
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  });

async function expect401(r: Response) {
  expect(r.status).toBe(401);
  expect(r.headers.get('www-authenticate')).toBe(WWW);
}

test('a valid token runs the tools for the client app', async () => {
  await start();
  const { token } = await mint();
  const r = await initialize(token);
  expect(r.status).toBe(200);
  await r.text();
  expect(calls).toEqual([{ publicUrl: PUBLIC, clientName: 'claude.ai', dir, disconnect: expect.any(Function) }]);
  expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
});

test('bad bearer tokens get 401 and run nothing', async () => {
  await start();
  await expect401(await initialize());
  await expect401(await initialize('not-a-token'));
  await expect401(await initialize((await mint({ aud: 'https://other/mcp' })).token));

  const gone = await mint();
  await gone.p.Client.adapter.destroy(gone.clientId);
  await expect401(await initialize(gone.token));

  // Expired by its own exp, while the store still holds it.
  const old = await mint();
  const f = join(dir, 'oidc', 'AccessToken', `${createHash('sha256').update(old.token).digest('hex')}.json`);
  const e = JSON.parse(readFileSync(f, 'utf8'));
  e.payload.exp = Math.floor(Date.now() / 1000) - 10;
  writeFileSync(f, JSON.stringify(e));
  await expect401(await initialize(old.token));

  for (const m of ['GET', 'DELETE']) await expect401(await fetch(`${base}/mcp`, { method: m }));
  expect(calls).toEqual([]);
});

test('20 failed bearer attempts per IP, then 429; a valid token is never limited', async () => {
  await start();
  for (let i = 0; i < 20; i++) await expect401(await initialize('bad', '203.0.113.7'));
  expect((await initialize('bad', '203.0.113.7')).status).toBe(429);
  expect((await initialize('bad', '203.0.113.8')).status).toBe(401);
  // No token at all is a discovery probe, not a failed attempt.
  for (let i = 0; i < 25; i++) await expect401(await initialize(undefined, '203.0.113.9'));
  const { token } = await mint();
  const r = await initialize(token, '203.0.113.7');
  expect(r.status).toBe(200);
  await r.text();
});

test('protected resource metadata is exact', async () => {
  await start();
  for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const r = await fetch(base + p);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(META);
  }
});

test('the provider sees the public host whatever the request says', async () => {
  await start();
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } });
  const m = await r.json();
  expect(m.issuer).toBe(PUBLIC);
  expect(m.authorization_endpoint).toBe(`${PUBLIC}/auth`);
  expect(m.registration_endpoint).toBe(`${PUBLIC}/reg`);
});

test('/callback: unknown or expired state 404, other failures generic, success page', async () => {
  await start();
  for (const s of ['nope', 'old']) {
    const r = await fetch(`${base}/callback?state=${s}&code=x`);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('This login link is no longer valid');
  }
  const bad = await fetch(`${base}/callback?state=bad`);
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toContain('secret detail');
  const ok = await fetch(`${base}/callback/?state=good&code=c`);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain('GA received the authorization. You can close this window and return to your chat.');
  expect(logins.at(-1)).toBe('?state=good&code=c');
});

test('share pages, unknown paths and logout', async () => {
  await start();
  const s = await fetch(`${base}/s/badtoken`);
  expect(s.status).toBe(404);
  expect(await s.text()).toContain('This link is no longer active');
  const u = await fetch(`${base}/nope`);
  expect(u.status).toBe(404);
  expect(await u.text()).not.toContain('This link is no longer active');
  expect((await fetch(`${base}/session/end?post_logout_redirect_uri=https://evil.example`)).status).toBe(404);
});

test('interaction and enroll pages refuse strangers', async () => {
  await start();
  expect((await fetch(`${base}/interaction/abc`)).status).toBe(400);
  expect((await fetch(`${base}/interaction/abc/login`, { method: 'POST', body: '{}' })).status).toBe(400);
  expect((await fetch(`${base}/interaction/abc/consent`, { method: 'POST', body: 'decision=allow' })).status).toBe(400);
  const r = await fetch(`${base}/enroll/nope`);
  expect(r.status).toBe(404);
  expect(await r.text()).toContain('ga passkey link');
  expect((await fetch(`${base}/enroll/nope`, { method: 'POST', body: '{}' })).status).toBe(400);
});

test('a valid enroll link shows the registration page and keeps its token', async () => {
  await start();
  const link = enrollLink(dir, PUBLIC);
  const path = new URL(link).pathname;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(base + path);
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await r.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('parseCreationOptionsFromJSON');
  }
  // A forged registration does not burn the link.
  expect((await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"x"}' })).status).toBe(400);
  expect((await fetch(base + path)).status).toBe(200);
});

test('without a public URL only share pages and /callback exist', async () => {
  await start(null);
  expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(404);
  expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
  expect((await fetch(`${base}/s/badtoken`)).status).toBe(404);
  expect((await fetch(`${base}/callback?state=good`)).status).toBe(200);
});

test('authorization and registration requests are limited per IP', async () => {
  await start();
  const h = { 'x-forwarded-for': '203.0.113.20' };
  for (let i = 0; i < 20; i++) expect((await fetch(`${base}/auth`, { headers: h, redirect: 'manual' })).status).not.toBe(429);
  expect((await fetch(`${base}/auth`, { headers: h })).status).toBe(429);
  for (let i = 0; i < 20; i++) expect((await fetch(`${base}/reg`, { method: 'POST', headers: h, body: '{}' })).status).not.toBe(429);
  expect((await fetch(`${base}/reg`, { method: 'POST', headers: h, body: '{}' })).status).toBe(429);
});

test('upload links: passkey first, owner POST stores once, strangers store nothing', async () => {
  await start();
  writeJson(dir, 'passkeys.json', [{ id: 'AAAA', publicKey: 'AAAA', counter: 0 }]);
  const bad = await fetch(`${base}/upload/nope`);
  expect(bad.status).toBe(404);
  expect(await bad.text()).toContain('This upload link is no longer valid');

  const u = newUpload(dir, PUBLIC);
  const path = `/upload/${u.token}`;
  const post = (cookie = '', name = 'lab report.pdf') =>
    fetch(`${base}${path}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie }, body: '%PDF-1.4 synthetic' });
  // Not signed in: the passkey page, and a POST stores nothing and keeps the link.
  const page = await fetch(base + path);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('Sign in with passkey');
  expect((await post()).status).toBe(403);
  expect(existsSync(join(dir, 'uploads'))).toBe(false);

  const login = () => fetch(`${base}${path}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"AAAA"}' });
  expect((await login()).status).toBe(400);
  await fetch(base + path);
  passkeyOk = true;
  const signed = await login();
  expect(signed.status).toBe(200);
  expect(await signed.json()).toEqual({ redirect: path });
  const cookie = signed.headers.getSetCookie()[0].split(';')[0];
  expect((await login()).status).toBe(400); // the challenge was single use

  const picker = await fetch(base + path, { headers: { cookie } });
  const nonce = /script-src 'nonce-([^']+)'/.exec(picker.headers.get('content-security-policy')!)?.[1];
  expect(await picker.text()).toContain(`<script nonce="${nonce}">`);
  const ok = await post(cookie);
  expect(ok.status).toBe(200);
  const { fileId } = await ok.json();
  expect(fileId).toBe(u.fileId);
  expect(readFileSync(uploadPath(dir, fileId), 'utf8')).toBe('%PDF-1.4 synthetic');
  expect(uploadPath(dir, fileId).endsWith('/lab_report.pdf')).toBe(true);
  // Used: refused, nothing more stored.
  expect((await post(cookie)).status).toBe(404);
  expect(readdirSync(join(dir, 'uploads'))).toEqual([fileId]);
});

test('an upload over 2 GB is refused with 413 before the link is used', async () => {
  await start();
  const u = newUpload(dir, PUBLIC);
  const status = await new Promise<number>((ok, fail) => {
    const r = http.request(`${base}/upload/${u.token}`, { method: 'POST', headers: { cookie: ownerCookie(dir).split(';')[0], 'content-length': String(2 * 1024 ** 3 + 1) } }, (res) => {
      res.resume();
      ok(res.statusCode!);
    });
    r.on('error', fail);
    r.write('x');
  });
  expect(status).toBe(413);
  expect(existsSync(join(dir, 'uploads'))).toBe(false);
});

test('calendar link: valid token serves the feed, a wrong or revoked one is 404, and it needs remote access', async () => {
  await start();
  const token = newCalendarToken(dir);
  const ok = await fetch(`${base}/cal/${token}.ics`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toMatch(/^text\/calendar/);
  expect(await ok.text()).toContain('BEGIN:VCALENDAR');
  expect((await fetch(`${base}/cal/${'x'.repeat(43)}.ics`)).status).toBe(404);
  newCalendarToken(dir); // a new link replaces the old one
  expect((await fetch(`${base}/cal/${token}.ics`)).status).toBe(404);
  const t2 = newCalendarToken(dir);
  revokeCalendar(dir);
  expect((await fetch(`${base}/cal/${t2}.ics`)).status).toBe(404);
  server.close();
  await start(null);
  expect((await fetch(`${base}/cal/${newCalendarToken(dir)}.ics`)).status).toBe(404);
});
