// ga migrate-store pure parts: the gate, the config switch, the copy's completeness, the replay diff and its allowed differences, Binary ids kept.
import { GA_STORE_TYPES } from '../src/store-serve.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { type MigrateReport, SWITCH_READY, SWITCH_REFUSED, copyRecord, gate, migrateStore, switchConfig } from '../src/migrate-store.ts';
import type { MedplumClient } from '@medplum/core';
import { statSync } from 'node:fs';
import { Store } from '../src/store/store.ts';
import type { AddressInfo } from 'node:net';
import { classify, diff, eqDayExtras, tie, toolTieOk } from '../src/migrate-store-verify.ts';
import { bearer } from '../src/config.ts';
import { tempStore } from './temp-store.ts';

const saved = process.env.GA_STORE;
delete process.env.GA_STORE; // migrate-store runs on a Medplum install (it refuses GA_STORE=sqlite)
afterAll(() => { if (saved !== undefined) process.env.GA_STORE = saved; });

const clean = (): MigrateReport => ({
  types: { Observation: { copied: 3, skipped: 0 } }, uncounted: {}, historyVersions: { MedicationRequest: 2 }, binaries: { copied: 1, failed: 0 },
  compartmentMismatches: {}, versionMismatches: {}, blockedWrites: 0, normalized: [],
  replay: [{ category: 'tool', name: 'health_summary', keys: [], result: 'equal', kinds: [] }],
});

test('the gate passes a clean report and names each blocking problem', () => {
  expect(gate(clean())).toEqual([]);
  const r = clean();
  r.types.Observation.skipped = 1;
  r.compartmentMismatches = { Condition: 2 };
  r.versionMismatches = { Observation: 1 };
  r.binaries.failed = 1;
  r.binaries.unresolved = 2;
  r.replay.push({ category: 'search', name: 'Observation', keys: ['code'], result: 'unexplained', kinds: ['value'] });
  r.replay.push({ category: 'tool', name: 'vitals', keys: [], result: 'allowed', kinds: ['signed-url'] });
  expect(gate(r)).toEqual([
    '1 record failed validation and was not copied (Observation: 1)',
    '2 compartment mismatches with Medplum (Condition: 2)',
    '1 id/version mismatch with Medplum (Observation: 1)',
    '1 Binary could not be copied',
    '2 attachment urls do not resolve to a copied Binary',
    '1 unexplained replay difference (search Observation)',
  ]);
});

test('switchConfig writes "store": "sqlite" atomically, keeping every other key and mode 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const f = join(dir, 'config.json');
  const before = { baseUrl: 'http://localhost:8103/', clientId: 'c', clientSecret: 's', patientId: 'p', converterUrl: 'x', projectId: 'pr' };
  writeFileSync(f, JSON.stringify(before), { mode: 0o600 });
  try {
    switchConfig(f);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ ...before, store: 'sqlite' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('copyRecord: a record Medplum counts but paging never returned is a gate line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const store = new Store(join(dir, 'ga.db'), { types: GA_STORE_TYPES });
  const o = (id: string) => ({ resourceType: 'Observation', id, status: 'final', code: { text: 'x' }, meta: { versionId: `v${id}`, lastUpdated: '2024-01-01T00:00:00.000Z' } });
  const fake = {
    getBaseUrl: () => 'http://medplum/',
    async *searchResourcePages(type: string) { if (type === 'Observation') { yield [o('1')]; yield [o('3')]; } }, // o2 dropped between pages
    search: async (type: string) => ({ resourceType: 'Bundle', total: type === 'Observation' ? 3 : 0 }),
  } as unknown as MedplumClient;
  try {
    const r = clean();
    r.types = {};
    await copyRecord(fake, store, r);
    expect(r.types.Observation).toEqual({ copied: 2, skipped: 0 });
    expect(r.uncounted).toEqual({ Observation: 1 });
    expect(gate(r)).toEqual(["Medplum's count differs from the records read (Observation: missing 1)"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('diff: a signed URL for the same Binary is allowed; another value is not', () => {
  const id = '0b7d5c2e-1111-4222-8333-444455556666';
  const m = { content: [{ attachment: { url: `http://localhost:8103/storage/${id}/v1?Signature=abc&Expires=1` } }] };
  const d = diff(m, { content: [{ attachment: { url: `Binary/${id}` } }] });
  expect(d.map((x) => x.kind)).toEqual(['signed-url']);
  expect(classify(d, () => false)).toBe('allowed');
  const other = diff(m, { content: [{ attachment: { url: 'Binary/0b7d5c2e-1111-4222-8333-000000000000' } }] });
  expect(classify(other, () => false)).toBe('unexplained');
  expect(classify(diff({ a: 1 }, { a: 2 }), () => true)).toBe('unexplained');
  expect(classify(diff({ a: 1 }, { a: 1 }), () => false)).toBe('equal');
});

test('diff: lastUpdated and versionId count; Bundle ids, fullUrl bases and paging links do not', () => {
  expect(diff({ meta: { versionId: '1' } }, { meta: { versionId: '2' } }).map((x) => x.kind)).toEqual(['value']);
  const b = (base: string, next: boolean) => ({ resourceType: 'Bundle', id: base, link: next ? [{ relation: 'next', url: `${base}x` }] : [],
    entry: [{ fullUrl: `${base}fhir/R4/Observation/1`, resource: { resourceType: 'Observation', id: '1' } }] });
  expect(diff(b('http://a/', true), b('http://b/', true))).toEqual([]);
  expect(diff(b('http://a/', true), b('http://b/', false)).map((x) => x.kind)).toEqual(['next-page']);
  expect(diff({ nextPage: 'x' }, { nextPage: 'y' })).toEqual([]);
});

test('diff: same records in another order is "order"; classify allows it only when the tie check says so', () => {
  const a = [{ resourceType: 'Observation', id: '1' }, { resourceType: 'Observation', id: '2' }];
  const d = diff(a, [...a].reverse());
  expect(d.map((x) => x.kind)).toEqual(['order']);
  expect(classify(d, () => true)).toBe('allowed');
  expect(classify(d, () => false)).toBe('unexplained');
});

const ob = (id: string, day: string) => ({ resourceType: 'Observation', id, status: 'final', code: { text: 'x' }, effectiveDateTime: day });
const bundle = (entries: object[], next = false) => ({ resourceType: 'Bundle', type: 'searchset', entry: entries.map((r: any) => ({ search: { mode: r.include ? 'include' : 'match' }, resource: r.include ?? r })),
  ...(next && { link: [{ relation: 'next', url: 'http://x/next' }] }) });
const verdict = (a: any, b: any, sort: string | undefined, count: number) => classify(diff(a, b), () => tie('Observation', sort, count, a, b));

test('tie: a dropped _include is unexplained, even on an unsorted query', () => {
  const m = { include: { resourceType: 'Medication', id: 'm1' } };
  expect(verdict(bundle([ob('1', '2024-01-01'), m]), bundle([ob('1', '2024-01-01')]), undefined, 20)).toBe('unexplained');
});

test('tie: another record with an equal sort key on a page that is not full is unexplained', () => {
  expect(verdict(bundle([ob('1', '2024-01-02'), ob('2', '2024-01-01')]), bundle([ob('1', '2024-01-02'), ob('3', '2024-01-01')]), '-date', 20)).toBe('unexplained');
  expect(verdict(bundle([ob('1', '2024-01-01'), ob('2', '2024-01-01')]), bundle([ob('2', '2024-01-01'), ob('1', '2024-01-01')]), '-date', 20)).toBe('allowed'); // same records, tie order
});

test('tie: a page cut among equal last keys on a full page is allowed; a different record before the cut is not', () => {
  expect(verdict(bundle([ob('1', '2024-01-02'), ob('2', '2024-01-01')]), bundle([ob('1', '2024-01-02'), ob('3', '2024-01-01')]), '-date', 2)).toBe('allowed');
  expect(verdict(bundle([ob('1', '2024-01-02'), ob('2', '2024-01-01')], true), bundle([ob('1', '2024-01-02'), ob('3', '2024-01-01')], true), '-date', 20)).toBe('allowed');
  expect(verdict(bundle([ob('1', '2024-01-02'), ob('2', '2024-01-01')]), bundle([ob('4', '2024-01-02'), ob('2', '2024-01-01')]), '-date', 2)).toBe('unexplained');
});

test('tie: one instant in two offsets, or Periods with one start, tie under -date; another instant does not', () => {
  const per = (id: string, start: string, end: string) => ({ resourceType: 'Observation', id, status: 'final', code: { text: 'x' }, effectivePeriod: { start, end } });
  expect(verdict(bundle([ob('1', '2024-01-01T05:00:00Z'), ob('2', '2024-01-01T00:00:00-05:00')]), bundle([ob('2', '2024-01-01T00:00:00-05:00'), ob('1', '2024-01-01T05:00:00Z')]), '-date', 20)).toBe('allowed');
  expect(verdict(bundle([per('1', '2024-01-01', '2024-01-03'), per('2', '2024-01-01', '2024-01-02')]), bundle([per('2', '2024-01-01', '2024-01-02'), per('1', '2024-01-01', '2024-01-03')]), '-date', 20)).toBe('allowed');
  expect(verdict(bundle([ob('1', '2024-01-01T05:00:01Z'), ob('2', '2024-01-01T00:00:00-05:00')]), bundle([ob('2', '2024-01-01T00:00:00-05:00'), ob('1', '2024-01-01T05:00:01Z')]), '-date', 20)).toBe('unexplained');
});

test('eqDayExtras: store-only extras timed inside the UTC day (not midnight) for date=eq<day> are allowed; anything else is not', () => {
  const M = bundle([ob('1', '2024-03-01T00:00:00Z')]);
  const why = (b: any, dates = ['eq2024-03-01'], a: any = M) => eqDayExtras(dates, diff(a, b), a, b);
  expect(why(bundle([ob('1', '2024-03-01T00:00:00Z'), ob('2', '2024-02-29T22:30:00-05:00')]))).toBe(true); // 03:30 UTC on the day
  expect(why(bundle([ob('1', '2024-03-01T00:00:00Z'), ob('2', '2024-03-01T23:59:59Z')]))).toBe(true);
  // near misses
  expect(why(bundle([ob('2', '2024-03-01T12:00:00Z')]))).toBe(false); // Medplum's record missing
  expect(why(bundle([ob('1', '2024-03-01T00:00:00Z'), ob('2', '2024-03-01T00:00:00Z')]))).toBe(false); // extra at midnight UTC
  expect(why(bundle([ob('1', '2024-03-01T00:00:00Z'), ob('2', '2024-03-02T00:30:00Z')]))).toBe(false); // outside the UTC day
  expect(why(bundle([ob('1', '2024-03-01T00:00:00Z'), ob('2', '2024-03-01')]))).toBe(false); // not a timed value
  expect(why(bundle([ob('1', '2024-03-01T00:00:00Z'), ob('2', '2024-03-01T12:00:00Z')]), ['ge2024-03-01'])).toBe(false); // not eq
  expect(why(bundle([ob('1', '2024-03-01T00:00:00Z'), ob('2', '2024-03-01T12:00:00Z')]), ['eq2024-03'])).toBe(false); // not day precision
  const two = bundle([ob('1', '2024-03-01T00:00:00Z'), ob('3', '2024-03-01T00:00:00Z')]);
  expect(why(bundle([ob('3', '2024-03-01T00:00:00Z'), ob('1', '2024-03-01T00:00:00Z')]), ['eq2024-03-01'], two)).toBe(false); // order only
});

test('toolTieOk: a tool difference is a tie only when its searches tied and nothing it read was skipped', () => {
  const ok = { searches: 2, orderAllowed: true, unexplained: false, skipped: false };
  expect(toolTieOk(ok)).toBe(true);
  expect(toolTieOk(undefined)).toBe(false); // no searches recorded
  expect(toolTieOk({ ...ok, searches: 0 })).toBe(false);
  expect(toolTieOk({ ...ok, orderAllowed: false })).toBe(false); // every search equal: the tool's own reorder is unexplained
  expect(toolTieOk({ ...ok, unexplained: true })).toBe(false);
  expect(toolTieOk({ ...ok, skipped: true })).toBe(false); // later pages, reads or history not replayed
});

test('putBinaryStream keeps a given Binary id (migration) and refuses one that is not a uuid or already stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const store = new Store(join(dir, 'ga.db'), { types: GA_STORE_TYPES });
  try {
    const id = '0b7d5c2e-1111-4222-8333-444455556666';
    expect((await store.putBinaryStream('text/plain', [Buffer.from('hi')], id)).id).toBe(id);
    expect(await new Response(store.openBinary(id)!.stream()).text()).toBe('hi');
    await expect(store.putBinaryStream('text/plain', [Buffer.from('x')], '../evil')).rejects.toThrow();
    await expect(store.putBinaryStream('text/plain', [Buffer.from('x')], id)).rejects.toThrow(/already exists/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('migrate-store refuses without stopped services: prints the commands, touches nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const cfgFile = join(dir, 'config.json');
  writeFileSync(cfgFile, '{"patientId":"p"}');
  const lines: string[] = [];
  try {
    await expect(migrateStore({
      file: join(dir, 'ga.db'), configFile: cfgFile, reportFile: join(dir, 'report.json'), yes: true, allowSwitch: true, servicesStopped: false,
      services: { stop: async () => { throw new Error('docker: command not found'); }, start: async () => undefined, commands: { stop: 'docker compose stop ga-sync ga-gateway', start: () => 'docker compose up -d' } },
      cfg: { patientId: 'p', converterUrl: 'x', baseUrl: 'http://127.0.0.1:1/', clientId: 'c', clientSecret: 's' }, log: (s) => lines.push(s),
    })).rejects.toThrow('--services-stopped');
    expect(lines.join('\n')).toContain('docker compose stop ga-sync ga-gateway');
    expect(readFileSync(cfgFile, 'utf8')).toBe('{"patientId":"p"}');
    expect(existsSync(join(dir, 'ga.db'))).toBe(false); // ga-store still runs: the file is opened only after the services stop
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrate-store --yes refuses to switch until full FHIR spec support: nothing stopped, opened or written', async () => {
  expect(SWITCH_READY).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const cfgFile = join(dir, 'config.json');
  writeFileSync(cfgFile, '{"patientId":"p"}');
  let stopped = false;
  try {
    await expect(migrateStore({
      file: join(dir, 'ga.db'), configFile: cfgFile, reportFile: join(dir, 'report.json'), yes: true, servicesStopped: false,
      services: { stop: async () => { stopped = true; }, start: async () => undefined, commands: { stop: 's', start: () => 'u' } },
      cfg: { patientId: 'p', converterUrl: 'x', baseUrl: 'http://127.0.0.1:1/', clientId: 'c', clientSecret: 's' }, log: () => undefined,
    })).rejects.toThrow(SWITCH_REFUSED);
    expect(SWITCH_REFUSED).toContain('Next phase');
    expect(stopped).toBe(false);
    expect(readFileSync(cfgFile, 'utf8')).toBe('{"patientId":"p"}');
    expect(existsSync(join(dir, 'ga.db'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrate-store refuses an install already on its own store', async () => {
  process.env.GA_STORE = 'sqlite';
  try {
    await expect(migrateStore({ file: '/nonexistent/ga.db', configFile: '/nonexistent/config.json', reportFile: '/nonexistent/r.json', yes: true, servicesStopped: true,
      services: { stop: async () => undefined, start: async () => undefined, commands: { stop: 's', start: () => 'u' } }, cfg: { patientId: 'p', converterUrl: 'x' }, log: () => undefined,
    })).rejects.toThrow('already runs on its own store');
  } finally { delete process.env.GA_STORE; }
  await expect(migrateStore({ file: '/nonexistent/ga.db', configFile: '/nonexistent/config.json', reportFile: '/nonexistent/r.json', yes: true, servicesStopped: true,
    services: { stop: async () => undefined, start: async () => undefined, commands: { stop: 's', start: () => 'u' } }, cfg: { patientId: 'p', converterUrl: 'x', store: 'sqlite' }, log: () => undefined,
  })).rejects.toThrow('already runs on its own store');
});

test('migrate-store --services-stopped refuses while a store still answers, before opening the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  try {
    await expect(migrateStore({
      file: join(dir, 'ga.db'), configFile: join(dir, 'config.json'), reportFile: join(dir, 'report.json'), yes: true, allowSwitch: true, servicesStopped: true,
      services: { stop: async () => undefined, start: async () => undefined, commands: { stop: 's', start: () => 'u' } },
      cfg: { patientId: 'p', converterUrl: 'x', baseUrl: 'http://127.0.0.1:1/', clientId: 'c', clientSecret: 's' }, log: () => undefined, storeUp: async () => true,
    })).rejects.toThrow('ga-store is still running');
    expect(existsSync(join(dir, 'ga.db'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrate-store refuses a target file that already holds records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const file = join(dir, 'ga.db');
  const s = new Store(file, { types: GA_STORE_TYPES });
  s.create({ resourceType: 'Patient' });
  s.close();
  let stopped = false;
  try {
    await expect(migrateStore({
      file, configFile: join(dir, 'config.json'), reportFile: join(dir, 'report.json'), yes: true, allowSwitch: true, servicesStopped: true,
      services: { stop: async () => { stopped = true; }, start: async () => undefined, commands: { stop: 's', start: () => 'u' } },
      cfg: { patientId: 'p', converterUrl: 'x', baseUrl: 'http://127.0.0.1:1/', clientId: 'c', clientSecret: 's' }, log: () => undefined, storeUp: async () => false,
    })).rejects.toThrow('already holds records');
    expect(stopped).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A stand-in for Medplum: its token endpoint, and every FHIR request forwarded to a second, empty store server (so both sides
// answer alike and the gate passes). The whole dry run, no docker.
test('migrate-store dry run while the switch is gated: copies and checks, prints the gated closing line, never switches', async () => {
  const { createServer } = await import('node:http');
  const backing = await tempStore();
  const medplum = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url?.startsWith('/oauth2/token')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'x', token_type: 'Bearer', expires_in: 3600 }));
    const r = await bearer(backing.token)(`${backing.base}${req.url?.slice(1)}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/fhir+json' },
      body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/fhir+json' }).end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => medplum.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const cfgFile = join(dir, 'config.json');
  writeFileSync(cfgFile, '{"patientId":"p"}');
  const lines: string[] = [], calls: string[] = [];
  try {
    const { switched, report } = await migrateStore({
      file: join(dir, 'store', 'ga.db'), configFile: cfgFile, reportFile: join(dir, 'report.json'), yes: false, servicesStopped: false,
      services: { stop: async () => { calls.push('stop'); }, start: async (sw) => { calls.push(`start:${sw}`); }, commands: { stop: 's', start: () => 'u' } },
      cfg: { patientId: 'p', converterUrl: 'x', baseUrl: `http://127.0.0.1:${(medplum.address() as AddressInfo).port}/`, clientId: 'c', clientSecret: 's' }, log: (s) => lines.push(s),
    });
    expect(switched).toBe(false);
    expect(report.gate?.pass).toBe(true);
    expect(lines.at(-1)).toBe(`The copy checks out; GA stays on Medplum. ${SWITCH_REFUSED}.`);
    expect(lines.join('\n')).not.toContain('--yes');
    expect(calls).toEqual(['stop', 'start:false']);
    expect(readFileSync(cfgFile, 'utf8')).toBe('{"patientId":"p"}');
  } finally {
    medplum.closeAllConnections();
    await new Promise((r) => medplum.close(r));
    await backing.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate-store on a target in an old index format names GA\'s fix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const file = join(dir, 'ga.db');
  const s = new Store(file, { types: GA_STORE_TYPES });
  s.create({ resourceType: 'Patient' });
  s.db.exec('pragma user_version = 1');
  s.close();
  try {
    await expect(migrateStore({
      file, configFile: join(dir, 'config.json'), reportFile: join(dir, 'report.json'), yes: false, servicesStopped: true,
      services: { stop: async () => undefined, start: async () => undefined, commands: { stop: 's', start: () => 'u' } },
      cfg: { patientId: 'p', converterUrl: 'x', baseUrl: 'http://127.0.0.1:1/', clientId: 'c', clientSecret: 's' }, log: () => undefined, storeUp: async () => false,
    })).rejects.toThrow(/search index format 1.*move it aside and run ga migrate-store$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
