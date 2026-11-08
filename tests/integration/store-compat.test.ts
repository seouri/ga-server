// Differential check of GA's store against Medplum: the same requests against the throwaway ga-test project (a fresh test
// Patient, synthetic records only, deleted after) and against a temp store served in-process; each test asserts the same
// observable result (status, references, bundle and entry shapes, outcome ids). Ids, versions, base URLs and Medplum's
// tracing extension differ legitimately and are compared by shape. Medplum behaviours measured here (Medplum 5.2.14):
// - transactions and batches rewrite urn:uuid fullUrls anywhere in strings (not urn:oid); entry responses are
//   {status: '201', location: 'Type/id', outcome}; a conditional reference is resolved (Medplum also adds a display).
// - a transaction runs GET after PUT; it is NOT atomic: a failing entry leaves earlier ones written, answered 200.
// - a dangling urn:uuid reference is stored as written; this store answers 400 (intended, the brief's rule).
// - an earlier entry that changes what a later conditional entry (urn fullUrl) matches: Medplum fails that entry and
//   leaves references to its urn pointing at no resource; this store fails the transaction (400). When no entry
//   references that urn, Medplum still fails the entry (400, the rest kept); this store runs it (the match updated).
// - Type/_history is 404 and _history is 400 on Medplum; this store supports both (unit tests in src/store/test).
// - PUT and PATCH on a deleted resource bring it back on Medplum; this store answers 410.
// - PUT Binary keeps the Binary's versionId; this store's Binaries have no versions (no ETag).
// Medplum is the reference: GA_STORE=sqlite has no Medplum here, so the file runs only in the Medplum run.
import type { MedplumClient } from '@medplum/core';
import type { Bundle, BundleEntry, Observation, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bearer, getClient } from '../../src/config.ts';
import { cleanupTestPatient, createTestPatient, restoreConfig, SQLITE, testProject } from './helpers.ts';
import { tempStore, type TempStore } from '../temp-store.ts';

type Got = { status: number; headers: Headers; json: any; text: string };
type Side = { name: 'medplum' | 'store'; base: string; pid: string; call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Got> };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// Same shape: uuids and base URLs blanked, Medplum's tracing extension and meta dropped.
const shape = (x: unknown, base: string): unknown => JSON.parse(JSON.stringify(x, (k, v) => (k === 'meta' || (k === 'extension' && JSON.stringify(v).includes('tracing')) ? undefined : v))
  .replaceAll(base, 'BASE/').replace(UUID, 'ID'));

let medplum: MedplumClient, store: TempStore | undefined;
const sides: Side[] = [];
const extra: [string, string][] = []; // Medplum records outside the test Patient's compartment, deleted after

function side(name: Side['name'], base: string, token: () => string, pid: string): Side {
  return {
    name, base, pid,
    async call(method, path, body, headers = {}) {
      const r = await bearer(token())(`${base}fhir/R4/${path}`, {
        method, headers: { 'content-type': 'application/fhir+json', accept: 'application/fhir+json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: r.status, headers: r.headers, json, text };
    },
  };
}
// Runs fn on both sides; returns [medplum, store].
const both = async <T>(fn: (s: Side) => Promise<T>): Promise<[T, T]> => [await fn(sides[0]), await fn(sides[1])];
const keep = async (s: Side, r: Promise<Got>): Promise<Got> => {
  const g = await r;
  if (s.name === 'medplum' && g.json?.resourceType && g.json.id && g.json.resourceType !== 'OperationOutcome' && g.json.resourceType !== 'Bundle') extra.push([g.json.resourceType, g.json.id]);
  return g;
};
const ob = (s: Side, extraFields: Partial<Observation> = {}): Observation => ({ resourceType: 'Observation', status: 'final', code: { text: 'compat probe' }, subject: { reference: `Patient/${s.pid}` }, ...extraFields });
const tx = (s: Side, type: 'batch' | 'transaction', entry: BundleEntry[]) => s.call('POST', '', { resourceType: 'Bundle', type, entry });
const statuses = (b: Bundle) => b.entry!.map((e) => e.response!.status);

describe.skipIf(SQLITE)('store matches Medplum', () => {
  beforeAll(async () => {
    const { cfg } = await testProject();
    medplum = await getClient(cfg);
    const mpid = await createTestPatient(medplum);
    sides.push(side('medplum', cfg.baseUrl!, () => medplum.getAccessToken()!, mpid));
    store = await tempStore();
    const { token } = store;
    const s = side('store', store.base, () => token, '');
    const p = await s.call('POST', 'Patient', { resourceType: 'Patient', identifier: [{ system: 'urn:ga-server:id:patient', value: 'test-compat' }] });
    s.pid = p.json.id;
    sides.push(s);
  }, 120_000);
  afterAll(async () => {
    if (medplum && sides[0]) {
      await cleanupTestPatient(medplum, sides[0].pid);
      for (const [t, id] of extra.reverse()) await medplum.deleteResource(t as 'Observation', id).catch(() => undefined);
    }
    restoreConfig();
    await store?.close();
  }, 120_000);

  test('transaction: urn:uuid fullUrls rewritten in references and in text; 201 entries with Type/id locations and a Created outcome', async () => {
    const A = 'urn:uuid:11111111-1111-4111-8111-111111111111';
    const [m, s] = await both(async (x) => {
      const r = await tx(x, 'transaction', [
        { fullUrl: A, resource: { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${x.pid}` } } as Resource, request: { method: 'POST', url: 'Encounter' } },
        { resource: ob(x, { encounter: { reference: A }, note: [{ text: `see ${A}` }] }), request: { method: 'POST', url: 'Observation' } },
      ]);
      const [enc, o] = r.json.entry.map((e: BundleEntry) => e.resource);
      expect(o.encounter.reference).toBe(`Encounter/${enc.id}`);
      expect(o.note[0].text).toBe(`see Encounter/${enc.id}`);
      return shape({ status: r.status, type: r.json.type, responses: r.json.entry.map((e: BundleEntry) => e.response) }, x.base);
    });
    expect(s).toEqual(m);
  });

  test('conditional references: one match becomes Type/id; none is 400 with Medplum\'s text', async () => {
    const [m, s] = await both(async (x) => {
      const one = await tx(x, 'transaction', [{ resource: ob(x, { subject: { reference: `Patient?_id=${x.pid}` } }), request: { method: 'POST', url: 'Observation' } }]);
      const none = await tx(x, 'transaction', [{ resource: ob(x, { performer: [{ reference: 'Practitioner?identifier=urn:ga-test:none|nothing' }] }), request: { method: 'POST', url: 'Observation' } }]);
      const direct = await x.call('POST', 'Observation', ob(x, { subject: { reference: `Patient?_id=${x.pid}` } }));
      // Medplum's batch answers 200 with a 400 entry; this store's transaction fails as a whole with that 400.
      const noneText = (none.json.entry?.[0]?.response?.outcome ?? none.json).issue[0].details.text;
      return { one: one.json.entry[0].resource.subject.reference === `Patient/${x.pid}`, direct: [direct.status, direct.json.subject.reference === `Patient/${x.pid}`], noneText };
    });
    expect(s).toEqual(m);
  });

  test('batch entries: GET read, vread, search, history and a 404; PATCH as a Binary; conditional PUT; ifNoneExist; ifMatch 412; conditional DELETE', async () => {
    const [m, s] = await both(async (x) => {
      const ident = [{ system: 'urn:ga-test:compat', value: `b-${x.name}-${Date.now()}` }];
      const o = (await x.call('POST', 'Observation', ob(x, { status: 'preliminary', identifier: ident }))).json;
      const q = `identifier=${encodeURIComponent(`${ident[0].system}|${ident[0].value}`)}`;
      const patchBin = { resourceType: 'Binary', contentType: 'application/json-patch+json', data: Buffer.from(JSON.stringify([{ op: 'replace', path: '/status', value: 'final' }])).toString('base64') };
      const r = await tx(x, 'batch', [
        { request: { method: 'GET', url: `Observation/${o.id}/_history/${o.meta.versionId}` } },
        { request: { method: 'GET', url: `Observation?${q}` } },
        { request: { method: 'GET', url: 'Observation/00000000-0000-4000-8000-000000000000' } },
        { request: { method: 'PATCH', url: `Observation/${o.id}` }, resource: patchBin as Resource },
        { request: { method: 'PUT', url: `Observation?identifier=urn:ga-test:compat|new-${x.name}-${Date.now()}` }, resource: ob(x) },
        { request: { method: 'POST', url: 'Observation', ifNoneExist: q }, resource: ob(x) },
        { request: { method: 'PUT', url: `Observation/${o.id}`, ifMatch: 'W/"00000000-0000-4000-8000-000000000000"' }, resource: { ...o, status: 'cancelled' } },
        { request: { method: 'DELETE', url: 'Observation?identifier=urn:ga-test:compat|none' } },
      ]);
      const e = r.json.entry as BundleEntry[];
      return shape({
        type: r.json.type, statuses: statuses(r.json), outcomes: e.map((x) => x.response!.outcome?.id), locations: e.map((x) => x.response!.location),
        vread: (e[0].resource as Observation).status, search: [(e[1].resource as Bundle).type, (e[1].resource as Bundle).entry?.length], patched: (e[3].resource as Observation).status,
        found: e[5].resource?.id === o.id,
      }, x.base);
    });
    expect(s).toEqual(m);
  });

  test('transaction: a conditional PUT with a urn fullUrl defines that urn for a POST (create, then update)', async () => {
    const X = 'urn:uuid:66666666-6666-4666-8666-666666666666';
    const value = `cond-urn-${Date.now()}`; // fresh on both sides: Medplum's project may hold an earlier run's leftovers
    const [m, s] = await both(async (x) => {
      const runs = [];
      for (let n = 0; n < 2; n++) {
        const r = await tx(x, 'transaction', [
          { request: { method: 'POST', url: 'Observation' }, resource: ob(x, { subject: { reference: X } }) },
          { fullUrl: X, request: { method: 'PUT', url: `Patient?identifier=urn:ga-test:compat|${value}` }, resource: { resourceType: 'Patient', identifier: [{ system: 'urn:ga-test:compat', value }] } },
        ]);
        const [o, pat] = (r.json.entry ?? []).map((e: BundleEntry) => e.resource);
        if (x.name === 'medplum') for (const res of [pat, o]) if (res?.id) extra.push([res.resourceType, res.id]);
        runs.push({ status: r.status, statuses: r.json.entry && statuses(r.json), subject: o?.subject?.reference === `Patient/${pat?.id}`, same: pat?.id });
      }
      return shape({ runs: runs.map(({ same, ...r }) => r), samePatient: runs[0].same === runs[1].same }, x.base);
    });
    expect(s).toEqual(m);
  });

  // The unreferenced-urn case differs: Medplum fails the conditional PUT entry (400; it pre-assigned the urn an id and the
  // PUT then matches the Patient the POST just made) and keeps the POST; this store updates that Patient (201, 200).
  test('transaction: each conditional entry resolves on its own (If-None-Exist POSTs spelled two ways; an unreferenced urn)', async () => {
    const value = `own-${Date.now()}`, sys = 'urn:ga-test:compat';
    const [m, s] = await both(async (x) => {
      const prac = (fullUrl: string, ifNoneExist: string, v: string): BundleEntry => ({ fullUrl, request: { method: 'POST', url: 'Practitioner', ifNoneExist }, resource: { resourceType: 'Practitioner', identifier: [{ system: sys, value: v }] } });
      const d = await tx(x, 'transaction', [
        prac('urn:uuid:a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', `identifier=${sys}|${value}`, `${value}-1`),
        prac('urn:uuid:a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', `identifier=${sys}%7C${value}`, `${value}-2`),
        { request: { method: 'POST', url: 'Observation' }, resource: ob(x, { performer: [{ reference: 'urn:uuid:a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1' }, { reference: 'urn:uuid:a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2' }] }) },
      ]);
      const u = await tx(x, 'transaction', [
        { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', identifier: [{ system: sys, value: `${value}-u` }] } },
        { fullUrl: 'urn:uuid:c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1', request: { method: 'PUT', url: `Patient?identifier=${sys}|${value}-u` }, resource: { resourceType: 'Patient', active: true, identifier: [{ system: sys, value: `${value}-u` }] } },
      ]);
      const de = (d.json.entry ?? []) as BundleEntry[], ue = (u.json.entry ?? []) as BundleEntry[];
      if (x.name === 'medplum') for (const e of [...ue, ...de].reverse()) if (e.resource?.id) extra.push([e.resource.resourceType, e.resource.id]);
      return {
        d: [d.status, statuses(d.json)], own: de[2]?.resource && (de[2].resource as Observation).performer?.map((p, n) => p.reference === `Practitioner/${de[n].resource?.id}`),
        u: [u.status, statuses(u.json)], updated: ue[1]?.resource?.id === ue[0]?.resource?.id,
      };
    });
    expect({ ...s, u: undefined, updated: undefined }).toEqual({ ...m, u: undefined, updated: undefined });
    expect([m.u, m.updated]).toEqual([[200, ['201', '400']], false]);
    expect([s.u, s.updated]).toEqual([[200, ['201', '200']], true]);
  });

  test('transaction order: a GET entry sees the PUT listed after it', async () => {
    const [m, s] = await both(async (x) => {
      const o = (await x.call('POST', 'Observation', ob(x))).json;
      const r = await tx(x, 'transaction', [{ request: { method: 'GET', url: `Observation/${o.id}` } }, { request: { method: 'PUT', url: `Observation/${o.id}` }, resource: { ...o, status: 'amended' } }]);
      return [statuses(r.json), r.json.entry[0].resource.status];
    });
    expect(s).toEqual(m);
    expect(s[1]).toBe('amended');
  });

  test('PATCH: JSON Patch applied and versioned; If-Match 412; a failed test op, an id change and a missing resource fail as on Medplum', async () => {
    const jp = { 'content-type': 'application/json-patch+json' };
    const [m, s] = await both(async (x) => {
      const o = (await x.call('POST', 'Observation', ob(x, { status: 'preliminary' }))).json;
      const ok = await x.call('PATCH', `Observation/${o.id}`, [{ op: 'replace', path: '/status', value: 'final' }], jp);
      const stale = await x.call('PATCH', `Observation/${o.id}`, [{ op: 'replace', path: '/status', value: 'amended' }], { ...jp, 'if-match': `W/"${o.meta.versionId}"` });
      const test = await x.call('PATCH', `Observation/${o.id}`, [{ op: 'test', path: '/status', value: 'nope' }], jp);
      const id = await x.call('PATCH', `Observation/${o.id}`, [{ op: 'replace', path: '/id', value: 'other' }], jp);
      const missing = await x.call('PATCH', 'Observation/00000000-0000-4000-8000-000000000000', [], jp);
      const invalid = await x.call('PATCH', `Observation/${o.id}`, [{ op: 'remove', path: '/status' }], jp); // validated like an update
      return shape({
        ok: [ok.status, ok.json.status, ok.json.meta.versionId !== o.meta.versionId, ok.headers.get('etag') === `W/"${ok.json.meta.versionId}"`],
        stale: [stale.status, stale.json.id], test: [test.status, test.json.issue[0].details.text], id: [id.status, id.json.issue[0].details.text], missing: [missing.status, missing.json.id], invalid: invalid.status,
      }, x.base);
    });
    expect(s).toEqual(m);
  });

  test('conditional update and delete: 0 creates (201, Location), 1 updates, 2 is 412 multiple-matches; id mismatches are 400', async () => {
    const [m, s] = await both(async (x) => {
      const v = `c-${x.name}-${Date.now()}`, q = `Observation?identifier=urn:ga-test:compat|${v}`;
      const idf = [{ system: 'urn:ga-test:compat', value: v }];
      const created = await x.call('PUT', q, ob(x, { identifier: idf }));
      const clientId = await x.call('PUT', `Observation?identifier=urn:ga-test:compat|none-${v}`, ob(x, { id: 'abc' }));
      const updated = await x.call('PUT', q, ob(x, { identifier: idf, status: 'amended' }));
      const mismatch = await x.call('PUT', q, ob(x, { id: 'abc', identifier: idf }));
      await x.call('POST', 'Observation', ob(x, { identifier: idf }));
      const many = await x.call('PUT', q, ob(x, { identifier: idf }));
      const delMany = await x.call('DELETE', q);
      const delNone = await x.call('DELETE', `Observation?identifier=urn:ga-test:compat|none-${v}`);
      return shape({
        created: [created.status, created.headers.get('location') === `${x.base}fhir/R4/Observation/${created.json.id}`],
        clientId: [clientId.status, clientId.json.issue[0].details.text], updated: [updated.status, updated.json.id === created.json.id, updated.json.status],
        mismatch: [mismatch.status, mismatch.json.issue[0].details.text], many: [many.status, many.json.id, many.json.issue[0].code], delMany: delMany.status, delNone: [delNone.status, delNone.json.id],
      }, x.base);
    });
    expect(s).toEqual(m);
  });

  test('delete and history: read after delete is 410, a second delete 200; instance history lists the delete first with a total; vread of an old version works', async () => {
    const [m, s] = await both(async (x) => {
      const o = (await x.call('POST', 'Observation', ob(x, { status: 'preliminary' }))).json;
      await x.call('PUT', `Observation/${o.id}`, { ...o, status: 'final' });
      const del = await x.call('DELETE', `Observation/${o.id}`);
      const read = await x.call('GET', `Observation/${o.id}`);
      const again = await x.call('DELETE', `Observation/${o.id}`);
      const h = (await x.call('GET', `Observation/${o.id}/_history`)).json;
      const v = await x.call('GET', `Observation/${o.id}/_history/${o.meta.versionId}`);
      const missing = await x.call('GET', 'Observation/00000000-0000-4000-8000-000000000000/_history');
      return shape({
        del: [del.status, del.json.id], read: [read.status, read.json.id, read.json.issue[0].code], again: again.status,
        history: [h.type, h.total, h.link?.length ?? 0, h.entry.map((e: BundleEntry) => [e.request, e.response!.status, e.response!.outcome?.id, !!e.resource])],
        vread: [v.status, v.json.status, v.headers.get('etag') === `W/"${o.meta.versionId}"`, !!v.headers.get('last-modified')], missing: missing.status,
      }, x.base);
    });
    expect(s).toEqual(m);
  });

  test('Patient/$everything: Patient first, then the compartment by lastUpdated, referenced records as includes; _count pages; _since; _type keeps the Patient', async () => {
    const [m, s] = await both(async (x) => {
      const pr = await keep(x, x.call('POST', 'Practitioner', { resourceType: 'Practitioner', name: [{ family: 'Synthetic' }] }));
      const med = await keep(x, x.call('POST', 'Medication', { resourceType: 'Medication', code: { text: 'synthetic drug' } }));
      // A second, fresh patient keeps the compartment to what this test writes.
      const p = await keep(x, x.call('POST', 'Patient', { resourceType: 'Patient', identifier: [{ system: 'urn:ga-server:id:patient', value: `test-compat-everything-${Date.now()}` }], meta: { tag: [{ system: 'urn:ga-server:tag', code: 'ga-test' }] } }));
      const P = { reference: `Patient/${p.json.id}` };
      const enc = await keep(x, x.call('POST', 'Encounter', { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: P }));
      await new Promise((r) => setTimeout(r, 20));
      const t1 = new Date().toISOString();
      const o = await keep(x, x.call('POST', 'Observation', ob(x, { subject: P, performer: [{ reference: `Practitioner/${pr.json.id}` }] })));
      await keep(x, x.call('POST', 'MedicationRequest', { resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: P, medicationReference: { reference: `Medication/${med.json.id}` } }));
      const list = (b: Bundle) => b.entry!.map((e) => `${e.search?.mode}:${e.resource!.resourceType}`);
      const rels = (b: Bundle) => b.link!.map((l) => l.relation);
      const all = (await x.call('GET', `Patient/${p.json.id}/$everything`)).json;
      const p1 = (await x.call('GET', `Patient/${p.json.id}/$everything?_count=2`)).json;
      const p2 = (await x.call('GET', `Patient/${p.json.id}/$everything?_count=2&_offset=2`)).json;
      const since = (await x.call('GET', `Patient/${p.json.id}/$everything?_since=${encodeURIComponent(t1)}`)).json;
      const typ = (await x.call('GET', `Patient/${p.json.id}/$everything?_type=Encounter`)).json;
      return shape({
        type: all.type, all: list(all), allLinks: rels(all), self: all.link[0].url.replace(p.json.id, 'PID'),
        p1: [list(p1), rels(p1), p1.link.find((l: { relation: string }) => l.relation === 'next')?.url.replace(p.json.id, 'PID')], p2: [list(p2), rels(p2)],
        since: [list(since), since.entry[0].resource.id === o.json.id], typed: [list(typ), typ.entry.map((e: BundleEntry) => e.resource!.id === p.json.id || e.resource!.id === enc.json.id)],
      }, x.base);
    });
    expect(s).toEqual(m);
    expect((s as { all: string[] }).all).toEqual(['match:Patient', 'match:Encounter', 'match:Observation', 'match:MedicationRequest', 'include:Practitioner', 'include:Medication']);
  });

  test('headers: ETag W/"<versionId>" and Last-Modified on create, read and update; Location (absolute) only on a 201', async () => {
    const [m, s] = await both(async (x) => {
      const c = await x.call('POST', 'Observation', ob(x));
      const r = await x.call('GET', `Observation/${c.json.id}`);
      const u = await x.call('PUT', `Observation/${c.json.id}`, { ...c.json, status: 'amended' });
      const lm = (g: Got) => g.headers.get('last-modified') === new Date(g.json.meta.lastUpdated).toUTCString();
      const et = (g: Got) => g.headers.get('etag') === `W/"${g.json.meta.versionId}"`;
      return [c.status, et(c), lm(c), c.headers.get('location') === `${x.base}fhir/R4/Observation/${c.json.id}`, et(r), lm(r), et(u), lm(u), u.headers.get('location')];
    });
    expect(s).toEqual(m);
  });

  test('PUT Binary/<id> replaces the bytes and keeps the id; an unknown id is 404', async () => {
    const [m, s] = await both(async (x) => {
      const b = await keep(x, x.call('POST', 'Binary', 'first bytes', { 'content-type': 'text/plain' }));
      const put = await x.call('PUT', `Binary/${b.json.id}`, 'second bytes', { 'content-type': 'text/plain' });
      const got = await x.call('GET', `Binary/${b.json.id}`, undefined, { accept: '*/*' });
      const unknown = await x.call('PUT', 'Binary/00000000-1111-4000-8000-000000000000', 'x', { 'content-type': 'text/plain' });
      return [b.status, !!b.headers.get('location'), put.status, put.json.id === b.json.id, got.text, unknown.status];
    });
    expect(s).toEqual(m);
  });

  test('_summary=false is accepted and changes nothing', async () => {
    const [m, s] = await both(async (x) => {
      const plain = (await x.call('GET', `Observation?subject=Patient/${x.pid}&_count=3&_sort=_lastUpdated`)).json;
      const r = await x.call('GET', `Observation?subject=Patient/${x.pid}&_count=3&_sort=_lastUpdated&_summary=false`);
      return [r.status, r.json.entry.map((e: BundleEntry) => e.resource!.id).join() === plain.entry.map((e: BundleEntry) => e.resource!.id).join()];
    });
    expect(s).toEqual(m);
  });

  // Where this store differs from Medplum on purpose: both behaviours asserted, so a Medplum change shows up here.
  test('deliberate differences: dangling urn, a conditional entry whose match an earlier entry changed, transaction atomicity, urn:oid, type/system history, PUT on a deleted resource', async () => {
    const [mp, st] = sides;
    const dangling = (x: Side) => tx(x, 'transaction', [{ resource: ob(x, { performer: [{ reference: 'urn:uuid:44444444-4444-4444-8444-444444444444' }] }), request: { method: 'POST', url: 'Observation' } }]);
    const md = await dangling(mp);
    expect([md.status, md.json.entry[0].response.status, md.json.entry[0].resource.performer[0].reference]).toEqual([200, '201', 'urn:uuid:44444444-4444-4444-8444-444444444444']);
    expect((await dangling(st)).status).toBe(400);

    const failing = (x: Side, mark: string) => tx(x, 'transaction', [{ resource: ob(x, { code: { text: mark } }), request: { method: 'POST', url: 'Observation' } }, { request: { method: 'GET', url: 'Observation/00000000-0000-4000-8000-000000000000' } }]);
    const mark = `compat atomic ${Date.now()}`;
    const mf = await failing(mp, mark), sf = await failing(st, mark);
    expect([mf.status, statuses(mf.json)]).toEqual([200, ['201', '404']]);
    expect(sf.status).toBe(404);
    const left = async (x: Side) => (await x.call('GET', `Observation?code:text=${encodeURIComponent(mark)}&_summary=count`)).json.total;
    expect([await left(mp), await left(st)]).toEqual([1, 0]);

    const oid = (x: Side) => tx(x, 'transaction', [
      { fullUrl: 'urn:oid:1.2.3', resource: { resourceType: 'Practitioner' }, request: { method: 'POST', url: 'Practitioner' } },
      { resource: ob(x, { performer: [{ reference: 'urn:oid:1.2.3' }] }), request: { method: 'POST', url: 'Observation' } },
    ]);
    const mo = await oid(mp);
    extra.push(['Practitioner', mo.json.entry[0].resource.id]);
    expect(mo.json.entry[1].resource.performer[0].reference).toBe('urn:oid:1.2.3');
    const so = await oid(st);
    expect(so.json.entry[1].resource.performer[0].reference).toBe(`Practitioner/${so.json.entry[0].resource.id}`);

    expect([(await mp.call('GET', 'Observation/_history?_count=1')).status, (await mp.call('GET', '_history?_count=1')).status]).toEqual([404, 400]);
    expect([(await st.call('GET', 'Observation/_history?_count=1')).status, (await st.call('GET', '_history?_count=1')).status]).toEqual([200, 200]);

    const revive = async (x: Side) => {
      const o = (await x.call('POST', 'Observation', ob(x))).json;
      await x.call('DELETE', `Observation/${o.id}`);
      return (await x.call('PUT', `Observation/${o.id}`, { ...o, status: 'amended' })).status;
    };
    expect([await revive(mp), await revive(st)]).toEqual([200, 410]);

    // An earlier entry changes what a later conditional entry matches: Medplum fails that entry (400) but keeps the others,
    // and the reference to its urn points at a Patient that does not exist; this store refuses the whole transaction (400).
    const value = `moved-${Date.now()}`, ident = [{ system: 'urn:ga-test:compat', value }];
    const B1 = 'urn:uuid:b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', B2 = 'urn:uuid:b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
    const moved = (x: Side) => tx(x, 'transaction', [
      { fullUrl: B1, request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=urn:ga-test:compat|${value}` }, resource: { resourceType: 'Patient', active: true, identifier: ident } },
      { fullUrl: B2, request: { method: 'PUT', url: `Patient?identifier=urn:ga-test:compat|${value}&active=true` }, resource: { resourceType: 'Patient', identifier: ident } },
      { resource: ob(x, { subject: { reference: B2 } }), request: { method: 'POST', url: 'Observation' } },
    ]);
    const mm = await moved(mp);
    for (const e of (mm.json.entry ?? []) as BundleEntry[]) if (e.resource?.id) extra.push([e.resource.resourceType, e.resource.id]);
    expect([mm.status, statuses(mm.json)]).toEqual([200, ['201', '400', '201']]);
    expect((await mp.call('GET', mm.json.entry[2].resource.subject.reference)).status).toBe(404);
    const sm = await moved(st);
    expect([sm.status, sm.json.issue?.[0]?.details?.text]).toEqual([400, expect.stringMatching(/an earlier entry changed its match$/)]);

  });
});
