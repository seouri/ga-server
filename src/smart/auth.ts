// SMART standalone launch: PKCE S256 + state, private_key_jwt (RS384), rotating refresh tokens.
import { closeSync, openSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import * as oidc from 'openid-client';
import { GaError } from '../config.ts';
import { loadSecret, readSources, saveSecret, signingKey, writeSources } from './store.ts';
import type { SourceRec } from './store.ts';

export type Tokens = { access_token: string; refresh_token?: string; expires_at: number; patient: string; scope?: string };

const SCOPE = 'openid fhirUser offline_access launch/patient patient/*.read';

export const sourceKey = (fhirBase: string): string => new URL(fhirBase).hostname.toLowerCase().replaceAll('.', '-');

const isLocal = (u: string): boolean => ['127.0.0.1', 'localhost'].includes(new URL(u).hostname);

// Never put a token or response body in an error: the OAuth error code, else the library's fixed message (no cause).
const oauthError = (e: unknown, what: string): GaError => {
  if (e instanceof GaError) return e;
  const code = (e as { error?: unknown }).error;
  const cause = (e as Error).cause;
  const detail = cause instanceof Error ? `${(e as Error).message}: ${cause.message}` : (e as Error).message;
  return new GaError(`${what} failed: ${typeof code === 'string' ? code : detail}`);
};

export async function discover(dir: string, fhirBase: string, clientId: string): Promise<oidc.Configuration> {
  const base = fhirBase.replace(/\/+$/, '');
  if (!base.startsWith('https://') && !isLocal(base)) throw new GaError('FHIR base must be https');
  const r = await fetch(`${base}/.well-known/smart-configuration`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new GaError(`smart-configuration: HTTP ${r.status}`);
  const smart = (await r.json()) as oidc.ServerMetadata;
  if (typeof smart.token_endpoint !== 'string' || typeof smart.authorization_endpoint !== 'string') throw new GaError('smart-configuration lacks endpoints');
  const meta = { ...smart, issuer: smart.issuer ?? base }; // SMART configuration is not OIDC discovery; openid-client needs an issuer
  const tokenEndpoint = smart.token_endpoint;
  const { key, kid } = await signingKey(dir);
  // SMART/Epic want aud = token endpoint, not the issuer the library defaults to.
  const auth = oidc.PrivateKeyJwt({ key, kid }, { [oidc.modifyAssertion]: (_h, p) => void (p.aud = tokenEndpoint) });
  const config = new oidc.Configuration(meta, clientId, {}, auth);
  // Plain http only for a loopback server (tests); openid-client refuses it everywhere else.
  if (isLocal(base) && isLocal(tokenEndpoint) && isLocal(smart.authorization_endpoint)) oidc.allowInsecureRequests(config);
  return config;
}

const toTokens = (r: oidc.TokenEndpointResponse, prev?: Tokens): Tokens => {
  const patient = typeof r.patient === 'string' ? r.patient : prev?.patient;
  if (!patient) throw new GaError('token response lacks patient');
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token ?? prev?.refresh_token,
    expires_at: Date.now() + (r.expires_in ?? 300) * 1000, // shortcut: 5 min when the server omits expires_in
    patient,
    scope: r.scope ?? prev?.scope,
  };
};

// Waits for one GET /callback on 127.0.0.1 and answers the browser at once (the exchange happens after).
function listen(port: number): Promise<{ port: number; callback: Promise<URL>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let got: (u: URL) => void;
    let fail: (e: Error) => void;
    const callback = new Promise<URL>((res, rej) => {
      got = res;
      fail = rej;
    });
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${(server.address() as AddressInfo).port}`);
      if (req.method !== 'GET' || u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('GA received the authorization. You can close this window.');
      got(u);
    });
    const timer = setTimeout(() => fail(new GaError('authorization timed out')), 10 * 60_000);
    const close = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    };
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, callback, close }));
  });
}

export async function connect(
  dir: string,
  fhirBase: string,
  clientId: string,
  open: (url: string) => void | Promise<void>,
  opts: { name?: string; port?: number } = {},
): Promise<SourceRec> {
  const base = fhirBase.replace(/\/+$/, '');
  const config = await discover(dir, base, clientId);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const cb = await listen(opts.port ?? 8765);
  try {
    const redirectUri = `http://localhost:${cb.port}/callback`;
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      aud: base,
    });
    await open(url.href);
    const current = await cb.callback;
    const r = await oidc
      .authorizationCodeGrant(config, current, { pkceCodeVerifier: verifier, expectedState: state })
      .catch((e: unknown) => {
        throw oauthError(e, 'authorization');
      });
    const key = sourceKey(base);
    saveSecret(dir, key, toTokens(r));
    const sources = readSources(dir);
    const prev = sources.find((s) => s.key === key);
    const rec: SourceRec = { ...prev, key, name: opts.name ?? prev?.name ?? key, fhirBase: base, patient: (r.patient as string) };
    writeSources(dir, [...sources.filter((s) => s.key !== key), rec]);
    return rec;
  } finally {
    cb.close();
  }
}

// Exclusive per-source lock so two processes never spend the same rotating refresh token.
async function withLock<T>(dir: string, key: string, fn: () => Promise<T>): Promise<T> {
  const f = join(dir, `${key}.lock`);
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(f, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(f).mtimeMs > 2 * 60_000) rmSync(f, { force: true }); // stale
      } catch {
        // lock vanished between open and stat: retry
      }
      if (i >= 300) throw new GaError('token refresh locked');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(f, { force: true });
  }
}

const fresh = (t: Tokens): boolean => t.expires_at - Date.now() > 60_000;

export async function accessToken(dir: string, src: SourceRec, clientId: string): Promise<string> {
  const t = loadSecret<Tokens>(dir, src.key);
  if (!t) throw new GaError('not_connected');
  if (fresh(t)) return t.access_token;
  return withLock(dir, src.key, async () => {
    const cur = loadSecret<Tokens>(dir, src.key) ?? t; // another process may have refreshed already
    if (fresh(cur)) return cur.access_token;
    if (!cur.refresh_token) throw new GaError('no_refresh_token');
    const config = await discover(dir, src.fhirBase, clientId);
    const r = await oidc.refreshTokenGrant(config, cur.refresh_token).catch((e: unknown) => {
      throw (e as { error?: unknown }).error === 'invalid_grant' ? new GaError('invalid_grant') : oauthError(e, 'token refresh');
    });
    const next = toTokens(r, cur);
    saveSecret(dir, src.key, next); // persist the rotated refresh token before anyone uses the access token
    return next.access_token;
  });
}
