import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Provider, { errors } from 'oidc-provider';
import { FileAdapter } from './adapter.ts';
import { readJson, writeJson } from './store.ts';
import { writeAtomic } from '../smart/store.ts';

type App = { name: string; redirects: string[] };
const APPS = (JSON.parse(readFileSync(new URL('../../config/chat-apps.json', import.meta.url), 'utf8')) as { apps: App[] }).apps;
const DAY = 24 * 3600;
const REFRESH_TTL = 90 * DAY;

function matches(pattern: string, uri: string): boolean {
  if (!pattern.endsWith('*')) return uri === pattern;
  const u = URL.parse(uri);
  if (!u || u.username || u.password) return false;
  // "http://localhost:*": any port and path on that host.
  if (pattern.endsWith(':*')) {
    const p = new URL(pattern.slice(0, -2));
    return u.protocol === p.protocol && u.hostname === p.hostname;
  }
  const p = new URL(pattern.slice(0, -1));
  return u.origin === p.origin && u.pathname.startsWith(p.pathname);
}

const appFor = (uri: string): App | undefined => APPS.find((a) => a.redirects.some((p) => matches(p, uri)));
export const allowedRedirect = (uri: string): boolean => appFor(uri) !== undefined;
export const appName = (redirectUri: string): string => appFor(redirectUri)?.name ?? 'unknown app';

function cookieKey(dir: string): string {
  const f = join(dir, 'oidc-cookies.key');
  if (!existsSync(f)) writeAtomic(f, randomBytes(32).toString('base64url'), 0o600);
  return readFileSync(f, 'utf8');
}

function jwks(dir: string): { keys: object[] } {
  const saved = readJson<{ keys: object[] } | null>(dir, 'jwks.json', null);
  if (saved) return saved;
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const set = { keys: [{ ...jwk, kid: randomBytes(8).toString('hex'), alg: 'RS256', use: 'sig' }] };
  writeJson(dir, 'jwks.json', set);
  return set;
}

// Registration is open (DCR) but only for known chat apps, and only as public PKCE clients.
function validateClient(_ctx: unknown, key: string, value: unknown, metadata: Record<string, unknown>): void {
  if (key === 'redirect_uris' && !(Array.isArray(value) && value.every((v) => typeof v === 'string' && allowedRedirect(v)))) {
    throw new errors.InvalidClientMetadata('redirect_uris must belong to a known chat app');
  }
  if (key === 'token_endpoint_auth_method') {
    metadata.token_endpoint_auth_method = 'none';
    delete metadata.client_secret;
    delete metadata.client_secret_expires_at;
  }
  if (key === 'grant_types') metadata.grant_types = ['authorization_code', 'refresh_token'];
}

export function createProvider(opts: { publicUrl: string; dir: string }) {
  const resource = `${opts.publicUrl}/mcp`;
  const provider = new Provider(opts.publicUrl, {
    adapter: (model: string) => new FileAdapter(model, opts.dir),
    cookies: { keys: [cookieKey(opts.dir)] },
    jwks: jwks(opts.dir),
    findAccount: (_ctx: unknown, id: string) => (id === 'owner' ? { accountId: 'owner', claims: () => ({ sub: 'owner' }) } : undefined),
    scopes: ['ga', 'offline_access'],
    responseTypes: ['code'],
    pkce: { required: () => true },
    extraClientMetadata: { properties: ['redirect_uris', 'token_endpoint_auth_method', 'grant_types'], validator: validateClient },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      // Off: post_logout_redirect_uris would make /session/end an open redirect on GA's domain.
      rpInitiatedLogout: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_ctx: unknown, _client: unknown, oneOf?: string) => oneOf ?? resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx: unknown, indicator: string) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return { scope: 'ga', audience: resource, accessTokenTTL: 3600, accessTokenFormat: 'opaque' };
        },
      },
    },
    interactions: { url: (_ctx: unknown, interaction: { uid: string }) => `/interaction/${interaction.uid}` },
    issueRefreshToken: (_ctx: unknown, client: { grantTypeAllowed(g: string): boolean }) => client.grantTypeAllowed('refresh_token'),
    expiresWithSession: () => false,
    // Each refresh restarts the 90-day idle clock on the grant. Gemini breaks on rotation, so it keeps its token, extended.
    rotateRefreshToken: async (ctx: any) => {
      const { RefreshToken: rt, Client: client, Grant: grant } = ctx.oidc.entities;
      const exp = Math.floor(Date.now() / 1000) + REFRESH_TTL;
      grant.exp = exp;
      await grant.save();
      if (!client.redirectUris.some((u: string) => appName(u) === 'Gemini app')) return true;
      rt.exp = exp;
      await rt.save();
      return false;
    },
    ttl: {
      AccessToken: 3600,
      IdToken: 3600,
      RefreshToken: REFRESH_TTL,
      Grant: REFRESH_TTL,
      Interaction: 3600,
      Session: 12 * 3600,
    },
  });
  // Behind Funnel: the gateway pins Host and X-Forwarded-Proto before a request reaches the provider.
  provider.proxy = true;
  return provider;
}

export type GaProvider = ReturnType<typeof createProvider>;

const granted = (dir: string): Set<unknown> => new Set(new FileAdapter('Grant', dir).scan(['Grant']).map(([, g]) => g.clientId));

// Connected = the owner allowed it (a Grant): registration alone is open. Name comes from the redirect URI, not the self-asserted client_name.
export function listClients(dir: string): { clientId: string; name: string; created: string }[] {
  const ok = granted(dir);
  return new FileAdapter('Client', dir).scan(['Client']).filter(([, c]) => ok.has(c.client_id)).map(([, c]) => ({
    clientId: c.client_id as string,
    name: appName((c.redirect_uris as string[])[0]),
    created: new Date((c.client_id_issued_at as number) * 1000).toISOString(),
  }));
}

// Registrations never allowed (no Grant) a day after registering; a younger one may still be mid-consent. Never throws (runs on an interval).
export function sweepClients(dir: string, now = Date.now()): void {
  try {
    const ok = granted(dir);
    for (const [f, c] of new FileAdapter('Client', dir).scan(['Client'])) {
      if (!ok.has(c.client_id) && (c.client_id_issued_at as number) * 1000 < now - DAY * 1000) rmSync(f, { force: true });
    }
  } catch {}
}

export async function disconnectClient(provider: GaProvider, dir: string, clientId: string): Promise<void> {
  for (const [, g] of new FileAdapter('Grant', dir).scan(['Grant'])) {
    if (g.clientId !== clientId) continue;
    await provider.RefreshToken.adapter.revokeByGrantId(g.jti);
    await provider.Grant.adapter.destroy(g.jti);
  }
  await provider.Client.adapter.destroy(clientId);
}
