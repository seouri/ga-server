import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Resource } from '@medplum/fhirtypes';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { logAccess, readLog } from '../src/share/audit.ts';
import type { Scoped } from '../src/share/scope.ts';
import { createServer, failLimiter } from '../src/share/server.ts';
import { createShare, revokeShare, type Share } from '../src/share/store.ts';

const HEADERS = {
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};
const b64 = (s: string): string => Buffer.from(s).toString('base64');
const cpt = { compartment: [{ reference: 'Patient/p' }] };
const med = { resourceType: 'MedicationStatement', id: 'm1', status: 'active', medicationCodeableConcept: { text: 'Testolol 5 mg' }, effectiveDateTime: '2026-01-01', meta: cpt } as Resource;
const note = { resourceType: 'DocumentReference', id: 'd1', status: 'current', date: '2026-02-01', meta: cpt, content: [{ attachment: { contentType: 'text/plain', title: 'visit note.txt', data: b64('note body') } }] } as Resource;
const linked = { resourceType: 'DocumentReference', id: 'd2', status: 'current', date: '2026-02-02', meta: cpt, content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/11111111-2222-3333-4444-555555555555' } }] } as Resource;
const archive = { resourceType: 'DocumentReference', id: 'arch', status: 'current', identifier: [{ system: 'urn:ga-server:id:ehi-archive', value: 'x' }], content: [{ attachment: { data: b64('everything') } }] } as Resource;
const binary = { resourceType: 'Binary', id: '11111111-2222-3333-4444-555555555555', contentType: 'application/pdf' } as Resource;
const scoped: Scoped = { patient: { resourceType: 'Patient', id: 'p', name: [{ text: 'Test Person' }], birthDate: '1970-01-01' }, resources: [med, note, linked], support: [binary], endpoints: [] };

let dir: string;
let server: Server;
let base: string;
let logs: { share: Share; e: { kind: string; detail?: string; ip?: string; ua?: string; answerLength?: number } }[];
let asked: string[];

function start(deps: Partial<Parameters<typeof createServer>[0]> = {}): Promise<void> {
  server = createServer({
    dir,
    load: async () => scoped,
    log: async (share, e) => { logs.push({ share, e }); },
    fetchBinary: async (ref) => ({ data: Buffer.from(`bytes of ${ref}`), contentType: 'application/pdf' }),
    ask: async (q) => { asked.push(q); return `answer to ${q}`; },
    ...deps,
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok(); }));
}
const share = (o: { audience?: 'doctor' | 'family'; questionsPerDay?: number; expires?: string } = {}) =>
  createShare(dir, { audience: o.audience ?? 'family', label: 'Test family', patientId: 'p', baseUrl: 'http://share.example', questionsPerDay: o.questionsPerDay, expires: o.expires });
const get = (path: string, h: Record<string, string> = {}) => fetch(base + path, { headers: h });
const ask = (token: string, q: string) => fetch(`${base}/s/${token}/ask`, { method: 'POST', body: new URLSearchParams({ q }) });
const expectHeaders = (r: Response) => { for (const [k, v] of Object.entries(HEADERS)) expect(r.headers.get(k), k).toBe(v); };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ga-srv-')); logs = []; asked = []; });
afterEach(async () => { await new Promise((ok) => server?.close(ok)); rmSync(dir, { recursive: true, force: true }); });

test('valid token: 200, headers, summary, view logged', async () => {
  await start();
  const { token, share: s } = share();
  const r = await get(`/s/${token}`, { 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'user-agent': 'ua-test' });
  expect(r.status).toBe(200);
  expectHeaders(r);
  const html = await r.text();
  expect(html).toContain('Testolol 5 mg');
  expect(html).toContain('Test Person');
  expect(logs).toEqual([{ share: expect.objectContaining({ id: s.id }), e: { kind: 'view', ip: '203.0.113.5', ua: 'ua-test' } }]);
});

test('unknown, revoked and expired tokens: 404 with an identical body; load never called', async () => {
  let loads = 0;
  // Server clock 2 h ahead: a 1 h share is expired.
  await start({ load: async () => { loads++; return scoped; }, now: () => new Date(Date.now() + 2 * 3600000) });
  const revoked = share();
  revokeShare(dir, revoked.share.id);
  const expired = share({ expires: '1h' });
  const bodies = [];
  for (const t of ['A'.repeat(43), revoked.token, expired.token]) {
    const r = await get(`/s/${t}`);
    expect(r.status).toBe(404);
    expectHeaders(r);
    bodies.push(await r.text());
  }
  expect(bodies[0]).toContain('This link is no longer active');
  expect(new Set(bodies).size).toBe(1);
  expect(loads).toBe(0);
});

test('paths outside /s/ and unsupported methods: 404 with headers', async () => {
  await start();
  const { token } = share();
  for (const p of ['/', '/admin', '/s/', `/s/${token}/nope`, `/s/${token}/../admin`]) {
    const r = await get(p);
    expect(r.status, p).toBe(404);
    expectHeaders(r);
  }
  const del = await fetch(`${base}/s/${token}`, { method: 'DELETE' });
  expect(del.status).toBe(404);
  const postPage = await fetch(`${base}/s/${token}`, { method: 'POST', body: 'x' });
  expect(postPage.status).toBe(404);
  const getAsk = await get(`/s/${token}/ask`);
  expect(getAsk.status).toBe(404);
});

test('revoke while running: next request is 404 (Review Focus 5)', async () => {
  await start();
  const { token, share: s } = share();
  expect((await get(`/s/${token}`)).status).toBe(200);
  revokeShare(dir, s.id);
  expect((await get(`/s/${token}`)).status).toBe(404);
  // A share created while running works without a restart too.
  expect((await get(`/s/${share().token}`)).status).toBe(200);
});

test('/doc: inline data, Binary via fetchBinary, out-of-scope ids 404', async () => {
  await start();
  const { token } = share();
  const r = await get(`/s/${token}/doc/d1`);
  expect(r.status).toBe(200);
  expectHeaders(r);
  expect(r.headers.get('content-disposition')).toBe('attachment; filename="visit_note.txt"');
  expect(await r.text()).toBe('note body');
  const bin = await get(`/s/${token}/doc/d2`);
  expect(bin.status).toBe(200);
  expect(bin.headers.get('content-type')).toBe('application/pdf');
  expect(await bin.text()).toBe('bytes of Binary/11111111-2222-3333-4444-555555555555');
  expect(logs.map((l) => l.e.kind)).toEqual(['doc', 'doc']);
  for (const id of ['arch', 'm1', 'nope', '%E0%A4%A']) expect((await get(`/s/${token}/doc/${id}`)).status, id).toBe(404);
});

test('/doc: archive DocumentReference in s.resources is still refused (inScope re-check); Binary not in support is 404', async () => {
  const stray = { ...linked, id: 'd3', content: [{ attachment: { url: 'Binary/99999999-2222-3333-4444-555555555555' } }] } as Resource;
  await start({ load: async () => ({ ...scoped, resources: [...scoped.resources, archive, stray] }) });
  const { token } = share();
  expect((await get(`/s/${token}/doc/arch`)).status).toBe(404);
  expect((await get(`/s/${token}/doc/d3`)).status).toBe(404);
});

test('downloads: records.json is the scoped Bundle, summary.pdf is a PDF', async () => {
  await start();
  const { token } = share();
  const r = await get(`/s/${token}/download/records.json`);
  expect(r.status).toBe(200);
  expectHeaders(r);
  expect(r.headers.get('content-disposition')).toContain('attachment');
  const b = await r.json();
  expect(b.resourceType).toBe('Bundle');
  expect(b.entry.map((e: any) => `${e.resource.resourceType}/${e.resource.id}`).sort()).toEqual(
    ['Patient/p', 'MedicationStatement/m1', 'DocumentReference/d1', 'DocumentReference/d2', `Binary/${binary.id}`].sort());
  const pdf = await get(`/s/${token}/download/summary.pdf`);
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  expect(logs.map((l) => [l.e.kind, l.e.detail])).toEqual([['download', 'records.json'], ['download', 'summary.pdf']]);
});

test('/qr renders the share link', async () => {
  await start();
  const { token } = share();
  const r = await get(`/s/${token}/qr`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain(`http://share.example/s/${token}`);
});

test('/ask: cap of 1 answers once, then the limit notice; question logged with answer length', async () => {
  await start();
  const { token } = share({ questionsPerDay: 1 });
  const a = await ask(token, '  what <b>meds</b>?  ');
  expect(a.status).toBe(200);
  expectHeaders(a);
  const html = await a.text();
  expect(html).toContain('answer to what &lt;b&gt;meds&lt;/b&gt;?');
  expect(asked).toEqual(['what <b>meds</b>?']);
  expect(logs.at(-1)!.e).toMatchObject({ kind: 'question', detail: 'what <b>meds</b>?', answerLength: 'answer to what <b>meds</b>?'.length });
  const b = await ask(token, 'again?');
  expect(await b.text()).toContain('Question limit reached for today');
  expect(asked).toHaveLength(1);
});

test('/ask: empty, too long, oversized body, answer error, not set up', async () => {
  await start({ ask: async () => { throw new Error('secret internal detail'); } });
  const { token } = share();
  expect(await (await ask(token, '   ')).text()).toContain('Please enter a question');
  expect(await (await ask(token, 'x'.repeat(2001))).text()).toContain('2000 characters');
  const big = await fetch(`${base}/s/${token}/ask`, { method: 'POST', body: 'q=' + 'x'.repeat(21 * 1024) });
  expect(big.status).toBe(413);
  expectHeaders(big);
  expect(await big.text()).toContain('Question too long');
  // Chunked (no Content-Length): the streaming count rejects it.
  const chunks = new ReadableStream({ start(c) { for (let i = 0; i < 30; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024))); c.close(); } });
  const chunked = await fetch(`${base}/s/${token}/ask`, { method: 'POST', body: chunks, duplex: 'half' } as RequestInit);
  expect(chunked.status).toBe(413);
  expect(await chunked.text()).toContain('Question too long');
  const err = await (await ask(token, 'hi')).text();
  expect(err).toContain('Sorry, the question could not be answered right now.');
  expect(err).not.toContain('secret internal detail');
  await new Promise((ok) => server.close(ok));
  await start({ ask: undefined });
  expect(await (await ask(token, 'hi')).text()).toContain('Questions are not set up');
});

test('rate limit: 21 bad tokens from one IP give 429; a valid token still works; the limit lifts after the window', async () => {
  let clock = Date.now();
  await start({ now: () => new Date(clock) });
  const { token } = share();
  const h = { 'x-forwarded-for': '198.51.100.7' };
  for (let i = 0; i < 20; i++) expect((await get(`/s/bad${i}`, h)).status).toBe(404);
  const r = await get('/s/bad20', h);
  expect(r.status).toBe(429);
  expectHeaders(r);
  expect((await get(`/s/${token}`, h)).status).toBe(200);
  expect((await get('/s/bad21', { 'x-forwarded-for': '198.51.100.8' })).status).toBe(404);
  clock += 10 * 60_000;
  expect((await get('/s/bad22', h)).status).toBe(404);
});

test('failLimiter stays bounded under 20k spoofed IPs and evicts the oldest', () => {
  const l = failLimiter();
  const t = Date.now();
  for (let i = 0; i < 21; i++) l.fail('victim', t);
  expect(l.fail('victim', t)).toBe(true);
  for (let i = 0; i < 20_000; i++) l.fail(`10.0.${i >> 8}.${i & 255}`, t);
  expect(l.size()).toBe(10_000);
  expect(l.fail('victim', t)).toBe(false); // evicted, counts afresh
});

test('load failure and log failure: no stack leaks, log failure does not break the page', async () => {
  await start({ load: async () => { throw new Error('medplum stack detail'); } });
  const { token } = share();
  const r = await get(`/s/${token}`);
  expect(r.status).toBe(500);
  expectHeaders(r);
  expect(await r.text()).not.toContain('medplum stack detail');
  await new Promise((ok) => server.close(ok));
  await start({ log: async () => { throw new Error('log down'); } });
  expect((await get(`/s/${token}`)).status).toBe(200);
});

test('logAccess writes a tagged AuditEvent; readLog reads it back', async () => {
  const created: any[] = [];
  const searches: any[] = [];
  const client = {
    createResource: async (r: any) => { created.push(r); return { ...r, id: 'a1' }; },
    searchResources: async (t: string, q: any) => { searches.push([t, q]); return created; },
  } as any;
  const s = share().share;
  await logAccess(client, s, { kind: 'question', detail: 'how are my labs?', ip: '203.0.113.5', ua: 'ua', answerLength: 42 });
  const a = created[0];
  expect(a.resourceType).toBe('AuditEvent');
  expect(a.meta.tag).toEqual([{ system: 'urn:ga-server:share', code: s.id }]);
  expect(a.entity[0].what.reference).toBe('Patient/p');
  expect(a.entity[0].detail).toEqual([{ type: 'question', valueString: 'how are my labs?' }, { type: 'answer-length', valueString: '42' }]);
  expect(a.agent[0]).toMatchObject({ who: { display: 'Test family' }, name: 'ua', network: { address: '203.0.113.5' } });
  expect(a.source.observer.display).toBe('GA share');
  await logAccess(client, s, { kind: 'download', detail: 'summary.pdf' });
  const log = await readLog(client, s.id);
  expect(searches[0]).toEqual(['AuditEvent', expect.objectContaining({ _tag: `urn:ga-server:share|${s.id}` })]);
  expect(log).toEqual([
    { at: a.recorded, label: 'Test family', kind: 'question', detail: 'how are my labs?', ip: '203.0.113.5' },
    { at: created[1].recorded, label: 'Test family', kind: 'download', detail: 'summary.pdf' },
  ]);
  await readLog(client);
  expect(searches[1][1]._tag).toBe('urn:ga-server:share|');
});
