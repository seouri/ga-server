// ga ui: the chronology page, for the owner on this computer only. It listens on 127.0.0.1, answers only requests that carry
// this run's secret (the printed link sets it as a cookie) and name this host (no DNS rebinding), and loads nothing from elsewhere.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import { getClient, loadConfig } from '../config.ts';
import { healthMaintenance } from '../maintenance.ts';
import { makeDetails, type Detail, type Query } from './detail.ts';
import { buildTimeline, loadRecords, type Timeline } from './timeline.ts';

const WEB = join(import.meta.dirname, 'web');
const FILES: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/scale.js': 'scale.js', '/style.css': 'style.css' };
const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
};
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const KINDS = ['ref', 'series', 'course', 'dx', 'list'];
// cookie: the name of this run's cookie. A browser keeps cookies per host, not per port, so two pages on one computer (two people's
// installs, on two ports) must not share a name: the second would replace the first one's secret and lock its page out.
export type UiDeps = { timeline: () => Promise<Timeline>; detail: (q: Query) => Promise<Detail | undefined>; secret: string; hosts: string[]; cookie?: string };

export function uiHandler(deps: UiDeps): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const send = (res: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra });
    res.end(body);
  };
  const name = deps.cookie ?? 'ga_ui';
  const mine = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  return async (req, res) => {
    try {
      if (!deps.hosts.includes(req.headers.host ?? '')) return send(res, 403, 'forbidden');
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const key = url.searchParams.get('k');
      if (url.pathname === '/' && key) { // the printed link: keep the secret out of the address bar and history
        if (!same(key, deps.secret)) return send(res, 403, 'forbidden');
        return send(res, 303, '', undefined, { Location: '/', 'Set-Cookie': `${name}=${deps.secret}; HttpOnly; SameSite=Strict; Path=/` });
      }
      const cookie = mine.exec(req.headers.cookie ?? '')?.[1] ?? '';
      if (!same(cookie, deps.secret)) return send(res, 403, 'Open the link that `ga ui` printed.');
      const file = FILES[url.pathname];
      if (file) return send(res, 200, readFileSync(join(WEB, file), 'utf8'), MIME[file.split('.').pop()!]);
      if (url.pathname === '/api/timeline') return send(res, 200, JSON.stringify(await deps.timeline()), 'application/json');
      if (url.pathname === '/api/detail') { // one of: ref (a record), series (a test over time), course (a drug), dx (a diagnosis), list
        const q = [...url.searchParams].filter(([k]) => KINDS.includes(k));
        if (q.length !== 1 || !q[0][1] || q[0][1].length > 300 || (q[0][0] === 'ref' && !/^[A-Za-z]{3,40}\/[A-Za-z0-9\-.]{1,64}$/.test(q[0][1]))) return send(res, 400, 'bad request');
        const d = await deps.detail({ [q[0][0]]: q[0][1] });
        return d ? send(res, 200, JSON.stringify(d), 'application/json') : send(res, 404, 'GA has no such record.');
      }
      return send(res, 404, 'not found');
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      return send(res, 500, 'GA could not read the record. Is it running (docker compose up -d)?');
    }
  };
}

// Health maintenance items with a due date, for the timeline's "planned" marks; a record it cannot judge (no birth date) has none.
async function planned(client: MedplumClient, patientId: string): Promise<Timeline['planned']> {
  try {
    const hm = await healthMaintenance(client, patientId);
    // Due or overdue now sits at today; a later due date (also the next round of something done) at its date.
    const now = ['due', 'overdue', 'due soon'];
    return hm.items.filter((i) => i.nextMention !== null && (now.includes(i.status) || (i.dueDate && i.dueDate > hm.asOf)))
      .map((i) => ({ t: i.dueDate && i.dueDate > hm.asOf ? i.dueDate : hm.asOf, label: i.name, kind: i.kind,
        rows: [['Status', i.dueDate && i.dueDate > hm.asOf && i.status === 'done' ? `next due ${i.dueDate}` : i.status], ['Importance', i.importance], ...(i.why ? [['Why', i.why] as [string, string]] : [])] }));
  } catch { return []; }
}

export async function serveUi(port = 8120): Promise<void> {
  const cfg = loadConfig();
  const pid = cfg.patientId as string;
  const client = await getClient(cfg);
  const secret = randomBytes(24).toString('base64url');
  let cached: { at: number; value: Promise<{ timeline: Timeline; detail: (q: Query) => Detail | undefined }> } | undefined;
  const read = (fresh: boolean) => { // one read of the record serves the timeline and every detail asked of it; reloading the page reads again after a minute
    if (!cached || (fresh && Date.now() - cached.at > 60_000)) {
      const value = Promise.all([loadRecords(client, pid), planned(client, pid), client.readResource('Patient', pid)])
        .then(([all, plan, patient]) => ({ timeline: { ...buildTimeline(all, new Date().toLocaleDateString('en-CA'), { gender: patient.gender, birthDate: patient.birthDate }), planned: plan }, detail: makeDetails(all) }));
      cached = { at: Date.now(), value };
      value.catch(() => { cached = undefined; });
    }
    return cached.value;
  };
  const server = http.createServer(uiHandler({ timeline: async () => (await read(true)).timeline, detail: async (q) => (await read(false)).detail(q), secret, cookie: `ga_ui_${port}`, hosts: [`127.0.0.1:${port}`, `localhost:${port}`] }));
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(port, '127.0.0.1', ok));
  console.log(`GA chronology: http://127.0.0.1:${port}/?k=${secret}\nOnly this computer can open it. Ctrl-C stops it.`);
}
