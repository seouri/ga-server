// Internet-facing share server (behind Tailscale Funnel). Only /s/<token>/... exists; the token is re-checked against shares.json on every request.
import http from 'node:http';
import type { Attachment, DocumentReference } from '@medplum/fhirtypes';
import type { AccessEvent } from './audit.ts';
import { toPdf } from './export.ts';
import { renderInactive, renderPage, renderQr, scopeWords } from './page.ts';
import { BINARY_URL, type Scoped, inScope } from './scope.ts';
import { findByToken, takeQuestion, type Share } from './store.ts';
import { recordRows, summarize, toBundle } from './summary.ts';

type ServerDeps = {
  dir: string;
  load: (share: Share) => Promise<Scoped>;
  log: (share: Share, e: AccessEvent) => Promise<void>;
  fetchBinary: (ref: string) => Promise<{ data: Buffer; contentType: string }>;
  ask?: (q: string, s: Scoped, share: Share) => Promise<string>;
  now?: () => Date;
};

const HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};
const BODY_LIMIT = 20 * 1024;
const MAX_Q = 2000;
const WINDOW = 10 * 60_000;
const MAX_FAILS = 20;
const MAX_IPS = 10_000;
const TABS = new Set(['summary', 'records', 'ask', 'download']);
const HTML = 'text/html; charset=utf-8';

type Res = http.ServerResponse;
const send = (res: Res, status: number, body: string | Buffer, type = HTML, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(body);
};
const notFound = (res: Res): void => send(res, 404, renderInactive());
export const safeName = (s: string, fallback = 'document'): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 100) || fallback;
const attach = (name: string): Record<string, string> => ({ 'Content-Disposition': `attachment; filename="${safeName(name)}"` });

class TooLarge extends Error {}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    if (Number(req.headers['content-length']) > BODY_LIMIT) return fail(new TooLarge());
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > BODY_LIMIT) { req.removeAllListeners('data'); fail(new TooLarge()); } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

// Waits for the socket to drain, or for the client to go away.
const drained = (res: Res): Promise<void> => new Promise((ok) => {
  const done = (): void => { res.off('drain', done); res.off('close', done); ok(); };
  res.on('drain', done);
  res.on('close', done);
});

async function streamBundle(res: Res, s: Scoped): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/fhir+json', ...attach('records.json') });
  res.write('{"resourceType":"Bundle","type":"collection","entry":[');
  const entries = toBundle(s).entry ?? [];
  for (let i = 0; i < entries.length; i++) {
    if (res.destroyed) return;
    if (!res.write((i ? ',' : '') + JSON.stringify(entries[i]))) await drained(res);
  }
  res.end(']}');
}

async function serveDoc(res: Res, id: string, s: Scoped, share: Share, deps: ServerDeps): Promise<boolean> {
  const d = s.resources.find((r): r is DocumentReference => r.resourceType === 'DocumentReference' && r.id === id && inScope(r, share));
  const atts = (d?.content ?? []).map((c) => c.attachment).filter((a): a is Attachment => !!a);
  const inline = atts.find((a) => a.data);
  if (inline) {
    send(res, 200, Buffer.from(inline.data!, 'base64'), inline.contentType ?? 'application/octet-stream', attach(inline.title ?? `document-${id}`));
    return true;
  }
  for (const a of atts) {
    const bid = a.url && BINARY_URL.exec(a.url)?.[1];
    // Only a Binary that loadScoped fetched as support for an in-scope record.
    if (!bid || !s.support.some((r) => r.resourceType === 'Binary' && r.id === bid)) continue;
    const b = await deps.fetchBinary(`Binary/${bid}`);
    send(res, 200, b.data, b.contentType || a.contentType || 'application/octet-stream', attach(a.title ?? `document-${id}`));
    return true;
  }
  return false;
}

// Failed token lookups per client IP, fixed window from the first failure. fail() records one and says whether the IP is over the limit.
// Bounded: at maxIps the oldest IP is evicted (Map insertion order), O(1) per request.
export function failLimiter(maxIps = MAX_IPS): { fail: (ip: string, t: number) => boolean; size: () => number } {
  const fails = new Map<string, { start: number; n: number }>();
  return {
    fail(ip, t) {
      let f = fails.get(ip);
      if (f && t - f.start >= WINDOW) { fails.delete(ip); f = undefined; }
      if (f) return ++f.n > MAX_FAILS;
      if (fails.size >= maxIps) fails.delete(fails.keys().next().value!);
      fails.set(ip, { start: t, n: 1 });
      return false;
    },
    size: () => fails.size,
  };
}

export function createServer(deps: ServerDeps): http.Server {
  const now = deps.now ?? (() => new Date());
  const limiter = failLimiter();

  async function handle(req: http.IncomingMessage, res: Res): Promise<void> {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    const xff = req.headers['x-forwarded-for'];
    // [check] Task 8: confirm Funnel replaces (not appends to) X-Forwarded-For; if it appends, the first value is client-controlled.
    const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'];
    const t = now();

    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return notFound(res); }
    const m = /^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return notFound(res);
    const [, token, rest = ''] = m;

    const share = findByToken(deps.dir, token!, t);
    // Only failed lookups count and only they get 429: a valid link keeps working behind a shared IP.
    if (!share) return limiter.fail(ip, t.getTime()) ? send(res, 429, 'Too many requests', 'text/plain; charset=utf-8') : notFound(res);

    const route = req.method === 'POST' ? (rest === '/ask' ? 'ask' : '') : req.method === 'GET' ? rest : '';
    const known = route === '' || route === '/' || route === 'ask' || route === '/qr' || route === '/download/summary.pdf' || route === '/download/records.json' || route.startsWith('/doc/');
    if (!known || (route === '' && req.method !== 'GET')) return notFound(res);

    const log = (e: Omit<AccessEvent, 'ip' | 'ua'>): void => {
      deps.log(share, { ...e, ip, ...(ua && { ua }) }).catch(() => {}); // a broken log never breaks the response
    };
    const pageBase = `/s/${token}`;

    if (route === '/qr') return send(res, 200, await renderQr(`${share.baseUrl}/s/${token}`));

    if (route === 'ask') {
      let body: string | undefined;
      try { body = await readBody(req); } catch (e) {
        if (!(e instanceof TooLarge)) throw e;
      }
      const s = await deps.load(share);
      const page = (o: { answer?: { q: string; a: string }; notice?: string }, status = 200, extra: Record<string, string> = {}): void =>
        send(res, status, renderPage(share, summarize(s), recordRows(s), { base: pageBase, tab: 'ask', askEnabled: !!deps.ask, ...o }), HTML, extra);
      if (body === undefined) {
        res.on('finish', () => req.destroy());
        return page({ notice: 'Question too long' }, 413, { Connection: 'close' });
      }
      const q = (new URLSearchParams(body).get('q') ?? '').trim();
      if (!deps.ask) return page({});
      if (!q) return page({ notice: 'Please enter a question.' });
      if (q.length > MAX_Q) return page({ notice: `Questions are limited to ${MAX_Q} characters.` });
      if (!takeQuestion(deps.dir, share.id, t)) return page({ notice: 'Question limit reached for today' });
      let a: string;
      try { a = await deps.ask(q, s, share); } catch {
        log({ kind: 'question', detail: q });
        return page({ notice: 'Sorry, the question could not be answered right now.' });
      }
      log({ kind: 'question', detail: q, answerLength: a.length });
      return page({ answer: { q, a } });
    }

    const s = await deps.load(share);
    if (route === '/download/records.json') {
      log({ kind: 'download', detail: 'records.json' });
      return streamBundle(res, s);
    }
    if (route === '/download/summary.pdf') {
      const pdf = await toPdf(summarize(s), recordRows(s), { label: share.label, created: share.created, scope: scopeWords(share) });
      log({ kind: 'download', detail: 'summary.pdf' });
      return send(res, 200, pdf, 'application/pdf', attach('summary.pdf'));
    }
    if (route.startsWith('/doc/')) {
      let id: string;
      try { id = decodeURIComponent(route.slice(5)); } catch { return notFound(res); }
      if (!(await serveDoc(res, id, s, share, deps))) return notFound(res);
      return log({ kind: 'doc', detail: id });
    }
    const tab = url.searchParams.get('tab');
    log({ kind: 'view' });
    return send(res, 200, renderPage(share, summarize(s), recordRows(s), {
      base: pageBase,
      tab: tab && TABS.has(tab) ? (tab as 'summary') : undefined,
      page: Number(url.searchParams.get('page')) || 1,
      group: url.searchParams.get('group') ?? undefined,
      askEnabled: !!deps.ask,
    }));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      // Never a stack trace on the wire.
      if (!res.headersSent) send(res, 500, 'Something went wrong', 'text/plain; charset=utf-8');
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  return server;
}
