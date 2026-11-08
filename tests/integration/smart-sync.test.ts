// SMART sync against the synthetic mock server and the local Medplum, always on throwaway test patients.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Condition, DocumentReference, Extension, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { LAST_SEEN } from '../../src/identity.ts';
import { ensureKeys, saveSecret, writeApp, writeSources } from '../../src/smart/store.ts';
import type { SourceRec } from '../../src/smart/store.ts';
import { isStale, readStatus, syncAll, syncSource } from '../../src/smart/sync.ts';
import { serveFixtures, startMock } from '../smart/mock-server.ts';
import type { MockSmart } from '../smart/mock-server.ts';
import { cleanupTestMaps, cleanupTestPatient, compartmentOf, createTestPatient } from './helpers.ts';

const P = 'synthetic-patient-1';
const clientId = 'synthetic-client';
const ENABLED = ['Condition', 'DocumentReference', 'Encounter', 'MedicationRequest', 'Observation'];
const H = 3_600_000;

let client: MedplumClient;
let dir: string;
let m: MockSmart;
const pids: string[] = [];
const keys: string[] = [];

const fresh = (key: string, mock = m): void =>
  saveSecret(dir, key, { access_token: mock.grant(), expires_at: Date.now() + H, patient: P });
const newKey = (p: string): string => {
  const k = `${p}-${randomUUID()}`;
  keys.push(k);
  return k;
};
const newPatient = async (): Promise<string> => {
  const id = await createTestPatient(client);
  pids.push(id);
  return id;
};
const compartment = (pid: string): Promise<Resource[]> => compartmentOf(client, pid);
const smartIds = (r: Resource, key: string) =>
  ((r as { identifier?: { system?: string; value?: string }[] }).identifier ?? []).filter((i) => i.system === `urn:ga-server:id:smart:${key}`);
const ext = (r: { extension?: Extension[] }, url: string) => r.extension?.find((e) => e.url === url);
// Binary id behind an attachment url: Medplum answers reads with a presigned /storage/<binary id>/... URL.
const binId = (url?: string) => /(?:Binary|storage)\/([0-9a-f-]{36})/.exec(url ?? '')?.[1];
const bins = (rs: Resource[]) => rs.flatMap((x) => (x as DocumentReference).content?.map((c) => binId(c.attachment.url)) ?? []).filter(Boolean).sort();
const endpoints = (key: string) =>
  client.searchResources('Endpoint', { identifier: `urn:ga-server:id:smart-source|${key}` }, { cache: 'no-cache' });

beforeAll(async () => {
  client = await getClient(loadConfig());
  dir = mkdtempSync(join(tmpdir(), 'ga-smart-sync-'));
  const { publicJwks } = await ensureKeys(dir);
  writeApp(dir, { clientId });
  m = await startMock({ clientId, jwks: publicJwks });
  serveFixtures(m);
});

// Endpoints, Binaries and the shared Medication live outside the patient compartment: delete them by hand.
afterAll(async () => {
  await cleanupTestMaps(client);
  for (const pid of pids) {
    for (const r of await compartment(pid)) {
      for (const c of (r as DocumentReference).content ?? []) {
        const id = binId(c.attachment?.url);
        if (id) await client.deleteResource('Binary', id).catch(() => undefined);
      }
    }
    await cleanupTestPatient(client, pid);
  }
  for (const key of keys) {
    for (const e of await endpoints(key)) await client.deleteResource('Endpoint', e.id as string);
    const meds = await client.searchResources('Medication', { identifier: `urn:ga-server:id:smart:${key}|Medication/med1` }, { cache: 'no-cache' });
    for (const r of meds) await client.deleteResource('Medication', r.id as string);
  }
  await m?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('isStale', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const ago = (h: number) => new Date(now.getTime() - h * H).toISOString();
  it('is stale when off, error, or the last success is older than 48 h', () => {
    expect(isStale('active', ago(47), now)).toBe(false);
    expect(isStale('active', ago(49), now)).toBe(true);
    expect(isStale('off', ago(1), now)).toBe(true);
    expect(isStale('error', ago(1), now)).toBe(true);
    expect(isStale('active', undefined, now)).toBe(true);
  });
});

describe('syncSource', () => {
  let pid: string;
  let src: SourceRec;
  let dryCounts: Record<string, { created: number; flagged: number }>;
  const t1 = new Date(Date.now() - 60_000);
  const t2 = new Date();

  beforeAll(async () => {
    pid = await newPatient();
    src = { key: newKey('sync'), name: 'Synthetic Hospital', fhirBase: m.fhirBase, patient: P };
    fresh(src.key);
  });

  it('without enabled types only dry-runs: per-type counts, no patient data, a status-only Endpoint (off, not_enabled)', async () => {
    writeSources(dir, [src]);
    const before = await client.readResource('Patient', pid, { cache: 'no-cache' });
    // Medplum can't search Binary: watch every write method on the real client instead.
    const writes = (['createResource', 'updateResource', 'patchResource', 'createBinary', 'deleteResource', 'post', 'put', 'patch', 'delete', 'executeBatch'] as const)
      .map((k) => vi.spyOn(client, k));
    const r = await syncSource(client, dir, src, pid);
    const [create, , , , , post, ...rest] = writes;
    expect(create.mock.calls.map((c) => (c[0] as Resource).resourceType)).toEqual(['Endpoint']); // the status entry only
    expect(post.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/\/Endpoint$/)]); // createResource's own POST
    for (const w of [...writes.slice(1, 5), ...rest]) expect(w).not.toHaveBeenCalled();
    for (const w of writes) w.mockRestore();
    expect(r).toMatchObject({ source: src.key, status: 'pending', dryRun: true });
    expect(r.fetched).toMatchObject({ Condition: 2, Observation: 5 });
    dryCounts = r.perType ?? {};
    expect(Object.fromEntries(Object.entries(dryCounts).map(([t, c]) => [t, c.created]))).toEqual({
      Condition: 2, DocumentReference: 3, Encounter: 1, Medication: 1, MedicationRequest: 1, Observation: 5,
    });
    expect(Object.values(dryCounts).every((c) => c.flagged === 0)).toBe(true);
    expect(await compartment(pid)).toEqual([]);
    expect((await client.readResource('Patient', pid, { cache: 'no-cache' })).meta?.versionId).toBe(before.meta?.versionId);
    const eps = await endpoints(src.key);
    expect(eps).toHaveLength(1);
    expect(eps[0].status).toBe('off');
    expect(ext(eps[0], 'urn:ga-server:ext:smart-last-error')?.valueCode).toBe('not_enabled');
    expect(ext(eps[0], 'urn:ga-server:ext:smart-patient')?.valueReference?.reference).toBe(`Patient/${pid}`);
    expect(ext(eps[0], 'urn:ga-server:ext:smart-last-success')).toBeUndefined();
    expect(await client.searchResources('Medication', { identifier: `urn:ga-server:id:smart:${src.key}|Medication/med1` }, { cache: 'no-cache' })).toHaveLength(0);
    const off = { source: src.key, name: 'Synthetic Hospital', status: 'off', error: 'not_enabled', stale: true, enabledTypes: [] };
    expect(await readStatus(client, pid)).toEqual([off]);
    expect(await readStatus(client, pid, dir)).toEqual([off]);
  });

  it('first enabled sync creates what the dry run counted and marks the Endpoint active', async () => {
    src = { ...src, enabledTypes: ENABLED };
    const r = await syncSource(client, dir, src, pid, { now: t1 });
    expect(r.status).toBe('active');
    expect(r.report).toMatchObject({ created: 13, updated: 0, invalid: 0 });
    expect(r.perType).toEqual(dryCounts);
    const doc = (await compartment(pid)).find((x) => smartIds(x, src.key)[0]?.value === 'DocumentReference/doc-pdf') as DocumentReference;
    expect(binId(doc.content[0].attachment.url)).toBeTruthy(); // Medplum presigns Binary/<id> on read
    const [ep] = await endpoints(src.key);
    expect(ep).toMatchObject({ status: 'active', address: m.fhirBase, name: 'Synthetic Hospital', payloadType: [{ text: 'FHIR R4' }] });
    expect(ep.connectionType).toEqual({ system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest' });
    expect(ext(ep, 'urn:ga-server:ext:smart-last-success')?.valueDateTime).toBe(t1.toISOString());
    expect(ext(ep, 'urn:ga-server:ext:smart-enabled-types')?.valueString).toBe(ENABLED.join(','));
    expect(ext(ep, 'urn:ga-server:ext:smart-access-expires')?.valueDateTime).toBeTruthy();
    expect(await readStatus(client, pid)).toEqual([
      { source: src.key, name: 'Synthetic Hospital', status: 'active', lastSuccess: t1.toISOString(), stale: false, enabledTypes: ENABLED },
    ]);
  });

  it('an unchanged second sync creates and updates nothing and advances last-seen on medications and problems only', async () => {
    const before = await compartment(pid);
    const binsBefore = bins(before);
    expect(binsBefore).toHaveLength(1);
    const r = await syncSource(client, dir, src, pid, { now: t2 });
    expect(r.status).toBe('active');
    expect(r.report).toMatchObject({ created: 0, updated: 0, invalid: 0, seen: 3 });
    const mine = (await compartment(pid)).filter((x) => smartIds(x, src.key).length);
    expect(mine).toHaveLength(12);
    const dated = ['MedicationRequest', 'Condition'];
    expect(mine.filter((x) => dated.includes(x.resourceType))).toHaveLength(3);
    for (const x of mine) {
      if (dated.includes(x.resourceType)) expect(ext(x as { extension?: Extension[] }, LAST_SEEN)?.valueDateTime).toBe(t2.toISOString());
      else {
        expect(ext(x as { extension?: Extension[] }, LAST_SEEN)).toBeUndefined();
        expect(x.meta?.versionId).toBe(before.find((y) => y.id === x.id)?.meta?.versionId); // not rewritten
      }
    }
    expect(bins(mine)).toEqual(binsBefore);
    expect((await readStatus(client, pid))[0].lastSuccess).toBe(t2.toISOString());
  });

  it('an explicit dry run on an enabled source writes nothing, not even the Endpoint', async () => {
    const writes = (['createResource', 'updateResource', 'patchResource', 'createBinary', 'deleteResource', 'post', 'put', 'patch', 'delete', 'executeBatch'] as const)
      .map((k) => vi.spyOn(client, k));
    const r = await syncSource(client, dir, src, pid, { dryRun: true });
    for (const w of writes) {
      expect(w).not.toHaveBeenCalled();
      w.mockRestore();
    }
    expect(r).toMatchObject({ status: 'active', dryRun: true, report: { created: 0 } });
    expect((await readStatus(client, pid))[0].lastSuccess).toBe(t2.toISOString());
  });
});

describe('sync lock', () => {
  it('a second concurrent sync of one source reports busy and writes nothing; a waiting one runs after; a dead lock is taken', async () => {
    const pid = await newPatient();
    const src: SourceRec = { key: newKey('lock'), name: 'Lock Hospital', fhirBase: m.fhirBase, patient: P, enabledTypes: ['Observation'] };
    fresh(src.key);
    const obs = async () => (await compartment(pid)).filter((x) => x.resourceType === 'Observation').length;
    // The first call takes the lock before its first await, so the second (no wait) finds it held.
    const [a, b] = await Promise.all([syncSource(client, dir, src, pid), syncSource(client, dir, src, pid, { lockWaitMs: 0 })]);
    expect(a).toMatchObject({ status: 'active', report: { created: 5 } });
    expect(b).toEqual({ source: src.key, status: 'pending', error: 'busy' }); // no Endpoint yet: nothing to report
    expect(await obs()).toBe(5);
    expect(await endpoints(src.key)).toHaveLength(1);
    // With the default wait the second runs once the first is done, and finds nothing new.
    const [c, d] = await Promise.all([syncSource(client, dir, src, pid), syncSource(client, dir, src, pid)]);
    expect([c.report?.created, d.report?.created]).toEqual([0, 0]);
    expect(await obs()).toBe(5);
    // A lock left by a dead process on this host is stale.
    writeFileSync(join(dir, `${src.key}.sync.lock`), JSON.stringify({ pid: 2 ** 22 + 1, host: hostname(), started: Date.now() }));
    expect(await syncSource(client, dir, src, pid, { lockWaitMs: 0 })).toMatchObject({ status: 'active' });
    // Our own pid from before this process started: a restarted container that reused the pid.
    writeFileSync(join(dir, `${src.key}.sync.lock`), JSON.stringify({ pid: process.pid, host: hostname(), started: Date.now() - (process.uptime() + 60) * 1000 }));
    expect(await syncSource(client, dir, src, pid, { lockWaitMs: 0 })).toMatchObject({ status: 'active' });
    // A live lock from another host (the ga-sync container) is not, until 2 h old.
    writeFileSync(join(dir, `${src.key}.sync.lock`), JSON.stringify({ pid: 2 ** 22 + 1, host: 'other-host', started: Date.now() }));
    expect(await syncSource(client, dir, src, pid, { lockWaitMs: 0 })).toEqual({ source: src.key, status: 'active', error: 'busy' });
    writeFileSync(join(dir, `${src.key}.sync.lock`), JSON.stringify({ pid: 1, host: 'other-host', started: Date.now() - 3 * H }));
    expect(await syncSource(client, dir, src, pid, { lockWaitMs: 0 })).toMatchObject({ status: 'active', report: { created: 0 } });
  });
});

describe('link to an EHI record', () => {
  let pid: string;
  let src: SourceRec;
  let mock: MockSmart;
  let ehiId: string;
  const OID = 'urn:oid:1.2.840.114350.1.13.0.1.7.2.768076';

  beforeAll(async () => {
    pid = await newPatient();
    const { publicJwks } = await ensureKeys(dir);
    mock = await startMock({ clientId, jwks: publicJwks });
    serveFixtures(mock);
    // The portal sends the problem without meta.lastUpdated: it may only fill what the EHI record lacks.
    const fix = JSON.parse(readFileSync(new URL('../fixtures/smart/resources.json', import.meta.url), 'utf8')) as { entry: { resource: Resource }[] };
    const { meta: _m, ...condPl } = fix.entry.map((e) => e.resource).find((r) => r.id === 'cond-pl') as Condition;
    mock.route('/fhir/Condition', (req, res, url) => {
      if (!mock.authorized(req)) return void res.writeHead(401).end();
      const cat = url.searchParams.get('category');
      const entry = !cat || cat === 'problem-list-item' ? [{ resource: condPl, search: { mode: 'match' } }] : [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry }));
    });
    src = { key: newKey('link'), name: 'Synthetic Hospital', fhirBase: mock.fhirBase, patient: P, enabledTypes: ['Condition'] };
    fresh(src.key, mock);
    const ehi = await client.createResource<Condition>({
      resourceType: 'Condition',
      identifier: [{ system: 'urn:ga-server:id:ehi:synthetic', value: `PROBLEM_LIST|${randomUUID()}` }, { system: OID, value: 'SYN-PL-1' }],
      meta: { tag: [{ system: 'urn:ga-server:tag', code: 'writer-importer' }, { system: 'urn:ga-server:tag', code: 'src-ehi' }] },
      code: { coding: [{ system: 'http://snomed.info/sct', code: '1234567', display: 'Synthetic coded problem' }], text: 'Synthetic problem' },
      note: [{ text: 'Synthetic EHI note' }],
      subject: { reference: `Patient/${pid}` },
    });
    ehiId = ehi.id as string;
  });
  afterAll(() => mock?.close());

  it('links instead of creating, and the coded code and note survive two syncs', async () => {
    for (const [i, now] of [new Date(Date.now() - 60_000), new Date()].entries()) {
      const r = await syncSource(client, dir, src, pid, { now });
      expect(r.status).toBe('active');
      expect(r.report).toMatchObject({ created: 0, updated: 0, invalid: 0 });
      if (i === 0) expect(r.perType?.Condition).toMatchObject({ created: 0, linked: 1 });
      const c = await client.readResource('Condition', ehiId, { cache: 'no-cache' });
      expect(c.code?.coding?.[0].code).toBe('1234567');
      expect(c.note).toEqual([{ text: 'Synthetic EHI note' }]);
      expect(smartIds(c, src.key)).toHaveLength(1);
    }
    expect((await compartment(pid)).filter((x) => x.resourceType === 'Condition')).toHaveLength(1);
  });
});

describe('syncAll', () => {
  it('a revoked source goes off with invalid_grant and the next source still syncs', async () => {
    const pid = await newPatient();
    const revoked: SourceRec = { key: newKey('revoked'), name: 'Revoked Hospital', fhirBase: m.fhirBase, patient: P, enabledTypes: ['Observation'] };
    const noRefresh: SourceRec = { key: newKey('norefresh'), name: 'No Refresh Hospital', fhirBase: m.fhirBase, patient: P, enabledTypes: ['Observation'] };
    const good: SourceRec = { key: newKey('good'), name: 'Good Hospital', fhirBase: m.fhirBase, patient: P, enabledTypes: ['Observation'] };
    // Expired access token and a refresh token the server no longer knows: the refresh answers invalid_grant.
    saveSecret(dir, revoked.key, { access_token: 'at-expired', refresh_token: 'rt-revoked', expires_at: Date.now() - 1000, patient: P });
    saveSecret(dir, noRefresh.key, { access_token: 'at-expired', expires_at: Date.now() - 1000, patient: P });
    fresh(good.key);
    writeSources(dir, [revoked, noRefresh, good]);
    const rs = await syncAll(client, dir, pid);
    expect(rs.map((r) => [r.source, r.status, r.error])).toEqual([
      [revoked.key, 'off', 'invalid_grant'],
      [noRefresh.key, 'off', 'no_refresh_token'],
      [good.key, 'active', undefined],
    ]);
    const [ep] = await endpoints(revoked.key);
    expect(ep.status).toBe('off');
    expect(ext(ep, 'urn:ga-server:ext:smart-last-error')?.valueCode).toBe('invalid_grant');
    expect(ext(ep, 'urn:ga-server:ext:smart-last-success')).toBeUndefined();
    const [nr] = await endpoints(noRefresh.key);
    expect(nr.status).toBe('off');
    expect(ext(nr, 'urn:ga-server:ext:smart-last-error')?.valueCode).toBe('no_refresh_token');
    const st = await readStatus(client, pid);
    expect(st.find((s) => s.source === revoked.key)).toMatchObject({ status: 'off', stale: true });
    expect(st.find((s) => s.source === good.key)).toMatchObject({ status: 'active', stale: false, enabledTypes: ['Observation'] });
  });

  it('a first-connect source that fails returns its failure and writes a status-only Endpoint (off, the failure code)', async () => {
    const pid = await newPatient();
    const src: SourceRec = { key: newKey('firstfail'), name: 'New Hospital', fhirBase: m.fhirBase, patient: P };
    saveSecret(dir, src.key, { access_token: 'at-expired', refresh_token: 'rt-revoked', expires_at: Date.now() - 1000, patient: P });
    writeSources(dir, [src]);
    expect(await syncAll(client, dir, pid)).toEqual([{ source: src.key, status: 'off', error: 'invalid_grant' }]);
    const [ep] = await endpoints(src.key);
    expect(ep.status).toBe('off');
    expect(ext(ep, 'urn:ga-server:ext:smart-last-success')).toBeUndefined();
    expect(await compartment(pid)).toEqual([]);
    expect(await readStatus(client, pid, dir)).toEqual([{ source: src.key, name: 'New Hospital', status: 'off', error: 'invalid_grant', stale: true, enabledTypes: [] }]);
  });
});

describe('a cut-short fetch', () => {
  it('a 429 fails the sync: Endpoint error, last success and last-seen stay where they were', async () => {
    const pid = await newPatient();
    const { publicJwks } = await ensureKeys(dir);
    const mock = await startMock({ clientId, jwks: publicJwks });
    serveFixtures(mock);
    const src: SourceRec = { key: newKey('cut'), name: 'Cut Hospital', fhirBase: mock.fhirBase, patient: P, enabledTypes: ['MedicationRequest'] };
    fresh(src.key, mock);
    const t1 = new Date(Date.now() - 60_000);
    expect((await syncSource(client, dir, src, pid, { now: t1 })).status).toBe('active');
    mock.route('/fhir/MedicationRequest', (_q, res) => void res.writeHead(429).end());
    expect(await syncSource(client, dir, src, pid)).toEqual({ source: src.key, status: 'error', error: 'fetch_error' });
    await mock.close();
    const [ep] = await endpoints(src.key);
    expect(ep.status).toBe('error');
    expect(ext(ep, 'urn:ga-server:ext:smart-last-success')?.valueDateTime).toBe(t1.toISOString());
    const [mr] = (await compartment(pid)).filter((x) => x.resourceType === 'MedicationRequest');
    expect(ext(mr as { extension?: Extension[] }, LAST_SEEN)?.valueDateTime).toBe(t1.toISOString());
  });
});

// Endpoint is in no patient compartment: readStatus must only list this patient's sources.
describe('readStatus', () => {
  it('lists nothing for a patient without sources', async () => {
    const pid = await newPatient();
    expect(await readStatus(client, pid)).toEqual([]);
  });
});
