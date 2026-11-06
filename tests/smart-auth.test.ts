import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, exportJWK } from 'jose';
import { accessToken, connect, finishLogin, resultName, startLogin, SCOPE, sourceKey, waitForLogin } from '../src/smart/auth.ts';
import type { Tokens } from '../src/smart/auth.ts';
import { ensureKeys, loadSecret, readSources, saveSecret } from '../src/smart/store.ts';
import { startMock } from './smart/mock-server.ts';
import type { MockOpts, MockSmart } from './smart/mock-server.ts';

const clientId = 'synthetic-client';
let dir: string;
let mock: MockSmart | undefined;

// Plays the browser: follow the auto-approving authorize redirect into the callback listener.
const browser = async (url: string): Promise<void> => {
  await fetch(url);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ga-smart-auth-'));
});
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function setup(o: Partial<MockOpts> = {}) {
  const { publicJwks } = await ensureKeys(dir);
  mock = await startMock({ clientId, jwks: publicJwks, ...o });
  const src = await connect(dir, mock.fhirBase, clientId, browser, { name: 'Test Hospital', port: 0 });
  return { m: mock, src };
}

const expire = (key: string): void => {
  const t = loadSecret<Tokens>(dir, key)!;
  saveSecret(dir, key, { ...t, expires_at: Date.now() - 1000 });
};

describe('sourceKey', () => {
  it('is the lower-cased host with dots as dashes', () => {
    expect(sourceKey('https://FHIR.Example.org/api/FHIR/R4')).toBe('fhir-example-org');
  });
});

describe('connect', () => {
  it('stores encrypted tokens and upserts sources.json', async () => {
    const { m, src } = await setup();
    expect(src).toMatchObject({ key: '127-0-0-1', name: 'Test Hospital', fhirBase: m.fhirBase, patient: 'synthetic-patient-1' });
    const f = join(dir, 'tokens', `${src.key}.enc`);
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readSources(dir)).toEqual([src]);
    const t = loadSecret<Tokens>(dir, src.key)!;
    expect(t.refresh_token).toBe(m.currentRefresh());
    expect(t.patient).toBe('synthetic-patient-1');
    expect(t.expires_at).toBeGreaterThan(Date.now());
    // reconnect keeps one record
    await connect(dir, m.fhirBase, clientId, browser, { port: 0 });
    expect(readSources(dir)).toHaveLength(1);
  });

  it('signs the client assertion with the registered RS384 key (mock verifies)', async () => {
    const { m } = await setup();
    expect(m.stats.assertions).toBe(1);
    expect(m.stats.rejected).toEqual([]);
  });

  // GA never requests openid/fhirUser, so no id_token is issued or validated (a malformed one would break every refresh).
  it('requests read-only scopes without openid, so an id_token-capable server issues none', async () => {
    const { m, src } = await setup({ idToken: 'unadvertised' });
    expect(src.patient).toBe('synthetic-patient-1');
    expect(m.stats.scopes).toEqual([SCOPE]);
    expect(SCOPE).toMatch(/^offline_access launch\/patient patient\/AllergyIntolerance\.read .*patient\/Observation\.read/);
    expect(SCOPE).not.toMatch(/openid|fhirUser|\*|write/);
  });

  it('is refused when the registered key differs', async () => {
    await ensureKeys(dir);
    const other = await generateKeyPair('RS384');
    const jwk = { ...(await exportJWK(other.publicKey)), kid: 'other', alg: 'RS384' };
    mock = await startMock({ clientId, jwks: { keys: [jwk] } });
    await expect(connect(dir, mock.fhirBase, clientId, browser, { port: 0 })).rejects.toThrow(/invalid_client/);
    expect(mock.stats.rejected[0]).toMatch(/^assertion/);
  });

  it('rejects a callback whose state does not match', async () => {
    const { publicJwks } = await ensureKeys(dir);
    mock = await startMock({ clientId, jwks: publicJwks });
    const tamper = async (url: string): Promise<void> => {
      const r = await fetch(url, { redirect: 'manual' });
      const cb = new URL(r.headers.get('location')!);
      cb.searchParams.set('state', 'forged');
      await fetch(cb);
    };
    await expect(connect(dir, mock.fhirBase, clientId, tamper, { port: 0 })).rejects.toThrow(/state/);
    expect(mock.stats.assertions).toBe(0);
    expect(readSources(dir)).toEqual([]);
  });

  // Production Epic needs an https redirect: a Funnel address that proxies to the local listener, here with "/callback" stripped.
  it('uses a registered https redirect URI and accepts the proxied callback', async () => {
    const redirectUri = 'https://ga.example.ts.net/callback';
    const { publicJwks } = await ensureKeys(dir);
    mock = await startMock({ clientId, jwks: publicJwks, redirectUri });
    const port = 18765;
    const viaFunnel = async (url: string): Promise<void> => {
      const r = await fetch(url, { redirect: 'manual' });
      const cb = new URL(r.headers.get('location')!);
      expect(cb.origin + cb.pathname).toBe(redirectUri);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404); // a stray hit without state does not end the login
      await fetch(`http://127.0.0.1:${port}/${cb.search}`);
    };
    const src = await connect(dir, mock.fhirBase, clientId, viaFunnel, { port, redirectUri });
    expect(src.patient).toBe('synthetic-patient-1');
    expect(loadSecret<Tokens>(dir, src.key)!.refresh_token).toBeTruthy();
  });
});

describe('accessToken', () => {
  it('returns the stored token while it is fresh', async () => {
    const { m, src } = await setup();
    expect(await accessToken(dir, src, clientId)).toBe(loadSecret<Tokens>(dir, src.key)!.access_token);
    expect(m.stats.refreshes).toBe(0);
  });

  it('refreshes after expiry and persists the rotated refresh token', async () => {
    const { m, src } = await setup();
    const before = loadSecret<Tokens>(dir, src.key)!;
    expire(src.key);
    const at = await accessToken(dir, src, clientId);
    const after = loadSecret<Tokens>(dir, src.key)!;
    expect(at).not.toBe(before.access_token);
    expect(after.access_token).toBe(at);
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(after.refresh_token).toBe(m.currentRefresh());
    expect(after.patient).toBe('synthetic-patient-1'); // refresh response had no patient
    expect(existsSync(join(dir, `${src.key}.lock`))).toBe(false);
    expire(src.key);
    await accessToken(dir, src, clientId);
    expect(m.stats.refreshes).toBe(2);
    expect(m.stats.reuse).toBe(0);
  });

  it('fetches the SMART configuration outside the refresh lock', async () => {
    const { m, src } = await setup();
    const lockHeld: boolean[] = [];
    m.onRequest = (u) => {
      if (u.pathname.endsWith('/smart-configuration')) lockHeld.push(existsSync(join(dir, `${src.key}.lock`)));
    };
    expire(src.key);
    await accessToken(dir, src, clientId);
    expect(lockHeld).toEqual([false]);
    expect(m.stats.refreshes).toBe(1);
  });

  it('keeps the stored refresh token when the response omits one', async () => {
    const { m, src } = await setup({ rotate: false });
    const rt = loadSecret<Tokens>(dir, src.key)!.refresh_token;
    expire(src.key);
    await accessToken(dir, src, clientId);
    expect(loadSecret<Tokens>(dir, src.key)!.refresh_token).toBe(rt);
    expect(m.stats.refreshes).toBe(1);
  });

  it('two concurrent calls refresh once and both get a valid token', async () => {
    const { m, src } = await setup();
    expire(src.key);
    const [a, b] = await Promise.all([accessToken(dir, src, clientId), accessToken(dir, src, clientId)]);
    expect(a).toBe(b);
    expect(m.stats.refreshes).toBe(1);
    expect(m.stats.reuse).toBe(0);
    expect(m.authorized({ headers: { authorization: `Bearer ${a}` } } as never)).toBe(true);
  });

  it('throws invalid_grant after the server revokes tokens', async () => {
    const { m, src } = await setup();
    m.revokeAll();
    expire(src.key);
    const err = await accessToken(dir, src, clientId).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid_grant/);
    expect((err as Error).message).not.toMatch(/rt-|at-/);
  });

  it('throws no_refresh_token once the access token expires and none was issued', async () => {
    const { src } = await setup({ noRefresh: true });
    expect(loadSecret<Tokens>(dir, src.key)!.refresh_token).toBeUndefined();
    expire(src.key);
    await expect(accessToken(dir, src, clientId)).rejects.toThrow(/no_refresh_token/);
  });

  it('breaks a stale lock', async () => {
    const { src } = await setup();
    const { writeFileSync, utimesSync } = await import('node:fs');
    const lock = join(dir, `${src.key}.lock`);
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(lock, old, old);
    expire(src.key);
    await expect(accessToken(dir, src, clientId)).resolves.toMatch(/^at-/);
  });
});

describe('startLogin / finishLogin', () => {
  const redirectUri = 'https://ga.example.ts.net/callback';
  async function start() {
    const { publicJwks } = await ensureKeys(dir);
    mock = await startMock({ clientId, jwks: publicJwks, redirectUri });
    const { url, state } = await startLogin(dir, mock.fhirBase, clientId, redirectUri, 'Test Hospital');
    const cb = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    return { state, search: cb.search };
  }
  const tokenFiles = (): string[] => (existsSync(join(dir, 'tokens')) ? readdirSync(join(dir, 'tokens')).filter((f) => f.startsWith('127')) : []);

  it('finishes a login started elsewhere and stores tokens', async () => {
    const { search } = await start();
    const src = await finishLogin(dir, search);
    expect(src).toMatchObject({ key: '127-0-0-1', name: 'Test Hospital', patient: 'synthetic-patient-1' });
    expect(loadSecret<Tokens>(dir, src.key)!.refresh_token).toBeTruthy();
    expect(readSources(dir)).toEqual([src]);
  });

  it('is single use and rejects a forged state', async () => {
    const { search } = await start();
    await finishLogin(dir, search);
    await expect(finishLogin(dir, search)).rejects.toThrow('unknown_state');
    await expect(finishLogin(dir, '?code=x&state=forged')).rejects.toThrow('unknown_state');
  });

  it('rejects an expired login and stores no tokens', async () => {
    const { search } = await start();
    await expect(finishLogin(dir, search, new Date(Date.now() + 11 * 60_000))).rejects.toThrow('login_expired');
    expect(tokenFiles()).toEqual([]);
    await expect(finishLogin(dir, search)).rejects.toThrow('unknown_state');
  });

  it('waitForLogin returns the result written by the gateway, or times out naming the gateway', async () => {
    const src = { key: 'k', name: 'n', fhirBase: 'https://x', patient: 'p' };
    saveSecret(dir, resultName('s1'), { source: src });
    expect(await waitForLogin(dir, 's1', 1000)).toEqual(src);
    saveSecret(dir, resultName('s2'), { error: 'boom' });
    await expect(waitForLogin(dir, 's2', 1000)).rejects.toThrow('boom');
    await expect(waitForLogin(dir, 's3', 10)).rejects.toThrow('docker compose up -d ga-gateway');
  });
});
