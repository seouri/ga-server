import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileAdapter, sweepExpired } from '../src/gateway/adapter.ts';
import { allowedRedirect, appName, createProvider, disconnectClient, listClients, sweepClients } from '../src/gateway/oauth.ts';

const PUBLIC = 'https://ga.example.ts.net';
const RESOURCE = `${PUBLIC}/mcp`;
const tmp = () => mkdtempSync(join(tmpdir(), 'oauth-'));
const apps = JSON.parse(readFileSync(new URL('../config/chat-apps.json', import.meta.url), 'utf8')) as { apps: { name: string; redirects: string[] }[] };

describe('allowedRedirect', () => {
  it('accepts every configured entry and concrete wildcard matches', () => {
    for (const r of apps.apps.flatMap((a) => a.redirects)) expect(allowedRedirect(r.replace(/:\*$/, ':1/x').replace(/\*$/, 'x')), r).toBe(true);
    expect(allowedRedirect('http://localhost:53682/callback')).toBe(true);
    expect(allowedRedirect('http://127.0.0.1:9/cb')).toBe(true);
    expect(allowedRedirect('https://chatgpt.com/connector/oauth/abc')).toBe(true);
    expect(allowedRedirect('https://oauth-redirect.googleusercontent.com/r/x')).toBe(true);
    expect(allowedRedirect('https://oauth-redirect-test.googleusercontent.com/a/user_bound_x')).toBe(true); // Gemini also registers /a/ on each host
  });
  it('rejects lookalikes, downgrades and strays', () => {
    for (const r of [
      'https://claude.ai.evil.example/api/mcp/auth_callback',
      'https://evil.example/cb',
      'http://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com.evil.example/connector/oauth/abc',
      'https://chatgpt.com:8443/connector/oauth/abc',
      'https://chatgpt.com/connector/oauth/../../evil',
      'https://user@chatgpt.com/connector/oauth/abc',
      'https://localhost:53682/callback',
      'http://localhost.evil.example:53682/callback',
      'https://claude.ai/api/mcp/auth_callback/x',
      'not a url',
    ]) expect(allowedRedirect(r), r).toBe(false);
  });
  it('names the app', () => {
    expect(appName('https://claude.com/api/mcp/auth_callback')).toBe('claude.ai');
    expect(appName('http://127.0.0.1:5000/callback')).toBe('Claude Code');
    expect(appName('https://oauth-redirect-sandbox.googleusercontent.com/r/abc')).toBe('Gemini app');
  });
});

describe('FileAdapter', () => {
  it('sweepExpired removes expired records and keeps live ones', async () => {
    const d = tmp();
    let t = 1_000_000;
    const a = new FileAdapter('AccessToken', d, () => t);
    await a.upsert('old', { x: 1 }, 10);
    await a.upsert('new', { x: 2 }, 1000);
    await a.upsert('forever', { x: 3 });
    sweepExpired(d, t + 20_000);
    expect(readdirSync(join(d, 'oidc', 'AccessToken'))).toHaveLength(2);
    expect(await a.find('new')).toEqual({ x: 2 });
  });
  it('sweepExpired ignores stray files and still removes expired records', async () => {
    const d = tmp();
    const a = new FileAdapter('AccessToken', d, () => 1_000_000);
    await a.upsert('old', { x: 1 }, 10);
    writeFileSync(join(d, 'oidc', '.DS_Store'), 'x');
    writeFileSync(join(d, 'oidc', 'AccessToken', '.DS_Store'), 'x');
    expect(() => sweepExpired(d, 1_000_000 + 20_000)).not.toThrow();
    expect(readdirSync(join(d, 'oidc', 'AccessToken'))).toEqual(['.DS_Store']);
  });
  it('round-trips, expires, consumes and revokes by grant', async () => {
    const d = tmp();
    let t = 1_000_000;
    const at = new FileAdapter('AccessToken', d, () => t);
    await at.upsert('a1', { jti: 'a1', grantId: 'g1' }, 60);
    expect(await at.find('a1')).toEqual({ jti: 'a1', grantId: 'g1' });
    const file = join(d, 'oidc', 'AccessToken', `${createHash('sha256').update('a1').digest('hex')}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    t += 61_000;
    expect(await at.find('a1')).toBeUndefined();

    const rt = new FileAdapter('RefreshToken', d, () => t);
    await rt.upsert('r1', { jti: 'r1', grantId: 'g1' }, 60);
    await rt.consume('r1');
    expect((await rt.find('r1'))?.consumed).toEqual(expect.any(Number));
    await expect(rt.consume('missing')).resolves.toBeUndefined();

    await at.upsert('a2', { jti: 'a2', grantId: 'g1' }, 60);
    await at.upsert('a3', { jti: 'a3', grantId: 'g2' }, 60);
    await at.revokeByGrantId('g1');
    expect(await at.find('a2')).toBeUndefined();
    expect(await rt.find('r1')).toBeUndefined();
    expect(await at.find('a3')).toBeDefined();

    const s = new FileAdapter('Session', d, () => t);
    await s.upsert('s1', { uid: 'u1' }, 60);
    expect(await s.findByUid('u1')).toEqual({ uid: 'u1' });
    await s.destroy('s1');
    expect(await s.find('s1')).toBeUndefined();
  });
});

describe('provider', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let provider: ReturnType<typeof createProvider>;

  beforeAll(async () => {
    dir = tmp();
    provider = createProvider({ publicUrl: PUBLIC, dir });
    // Task 9 owns the real login/consent; this stand-in approves at once.
    server = createServer(async (req, res) => {
      if (req.url?.startsWith('/interaction/')) {
        const { params, prompt } = await provider.interactionDetails(req, res);
        const grant = new provider.Grant({ accountId: 'owner', clientId: params.client_id });
        grant.addResourceScope(RESOURCE, 'ga');
        grant.addOIDCScope(params.scope);
        const grantId = await grant.save();
        const result = prompt.name === 'login' ? { login: { accountId: 'owner' } } : { consent: { grantId } };
        return provider.interactionFinished(req, res, result, { mergeWithLastSubmission: true });
      }
      return provider.callback()(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const register = (redirect: string, extra = {}) =>
    fetch(`${base}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'x', ...extra }) });

  // Follows the authorization redirects on the local server (the issuer host is public), carrying cookies.
  async function authorize(clientId: string, redirect: string) {
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: 'ga', resource: RESOURCE, state: 's',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    const jar = new Map<string, string>();
    let url = `${base}/auth?${q}`;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(url, { redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const c of r.headers.getSetCookie()) {
        const [kv] = c.split(';');
        const k = kv.slice(0, kv.indexOf('='));
        jar.set(k, kv.slice(k.length + 1));
      }
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`no redirect: ${r.status} ${await r.text()}`);
      if (loc.startsWith(redirect)) return { params: new URL(loc).searchParams, verifier };
      const u = new URL(loc, base);
      url = `${base}${u.pathname}${u.search}`;
    }
    throw new Error('too many redirects');
  }

  const token = (body: Record<string, string>) =>
    fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  async function connect(redirect: string) {
    const client = await (await register(redirect)).json();
    const { params, verifier } = await authorize(client.client_id, redirect);
    expect(params.get('iss')).toBe(PUBLIC);
    const t = await token({ grant_type: 'authorization_code', code: params.get('code')!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE });
    expect(t.status).toBe(200);
    return { clientId: client.client_id as string, ...(t.body as { access_token: string; refresh_token: string }) };
  }

  it('rejects registration outside the allowlist', async () => {
    for (const uri of ['https://evil.example/cb', 'https://claude.ai.evil.example/api/mcp/auth_callback']) {
      const r = await register(uri);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('invalid_redirect_uri');
    }
    const mixed = await fetch(`${base}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'] }) });
    expect((await mixed.json()).error).toBe('invalid_redirect_uri');
  });

  it('registers chat apps as public clients', async () => {
    for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:53682/callback', 'https://chatgpt.com/connector/oauth/abc']) {
      const r = await register(uri, uri.includes('chatgpt') ? { token_endpoint_auth_method: 'client_secret_post' } : {});
      expect(r.status, uri).toBe(201);
      const c = await r.json();
      expect(c.client_secret).toBeUndefined();
      expect(c.token_endpoint_auth_method).toBe('none');
    }
  });

  it('publishes metadata with S256 and registration', async () => {
    const m = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(m.issuer).toBe(PUBLIC);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.registration_endpoint).toMatch(/\/reg$/);
  });

  it('requires PKCE', async () => {
    const c = await (await register('https://claude.ai/api/mcp/auth_callback')).json();
    const q = new URLSearchParams({ client_id: c.client_id, response_type: 'code', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'ga', resource: RESOURCE });
    const loc = (await fetch(`${base}/auth?${q}`, { redirect: 'manual' })).headers.get('location')!;
    expect(new URL(loc).searchParams.get('error')).toBe('invalid_request');
  });

  it('issues opaque /mcp tokens and rotates refresh tokens', async () => {
    const t = await connect('https://claude.ai/api/mcp/auth_callback');
    const at = await provider.AccessToken.find(t.access_token);
    expect(at.aud).toBe(RESOURCE);
    expect(at.scope).toBe('ga');
    const r = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).not.toBe(t.refresh_token);
    expect((await provider.AccessToken.find(r.body.access_token)).aud).toBe(RESOURCE);
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })).status).toBe(400);
  });

  it('keeps the Gemini refresh token and extends it', async () => {
    const t = await connect('https://oauth-redirect.googleusercontent.com/r/x');
    const rt = await provider.RefreshToken.find(t.refresh_token);
    rt.exp -= 1000;
    await rt.save();
    const r = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).toBe(t.refresh_token);
    expect((await provider.RefreshToken.find(t.refresh_token)).exp).toBeGreaterThan(rt.exp + 900);
  });

  it('lists and disconnects clients', async () => {
    const t = await connect('https://grok.com/connectors/oauth/callback');
    expect(listClients(dir)).toContainEqual({ clientId: t.clientId, name: 'Grok', created: expect.any(String) });
    await disconnectClient(provider, dir, t.clientId);
    expect(listClients(dir).map((c) => c.clientId)).not.toContain(t.clientId);
    expect(await provider.AccessToken.find(t.access_token)).toBeUndefined();
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })).status).toBe(401);
  });

  it('a registration the owner never allowed is not listed, and is swept after a day', async () => {
    const c = await (await register('https://claude.ai/api/mcp/auth_callback')).json();
    const t = await connect('https://grok.com/connectors/oauth/callback');
    const ids = () => listClients(dir).map((x) => x.clientId);
    expect(ids()).toContain(t.clientId);
    expect(ids()).not.toContain(c.client_id);
    const has = async (id: string) => !!(await provider.Client.adapter.find(id));
    sweepClients(dir);
    expect(await has(c.client_id)).toBe(true); // may still be mid-consent
    sweepClients(dir, Date.now() + 25 * 3600_000);
    expect(await has(c.client_id)).toBe(false);
    expect(await has(t.clientId)).toBe(true);
  });

  it('reuses keys across restarts', () => {
    const jwks = readFileSync(join(dir, 'jwks.json'), 'utf8');
    const cookies = readFileSync(join(dir, 'oidc-cookies.key'), 'utf8');
    expect(statSync(join(dir, 'jwks.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'oidc-cookies.key')).mode & 0o777).toBe(0o600);
    createProvider({ publicUrl: PUBLIC, dir });
    expect(readFileSync(join(dir, 'jwks.json'), 'utf8')).toBe(jwks);
    expect(readFileSync(join(dir, 'oidc-cookies.key'), 'utf8')).toBe(cookies);
  });
});
