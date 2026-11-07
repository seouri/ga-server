// ga-gateway: the one public service behind Tailscale Funnel. OAuth (oidc-provider), owner sign-in and consent, passkey enrollment,
// MCP over HTTP at /mcp (bearer token), one-time upload pages at /upload/<token>, owner confirmation of chat-app previews at /confirm/<code>, the hospital login return at /callback and the share pages at /s/...
// Without a public URL it serves only /s/... and /callback.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import http from 'node:http';
import { calendarFor, toIcs } from '../calendar.ts';
import { healthMaintenance } from '../maintenance.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { GaError, getClient, loadConfig } from '../config.ts';
import { findConfirmPage, takeConfirmPage } from '../confirm.ts';
import type { ToolDeps } from '../mcp.ts';
import { completeLogin } from '../smart/actions.ts';
import { patientEndpoints } from '../smart/sync.ts';
import { smartDir } from '../smart/store.ts';
import { renderInactive } from '../share/page.ts';
import { HEADERS, type ShareDeps, TooLarge, clientIp, failLimiter, readBody, send, shareHandler } from '../share/server.ts';
import { shareDeps } from '../share/cli.ts';
import { appName, createProvider, disconnectClient, sweepClients } from './oauth.ts';
import * as pages from './pages.ts';
import { authenticationOptions, enrollTokenValid, isOwner, ownerCookie, registrationOptions, verifyAuthentication, verifyRegistration } from './passkey.ts';
import { ack, pending } from '../notify/outbox.ts';
import { notifyDir, readSettings, readState, writeState } from '../notify/settings.ts';
import { tick } from '../notify/tick.ts';
import { logRemote, remoteTools } from './remote-log.ts';
import { gatewayDir, readJson } from './store.ts';
import { sweepExpired } from './adapter.ts';
import { MAX_UPLOAD, UploadTooLarge, acceptUpload, cleanUploads, uploadLinkValid } from './uploads.ts';

type Remote = Omit<NonNullable<ToolDeps['remote']>, 'log'>;
export type GatewayDeps = {
  publicUrl?: string;
  dir: string;
  tools: (remote: Remote) => McpServer;
  share: ShareDeps;
  completeLogin: (search: string) => Promise<unknown>;
  calendar?: (id: string, userAgent?: string) => Promise<string>; // the iCalendar body for a valid calendar link; id: the install's UID part
  // iMessage bridge exchange; absent means POST /notify/exchange is 404. client: logs each acked send (kind only, never text).
  notify?: { dir: string; client?: MedplumClient; onIncoming?: (m: { from: string; text: string; at: string }) => Promise<void> };
  verifyPasskey?: (response: AuthenticationResponseJSON, expectedChallenge: string) => Promise<boolean>;
};

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
const PORT = 8110;
const CHALLENGE_MS = 5 * 60_000;
const BODY_MS = 30_000;
const NOTIFY_BODY = 64 * 1024;
const UPLOAD_IDLE_MS = 60_000;
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
  const authorizations = failLimiter(undefined, 300);

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

  // Incoming messages are handled one at a time, off the HTTP request; a failure lands in state.lastError.
  let incomingChain: Promise<void> = Promise.resolve();
  async function notifyExchange(req: Req, res: Res): Promise<void> {
    const n = deps.notify!;
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'POST' });
    let token = '';
    try { token = readFileSync(join(n.dir, 'token'), 'utf8').trim(); } catch {}
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const h = (x: string) => createHash('sha256').update(x).digest();
    if (!token || !timingSafeEqual(h(token), h(given))) return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8');
    let raw = '', size = 0;
    try {
      raw = await new Promise<string>((ok, fail) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => { size += c.length; if (size > NOTIFY_BODY) { req.removeAllListeners('data'); fail(new TooLarge()); } else chunks.push(c); });
        req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
        req.on('error', fail);
      });
    } catch (e) {
      if (!(e instanceof TooLarge)) throw e;
      res.on('finish', () => req.destroy());
      return json(res, 413, { error: 'too large' }, { Connection: 'close' });
    }
    const b = parse(raw);
    const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    if (!b || typeof b !== 'object') return json(res, 400, { error: 'bad request' });
    const sent = strs(b.sent);
    const failures = (Array.isArray(b.failed) ? b.failed : []).filter((f: any) => typeof f?.id === 'string').map((f: any) => ({ id: f.id, error: String(f.error ?? '').slice(0, 200) }));
    const acked = pending(n.dir).filter((o) => sent.includes(o.id));
    ack(n.dir, sent, failures, new Date());
    for (const o of acked) if (n.client) logRemote(n.client, `sent ${o.kind}`, 'iMessage').catch(() => {});
    for (const m of Array.isArray(b.incoming) ? b.incoming : []) {
      if (typeof m?.from !== 'string' || typeof m?.text !== 'string') continue;
      incomingChain = incomingChain.then(() => n.onIncoming?.({ from: m.from, text: m.text, at: String(m.at ?? '') })).catch((e) => {
        writeState(n.dir, { ...readState(n.dir), lastError: String(e?.message ?? e).slice(0, 200) });
      });
    }
    return json(res, 200, { outgoing: pending(n.dir).map(({ id, text }) => ({ id, text })) });
  }

  async function callback(res: Res, search: string): Promise<void> {
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
    const server = deps.tools({ publicUrl: pub!, clientName: appName(client.redirectUris[0]), dir: deps.dir, disconnect: (id) => disconnectClient(provider, deps.dir, id) });
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
        const redirect = new URL(details.params.redirect_uri);
        // Chrome applies form-action to the redirects after the post, which end at the app.
        const csp = { 'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace("form-action 'self'", `form-action 'self' ${redirect.origin}`) };
        const issued = (await provider.Client.adapter.find(details.params.client_id))?.client_id_issued_at ?? 0;
        return send(res, 200, pages.consentPage(appName(details.params.redirect_uri), uid, redirect.host, Date.now() - issued * 1000), undefined, csp);
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

  // The passkey page for a signed-out visitor of an owner-only link (key: the link's challenge slot), and its POST.
  async function signInPage(res: Res, key: string): Promise<void> {
    if (!readJson<unknown[]>(deps.dir, 'passkeys.json', []).length) return send(res, 200, pages.noPasskey());
    const options = await authenticationOptions(deps.dir, pub!);
    putChallenge(key, options.challenge);
    const nonce = randomBytes(16).toString('base64');
    return send(res, 200, pages.loginPage(nonce, options), undefined, scriptCsp(nonce));
  }
  async function signIn(req: Req, res: Res, ip: string, key: string, redirect: string): Promise<void> {
    const challenge = takeChallenge(key);
    const response = parse(await body(req));
    if (!challenge || !response || !(await verifyPasskey(response, challenge))) return failed(res, ip, () => json(res, 400, { done: 'Sign-in failed. Reload the page to try again.' }));
    return json(res, 200, { redirect }, { 'Set-Cookie': ownerCookie(deps.dir) });
  }

  // A chat app's preview: the owner reviews it and confirms here; GET never uses the code (link previews), only the owner's POST does.
  async function confirm(req: Req, res: Res, ip: string, code: string, action: string): Promise<void> {
    const page = findConfirmPage(code);
    if (!page) return failed(res, ip, () => send(res, 404, pages.confirmInvalid()));
    const path = `/confirm/${code}`;
    const owner = isOwner(deps.dir, req.headers.cookie);
    if (action === '' && req.method === 'GET') return owner ? send(res, 200, pages.confirmPage(page.title, page.view, path)) : signInPage(res, `confirm:${code}`);
    if (action === '/login' && req.method === 'POST') return signIn(req, res, ip, `confirm:${code}`, path);
    if (action === '' && req.method === 'POST') {
      if (!owner) return signInPage(res, `confirm:${code}`);
      const p = takeConfirmPage(code);
      if (!p) return send(res, 404, pages.confirmInvalid());
      try {
        return send(res, 200, pages.confirmDone(await p.run()));
      } catch (e) {
        if (e instanceof GaError) return send(res, 400, pages.confirmFailed(e.message));
        throw e;
      }
    }
    return send(res, 404, renderInactive());
  }

  // The link is checked without being used (link previews); only the owner's POST uses it, then streams the file.
  async function upload(req: Req, res: Res, ip: string, token: string, action: string, name: string): Promise<void> {
    if (!uploadLinkValid(deps.dir, token)) return failed(res, ip, () => send(res, 404, pages.uploadInvalid()));
    const owner = isOwner(deps.dir, req.headers.cookie);
    if (action === '' && req.method === 'GET') {
      const nonce = randomBytes(16).toString('base64');
      return owner ? send(res, 200, pages.uploadPage(nonce), undefined, scriptCsp(nonce)) : signInPage(res, `upload:${token}`);
    }
    if (action === '/login' && req.method === 'POST') return signIn(req, res, ip, `upload:${token}`, `/upload/${token}`);
    if (action === '' && req.method === 'POST') {
      if (!owner) return json(res, 403, { done: 'Sign in first: reload the page.' });
      const big = () => json(res, 413, { done: 'The file is over the 2 GB limit.' }, { Connection: 'close' });
      if (Number(req.headers['content-length']) > MAX_UPLOAD) return big();
      // A large upload outlasts the body deadline: an idle timeout instead.
      clearTimeout(deadlines.get(req));
      req.socket.setTimeout(UPLOAD_IDLE_MS, () => req.socket.destroy());
      try {
        const { fileId } = await acceptUpload(deps.dir, token, name, req);
        return json(res, 200, { done: `Uploaded (file id ${fileId}). Return to your chat.`, fileId });
      } catch (e) {
        if (e instanceof UploadTooLarge) return big();
        if (e instanceof GaError) return send(res, 404, pages.uploadInvalid());
        throw e;
      }
    }
    return send(res, 404, renderInactive());
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
    if (path === '/notify/exchange' && deps.notify) return notifyExchange(req, res);
    if (path === '/callback' || path === '/callback/') return req.method === 'GET' ? callback(res, url.search) : send(res, 404, renderInactive());
    if (!provider) return send(res, 404, renderInactive());

    // Never trust forwarded headers from outside: issuer, redirects and Secure cookies always use the public URL.
    const p = new URL(pub!);
    req.headers.host = p.host;
    req.headers['x-forwarded-proto'] = p.protocol.slice(0, -1);
    delete req.headers['x-forwarded-host'];
    const ip = clientIp(req);

    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, meta);
    if (path === '/mcp') return mcp(req, res, ip);
    const c = /^\/cal\/([A-Za-z0-9_-]{43})\.ics$/.exec(path);
    const calId = c && (req.method === 'GET' || req.method === 'HEAD') && deps.calendar ? calendarFor(deps.dir, c[1]) : undefined;
    if (c) return calId ? send(res, 200, req.method === 'HEAD' ? '' : await deps.calendar!(calId, req.headers['user-agent']), 'text/calendar; charset=utf-8') : send(res, 404, renderInactive());
    const i = /^\/interaction\/([A-Za-z0-9_-]+)(\/login|\/consent)?$/.exec(path);
    if (i) return interaction(req, res, ip, i[1], i[2] ?? '');
    const e = /^\/enroll\/([A-Za-z0-9_-]+)$/.exec(path);
    if (e) return enroll(req, res, ip, e[1]);
    const u = /^\/upload\/([A-Za-z0-9_-]+)(\/login)?$/.exec(path);
    if (u) return upload(req, res, ip, u[1], u[2] ?? '', url.searchParams.get('name') ?? 'upload');
    const k = /^\/confirm\/([A-Za-z0-9_-]{43})(\/login)?$/.exec(path);
    if (k) return confirm(req, res, ip, k[1], k[2] ?? '');
    // Each registration writes a client file: 20 per IP per 10 minutes. Each /auth writes a sign-in file: 300 per IP per 10 minutes,
    // far above an owner's own sign-ins even if every request reaches us from one IP (Funnel without X-Forwarded-For).
    const writes = path === '/reg' && req.method === 'POST' ? registrations : path === '/auth' ? authorizations : undefined;
    if (writes?.fail(ip, Date.now())) return send(res, 429, 'Too many requests', 'text/plain; charset=utf-8');
    return oidc(req, res);
  }

  // requestTimeout would cut off a large upload, so each request gets its own body deadline; upload() swaps it for an idle timeout.
  const deadlines = new WeakMap<Req, NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    const t = setTimeout(() => req.complete || req.socket.destroy(), BODY_MS).unref();
    deadlines.set(req, t);
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Something went wrong', 'text/plain; charset=utf-8');
      else res.destroy();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 20_000;
  return server;
}

// ga gateway serve. Loopback unless GA_SHARE_HOST says otherwise (the container sets 0.0.0.0, published on 127.0.0.1 only).
export async function serveGateway(): Promise<void> {
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const publicUrl = process.env.GA_PUBLIC_URL?.replace(/\/+$/, '') || undefined;
  const nd = notifyDir();
  const notifyOn = !!readSettings(nd) && !readSettings(nd)!.off;
  const server = createGateway({
    publicUrl,
    notify: notifyOn ? { dir: nd, client } : undefined,
    dir: gatewayDir(),
    tools: remoteTools(client, cfg, cfg.patientId),
    share: shareDeps(client),
    completeLogin: (search) => completeLogin(client, smartDir(), cfg.patientId, search),
    calendar: async (id, ua) => {
      // Logged like a chat-app tool call: who fetched (the calendar app's user agent) and when; a failed log never fails the feed.
      logRemote(client, `calendar feed: ${(ua ?? 'unknown app').slice(0, 80)}`, 'Calendar feed').catch(() => {});
      const m = await healthMaintenance(client, cfg.patientId);
      return toIcs(m.items, m.asOf, id);
    },
  });
  const sweep = () => {
    try {
      cleanUploads(gatewayDir());
    } catch {} // must not skip sweepExpired or crash the interval
    sweepExpired(gatewayDir());
    sweepClients(gatewayDir());
  };
  sweep();
  setInterval(sweep, 3600_000).unref();
  if (notifyOn) {
    let running = false; // a tick never starts while another runs
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await tick({ client, patientId: cfg.patientId, dir: nd, now: new Date(), eps: () => patientEndpoints(client, cfg.patientId) });
      } catch (e) {
        writeState(nd, { ...readState(nd), lastError: String((e as Error).message ?? e).slice(0, 200) });
      } finally { running = false; }
    };
    setInterval(() => void run().catch(() => {}), 60_000).unref();
  }
  const host = process.env.GA_SHARE_HOST || '127.0.0.1';
  await new Promise<void>((ok) => server.listen(PORT, host, ok));
  const model = process.env.GA_LLM_MODEL;
  console.log(`ga-gateway listening on ${host}:${PORT}${model ? ` (share questions: ${model})` : ' (share questions off: no GA_LLM_MODEL)'}`);
  console.log(publicUrl ? `remote access on: ${publicUrl}/mcp` : 'remote access off: set GA_PUBLIC_URL');
}
