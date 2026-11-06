// ga-gateway: the one public service behind Tailscale Funnel. OAuth (oidc-provider), owner sign-in and consent, passkey enrollment,
// MCP over HTTP at /mcp (bearer token), the hospital login return at /callback and the share pages at /s/...
// Without a public URL it serves only /s/... and /callback.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { GaError, getClient, loadConfig } from '../config.ts';
import type { ToolDeps } from '../mcp.ts';
import { completeLogin } from '../smart/actions.ts';
import { smartDir } from '../smart/store.ts';
import { renderInactive } from '../share/page.ts';
import { HEADERS, type ShareDeps, TooLarge, clientIp, failLimiter, readBody, send, shareHandler } from '../share/server.ts';
import { shareDeps } from '../share/cli.ts';
import { appName, createProvider } from './oauth.ts';
import * as pages from './pages.ts';
import { authenticationOptions, enrollTokenValid, isOwner, ownerCookie, registrationOptions, verifyAuthentication, verifyRegistration } from './passkey.ts';
import { remoteTools } from './remote-log.ts';
import { gatewayDir, readJson } from './store.ts';

type Remote = Omit<NonNullable<ToolDeps['remote']>, 'log'>;
export type GatewayDeps = {
  publicUrl?: string;
  dir: string;
  tools: (remote: Remote) => McpServer;
  share: ShareDeps;
  completeLogin: (search: string) => Promise<unknown>;
  verifyPasskey?: (response: AuthenticationResponseJSON, expectedChallenge: string) => Promise<boolean>;
};

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
const PORT = 8110;
const CHALLENGE_MS = 5 * 60_000;
const MAX_CHALLENGES = 1000;
const json = (res: Res, status: number, v: unknown, extra: Record<string, string> = {}): void => send(res, status, JSON.stringify(v), 'application/json', extra);
// The share CSP plus one nonce'd script that may call back to this origin.
const scriptCsp = (nonce: string): Record<string, string> => ({ 'Content-Security-Policy': `${HEADERS['Content-Security-Policy']}; script-src 'nonce-${nonce}'; connect-src 'self'` });

export function createGateway(deps: GatewayDeps): http.Server {
  const share = shareHandler(deps.share);
  const pub = deps.publicUrl;
  const provider = pub ? createProvider({ publicUrl: pub, dir: deps.dir }) : undefined;
  const oidc = provider?.callback();
  const resource = `${pub}/mcp`;
  const meta = { resource, authorization_servers: [pub], scopes_supported: ['ga'], bearer_methods_supported: ['header'] };
  const unauthorized = { 'WWW-Authenticate': `Bearer resource_metadata="${pub}/.well-known/oauth-protected-resource/mcp"` };
  const verifyPasskey = deps.verifyPasskey ?? ((r, c) => verifyAuthentication(deps.dir, pub!, r, c));
  const fails = failLimiter();
  const registrations = failLimiter();
  const authorizations = failLimiter();

  // WebAuthn challenges, server side only: one per interaction or enroll token, single use, short-lived.
  const challenges = new Map<string, { challenge: string; exp: number }>();
  const putChallenge = (key: string, challenge: string): void => {
    if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
    challenges.set(key, { challenge, exp: Date.now() + CHALLENGE_MS });
  };
  const takeChallenge = (key: string): string | undefined => {
    const c = challenges.get(key);
    challenges.delete(key);
    return c && c.exp > Date.now() ? c.challenge : undefined;
  };
  // A failed passkey or bearer attempt: 429 once the IP is over the limit, else the given reply.
  const failed = (res: Res, ip: string, reply: () => void): void =>
    fails.fail(ip, Date.now()) ? send(res, 429, 'Too many requests', 'text/plain; charset=utf-8') : reply();
  const body = async (req: Req): Promise<string | undefined> => {
    try {
      return await readBody(req);
    } catch (e) {
      if (e instanceof TooLarge) return undefined;
      throw e;
    }
  };
  const parse = (s: string | undefined): any => {
    try {
      return JSON.parse(s ?? '');
    } catch {
      return undefined;
    }
  };

  async function callback(req: Req, res: Res, search: string): Promise<void> {
    try {
      await deps.completeLogin(search);
    } catch (e) {
      const gone = e instanceof GaError && (e.message === 'unknown_state' || e.message === 'login_expired');
      return gone ? send(res, 404, pages.callbackInvalid()) : send(res, 400, pages.callbackFailed());
    }
    send(res, 200, pages.callbackDone());
  }

  // The token must exist, be unexpired (find() does not check exp), carry scope ga for GA's /mcp, and belong to a client that still exists.
  async function bearer(req: Req): Promise<{ redirectUris: string[] } | undefined> {
    const m = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(req.headers.authorization ?? '');
    const at = m && (await provider.AccessToken.find(m[1]));
    if (!at || at.isExpired || at.aud !== resource || !at.scopes.has('ga')) return undefined;
    return provider.Client.find(at.clientId);
  }

  async function mcp(req: Req, res: Res, ip: string): Promise<void> {
    const client = await bearer(req);
    if (!client) {
      const reply = () => json(res, 401, { error: 'invalid_token' }, unauthorized);
      // No Authorization header is a client discovering GA, not a failed attempt.
      return req.headers.authorization ? failed(res, ip, reply) : reply();
    }
    // Stateless: no session, so no GET stream and nothing to DELETE.
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const server = deps.tools({ publicUrl: pub!, clientName: appName(client.redirectUris[0]) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function interaction(req: Req, res: Res, ip: string, uid: string, action: string): Promise<void> {
    let details;
    try {
      // Checks the interaction cookie (SameSite=Lax), which binds the browser and stops cross-site posts.
      details = await provider.interactionDetails(req, res);
    } catch {
      return send(res, 400, pages.interactionExpired());
    }
    if (details.uid !== uid) return send(res, 400, pages.interactionExpired());
    const prompt = details.prompt.name as string;

    if (action === '' && req.method === 'GET') {
      if (prompt === 'consent') {
        // The code goes to this redirect, so it names the app (a client may register redirects of several apps).
        const origin = new URL(details.params.redirect_uri).origin;
        // Chrome applies form-action to the redirects after the post, which end at the app.
        const csp = { 'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace("form-action 'self'", `form-action 'self' ${origin}`) };
        return send(res, 200, pages.consentPage(appName(details.params.redirect_uri), uid), undefined, csp);
      }
      if (prompt !== 'login') return send(res, 400, pages.interactionExpired());
      // A signed-in owner skips the passkey, never the consent.
      if (isOwner(deps.dir, req.headers.cookie)) return provider.interactionFinished(req, res, { login: { accountId: 'owner' } }, { mergeWithLastSubmission: false });
      if (!readJson<unknown[]>(deps.dir, 'passkeys.json', []).length) return send(res, 200, pages.noPasskey());
      const options = await authenticationOptions(deps.dir, pub!);
      putChallenge(`login:${uid}`, options.challenge);
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, pages.loginPage(nonce, options), undefined, scriptCsp(nonce));
    }

    if (action === '/login' && req.method === 'POST' && prompt === 'login') {
      const challenge = takeChallenge(`login:${uid}`);
      const response = parse(await body(req));
      if (!challenge || !response || !(await verifyPasskey(response, challenge))) return failed(res, ip, () => json(res, 400, { done: 'Sign-in failed. Reload the page to try again.' }));
      const redirect = await provider.interactionResult(req, res, { login: { accountId: 'owner' } }, { mergeWithLastSubmission: false });
      return json(res, 200, { redirect }, { 'Set-Cookie': ownerCookie(deps.dir) });
    }

    if (action === '/consent' && req.method === 'POST' && prompt === 'consent' && details.session?.accountId === 'owner') {
      const decision = new URLSearchParams((await body(req)) ?? '').get('decision');
      if (decision !== 'allow') {
        return provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'The owner did not allow access' }, { mergeWithLastSubmission: false });
      }
      const grant = (details.grantId && (await provider.Grant.find(details.grantId))) || new provider.Grant({ accountId: 'owner', clientId: details.params.client_id });
      // ga is both an OIDC scope and the /mcp resource scope.
      grant.addOIDCScope(['ga offline_access', ...(details.prompt.details.missingOIDCScope ?? [])].join(' '));
      grant.addResourceScope(resource, 'ga offline_access');
      return provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
    }
    return send(res, 400, pages.interactionExpired());
  }

  // Showing the page never uses the token (link-preview bots); saving a passkey does, bound to the challenge shown with it.
  async function enroll(req: Req, res: Res, ip: string, token: string): Promise<void> {
    if (req.method === 'GET') {
      if (!enrollTokenValid(deps.dir, token)) return send(res, 404, pages.enrollInvalid());
      const options = await registrationOptions(deps.dir, pub!);
      putChallenge(`enroll:${token}`, options.challenge);
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, pages.enrollPage(nonce, options), undefined, scriptCsp(nonce));
    }
    const challenge = takeChallenge(`enroll:${token}`);
    const response = parse(req.method === 'POST' ? await body(req) : undefined) as RegistrationResponseJSON | undefined;
    if (!challenge || !response || !(await verifyRegistration(deps.dir, pub!, token, response, challenge))) {
      return failed(res, ip, () => json(res, 400, { done: 'The passkey was not saved. Reload the page to try again.' }));
    }
    json(res, 200, { done: 'Passkey saved. You can close this window.' }, { 'Set-Cookie': ownerCookie(deps.dir) });
  }

  async function handle(req: Req, res: Res): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return send(res, 404, renderInactive());
    }
    const path = url.pathname;
    if (path.startsWith('/s/')) return share(req, res);
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    if (path === '/callback' || path === '/callback/') return req.method === 'GET' ? callback(req, res, url.search) : send(res, 404, renderInactive());
    if (!provider) return send(res, 404, renderInactive());

    // Never trust forwarded headers from outside: issuer, redirects and Secure cookies always use the public URL.
    const p = new URL(pub!);
    req.headers.host = p.host;
    req.headers['x-forwarded-proto'] = p.protocol.slice(0, -1);
    delete req.headers['x-forwarded-host'];
    const ip = clientIp(req);

    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, meta);
    if (path === '/mcp') return mcp(req, res, ip);
    const i = /^\/interaction\/([A-Za-z0-9_-]+)(\/login|\/consent)?$/.exec(path);
    if (i) return interaction(req, res, ip, i[1], i[2] ?? '');
    const e = /^\/enroll\/([A-Za-z0-9_-]+)$/.exec(path);
    if (e) return enroll(req, res, ip, e[1]);
    // Each registration or authorization request writes a file: 20 of each per IP per 10 minutes.
    const writes = path === '/reg' && req.method === 'POST' ? registrations : path === '/auth' ? authorizations : undefined;
    if (writes?.fail(ip, Date.now())) return send(res, 429, 'Too many requests', 'text/plain; charset=utf-8');
    return oidc(req, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Something went wrong', 'text/plain; charset=utf-8');
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  return server;
}

// ga gateway serve. Loopback unless GA_SHARE_HOST says otherwise (the container sets 0.0.0.0, published on 127.0.0.1 only).
export async function serveGateway(): Promise<void> {
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const publicUrl = process.env.GA_PUBLIC_URL?.replace(/\/+$/, '') || undefined;
  const server = createGateway({
    publicUrl,
    dir: gatewayDir(),
    tools: remoteTools(client, cfg, cfg.patientId),
    share: shareDeps(client),
    completeLogin: (search) => completeLogin(client, smartDir(), cfg.patientId, search),
  });
  const host = process.env.GA_SHARE_HOST || '127.0.0.1';
  await new Promise<void>((ok) => server.listen(PORT, host, ok));
  const model = process.env.GA_LLM_MODEL;
  console.log(`ga-gateway listening on ${host}:${PORT}${model ? ` (share questions: ${model})` : ' (share questions off: no GA_LLM_MODEL)'}`);
  console.log(publicUrl ? `remote access on: ${publicUrl}/mcp` : 'remote access off: set GA_PUBLIC_URL');
}
