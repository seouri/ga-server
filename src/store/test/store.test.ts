import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Condition, Medication, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { DatabaseSync } from 'node:sqlite';
import { INDEX_VERSION, IndexFormatError, Store, StoreError } from '../store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const obs = (o: Partial<Observation> = {}): Observation => ({ resourceType: 'Observation', status: 'final', code: { text: 'LDL' }, ...o });
const err = (f: () => unknown): StoreError => { try { f(); } catch (e) { return e as StoreError; } throw new Error('did not throw'); };

describe('Store core', () => {
  let dir: string, store: Store;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-store-')); store = new Store(join(dir, 'store.db'), { terminology: [] }); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('opens in WAL mode with a 64 MB cache, no mmap and full sync', () => {
    expect(store.db.prepare('pragma journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(store.db.prepare('pragma cache_size').get()).toEqual({ cache_size: -65536 });
    expect(store.db.prepare('pragma mmap_size').get()).toEqual({ mmap_size: 0 });
    expect(store.db.prepare('pragma synchronous').get()).toEqual({ synchronous: 2 }); // FULL: no lost commits on power loss
  });

  it('create assigns a UUID id, meta.versionId and meta.lastUpdated (ignoring client ones)', () => {
    const { resource: r, created } = store.create(obs({ id: 'mine', meta: { versionId: 'v0', lastUpdated: '2000-01-01T00:00:00.000Z', tag: [{ code: 't' }] } }));
    expect(created).toBe(true);
    expect(r.id).toMatch(UUID);
    expect(r.meta?.versionId).toMatch(UUID);
    expect(r.meta?.lastUpdated).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(r.meta?.tag).toEqual([{ code: 't' }]);
    expect(store.read('Observation', r.id!)).toEqual(r);
  });

  it('If-Match: a stale version is 412; the current one updates, and history lists both newest first', () => {
    const v1 = store.create(obs()).resource as Observation;
    const v2 = store.update({ ...v1, status: 'amended' }, `W/"${v1.meta!.versionId}"`);
    expect(v2.meta!.versionId).not.toBe(v1.meta!.versionId);
    const e = err(() => store.update({ ...v1, status: 'corrected' }, `W/"${v1.meta!.versionId}"`));
    expect(e).toBeInstanceOf(StoreError);
    expect(e.status).toBe(412);
    expect(store.history({ type: 'Observation', id: v1.id! }).map((h) => h.versionId)).toEqual([v2.meta!.versionId, v1.meta!.versionId]);
    expect(store.history({ type: 'Observation', id: v1.id!, count: 1, offset: 1 }).map((h) => JSON.parse(h.json).status)).toEqual(['final']);
  });

  it('an unchanged update keeps the version (as Medplum does)', () => {
    const v1 = store.create(obs()).resource;
    expect(store.update({ ...v1 })).toEqual(v1);
    expect(store.history({ type: 'Observation', id: v1.id! })).toHaveLength(1);
  });

  it('empty values are dropped as Medplum drops them: an empty array item becomes null, so a parallel _x array stays aligned', () => {
    const ext = { extension: [{ url: 'urn:x', valueString: 'e' }] };
    const p = store.create({ resourceType: 'Patient', identifier: [], name: [{ given: [null, 'Bob'], _given: [ext, null] }] } as unknown as Resource).resource as Patient & { name: { _given?: unknown[] }[] };
    expect(p.identifier).toBeUndefined();
    expect([p.name[0].given, p.name[0]._given]).toEqual([[null, 'Bob'], [ext, null]]);
    const q = store.create({ resourceType: 'Patient', name: [{ given: ['A', 'B'], _given: [{}, ext] }] } as unknown as Resource).resource as Patient & { name: { _given?: unknown[] }[] };
    expect(q.name[0]._given).toEqual([null, ext]);
  });

  it('an empty array item (\'\' or {}) is 400 with Medplum\'s texts: R4 JSON has no empty values (other empty values are dropped)', () => {
    const issues = (r: unknown) => { try { store.create(r as Resource); } catch (e) { return [(e as StoreError).status, (e as StoreError).outcome.issue?.map((i) => `${i.expression} ${i.details?.text}`)]; } return 'created'; };
    expect(issues({ resourceType: 'Patient', name: [{ given: ['', ''] }] })).toEqual([400, ['Patient.name[0].given[0] String must contain non-whitespace content', 'Patient.name[0].given[1] String must contain non-whitespace content']]);
    expect(issues({ resourceType: 'Patient', identifier: [{ value: 'x' }, {}] })).toEqual([400, ['Patient.identifier[1] Invalid empty non-primitive value']]);
    expect(issues({ resourceType: 'Patient', contact: [{ name: { given: [''] } }] })).toEqual([400, ['Patient.contact[0].name.given[0] String must contain non-whitespace content']]);
    for (const r of [{ identifier: [] }, { identifier: [{ system: '' }] }, { managingOrganization: {} }, { name: [{ given: ['A'], _given: [{}] }] }]) expect(issues({ resourceType: 'Patient', ...r })).toBe('created');
    const p = store.create({ resourceType: 'Patient' }).resource;
    expect(err(() => store.update({ ...p, name: [{ given: [''] }] } as Resource)).status).toBe(400);
  });

  it('a submitted meta.deleted (Medplum\'s own field) is dropped on create and update, as Medplum', () => {
    const v1 = store.create({ ...obs(), meta: { deleted: true } } as Resource).resource;
    expect(v1.meta).not.toHaveProperty('deleted');
    expect(store.update({ ...v1, status: 'amended', meta: { ...v1.meta, deleted: true } } as Resource).meta).not.toHaveProperty('deleted');
  });

  it('update takes the request meta: dropping a tag clears it', () => {
    const v1 = store.create(obs({ meta: { tag: [{ code: 'possible-duplicate' }] } })).resource;
    const { tag: _t, ...meta } = v1.meta!;
    expect(store.update({ ...v1, meta }).meta?.tag).toBeUndefined();
  });

  it('update of a missing resource is 404', () => {
    expect(err(() => store.update(obs({ id: 'nope' }))).status).toBe(404);
  });

  it('If-None-Exist returns the existing resource with created: false', () => {
    const identifier = [{ system: 'sys', value: 'val' }];
    const a = store.create(obs({ identifier }), 'identifier=sys|val');
    const b = store.create(obs({ identifier, status: 'amended' }), 'identifier=sys|val');
    expect(a.created).toBe(true);
    expect(b).toEqual({ resource: a.resource, created: false });
    expect(store.create(obs({ identifier }), 'identifier=sys|other').created).toBe(true);
  });

  it('an invalid resource is 400 with element paths (OperationOutcome issues with expressions)', () => {
    const { status: _s, ...noStatus } = obs();
    const e = err(() => store.create(noStatus as Observation));
    expect(e.status).toBe(400);
    expect(e.outcome.issue?.flatMap((i) => i.expression ?? [])).toContain('Observation.status');
    expect(e.outcome.issue?.every((i) => i.details?.text)).toBe(true);
    expect(e.outcome.issue?.every((i) => ['structure', 'invariant', 'value', 'required'].includes(i.code) && i.expression?.length)).toBe(true);
    expect(store.db.prepare('select count(*) n from resources').get()).toEqual({ n: 0 });
  });

  it('meta.compartment follows the Patient CompartmentDefinition', () => {
    const c = store.create({ resourceType: 'Condition', subject: { reference: 'Patient/p1' }, code: { text: 'x' } } as Condition).resource;
    expect(c.meta?.compartment).toEqual([{ reference: 'Patient/p1' }]);
    const p = store.create({ resourceType: 'Patient' } as Patient).resource;
    expect(p.meta?.compartment).toEqual([{ reference: `Patient/${p.id}` }]);
    expect(store.create({ resourceType: 'Medication', code: { text: 'm' } } as Medication).resource.meta?.compartment).toBeUndefined();
    const imm = store.create({ resourceType: 'Immunization', status: 'completed', vaccineCode: { text: 'flu' }, patient: { reference: 'Patient/p3' }, occurrenceDateTime: '2024-01-01' } as Resource).resource;
    expect(imm.meta?.compartment).toEqual([{ reference: 'Patient/p3' }]);
    const ai = store.create({ resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, patient: { reference: 'Patient/a' }, recorder: { reference: 'Patient/b' } } as Resource).resource;
    expect(ai.meta?.compartment).toEqual([{ reference: 'Patient/a' }, { reference: 'Patient/b' }]);
    // Not a compartment param for Observation (focus) and not a Patient (performer Practitioner).
    expect(store.create(obs({ focus: [{ reference: 'Patient/p2' }], performer: [{ reference: 'Practitioner/d' }] })).resource.meta?.compartment).toBeUndefined();
  });

  it('delete then read returns undefined (410 when asked); history keeps the old versions and a delete row; a second delete is a no-op', () => {
    const r = store.create(obs()).resource;
    store.delete('Observation', r.id!);
    expect(store.read('Observation', r.id!)).toBeUndefined();
    expect(err(() => store.readRow('Observation', r.id!, true)).status).toBe(410);
    expect(store.history({ type: 'Observation', id: r.id! }).map((h) => h.json === '')).toEqual([true, false]);
    store.delete('Observation', r.id!);
    expect(store.history({ type: 'Observation', id: r.id! })).toHaveLength(2);
    expect(err(() => store.delete('Observation', 'never')).status).toBe(404);
    expect(err(() => store.update({ ...r, status: 'cancelled' } as Resource)).status).toBe(410);
    expect(store.version('Observation', r.id!, r.meta!.versionId!)?.json).toBe(JSON.stringify(r));
  });

  it('transaction rolls back every write when fn throws, and nests', () => {
    expect(() => store.transaction(() => { store.create(obs()); store.transaction(() => store.create(obs())); throw new Error('boom'); })).toThrow('boom');
    expect(store.db.prepare('select count(*) n from resources').get()).toEqual({ n: 0 });
    expect(store.db.prepare('select count(*) n from history').get()).toEqual({ n: 0 });
    store.transaction(() => store.create(obs()));
    expect(store.db.prepare('select count(*) n from resources').get()).toEqual({ n: 1 });
  });

  it('put (migration) keeps id, versionId, lastUpdated and the given history, and recomputes the compartment', () => {
    const meta = (v: string, t: string) => ({ versionId: v, lastUpdated: t, compartment: [{ reference: 'Patient/medplum' }] });
    const cur = { resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/p1' }, code: { text: 'x' }, meta: meta('v2', '2024-02-01T00:00:00.000Z') } as Condition;
    const old = { ...cur, clinicalStatus: { text: 'active' }, meta: meta('v1', '2024-01-01T00:00:00.000Z') } as Condition;
    store.put(cur, { history: [old, cur] });
    store.put(cur, { history: [old, cur] }); // re-run is a no-op for history
    const r = store.read('Condition', 'c1') as Condition;
    expect(r.meta).toMatchObject({ versionId: 'v2', lastUpdated: '2024-02-01T00:00:00.000Z', compartment: [{ reference: 'Patient/p1' }] });
    expect(store.history({ type: 'Condition', id: 'c1' }).map((h) => h.versionId)).toEqual(['v2', 'v1']);
    expect(store.update({ ...r, code: { text: 'y' } }, 'W/"v2"').meta!.versionId).toMatch(UUID);
    expect(err(() => store.put({ resourceType: 'Condition', subject: { reference: 'Patient/p1' } } as Condition)).status).toBe(400);
  });

  it('a failed inner write inside a transaction rolls back only itself (savepoint)', () => {
    store.transaction(() => {
      store.create(obs());
      expect(() => store.transaction(() => { store.create(obs({ status: 'cancelled' })); throw new Error('inner failed'); })).toThrow('inner failed');
      store.create(obs({ status: 'amended' }));
    });
    expect(store.db.prepare('select json_extract(json, \'$.status\') s from resources order by rid').all().map((x) => (x as { s: string }).s)).toEqual(['final', 'amended']);
    expect(store.db.prepare('select count(*) n from history').get()).toEqual({ n: 2 });
  });

  it('waits for a busy database instead of failing at once', () => {
    expect(store.db.prepare('pragma busy_timeout').get()).toEqual({ timeout: 5000 });
  });
});

describe('Store index format', () => {
  it('a new file gets the index version; a file with another version (or records and none) is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-ver-'));
    const file = join(dir, 'store.db');
    try {
      const s = new Store(file, { terminology: [] });
      s.create({ resourceType: 'Patient' });
      expect((s.db.prepare('pragma user_version').get() as { user_version: number }).user_version).toBe(INDEX_VERSION);
      s.close();
      new Store(file, { terminology: [] }).close(); // same version: opens
      for (const old of [1, 2, 3, 4]) { // 2: before word rows and caseless ContactPoints; 3: before composite, :identifier and :of-type rows; 4: before the concept index and built-in terminology
        const raw = new DatabaseSync(file);
        raw.exec(`pragma user_version = ${old}`);
        raw.close();
        expect(() => new Store(file, { terminology: [] })).toThrow(new RegExp(`search index format ${old}, this version needs ${INDEX_VERSION}: rebuild`));
      }
      const raw0 = new DatabaseSync(file);
      raw0.exec('pragma user_version = 0'); // a file from before versions, with records
      raw0.close();
      expect(() => new Store(file, { terminology: [] })).toThrow(IndexFormatError);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a file indexed under other @medplum/core or @medplum/definitions versions (or none recorded) is reindexed on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-deps-'));
    const file = join(dir, 'store.db');
    try {
      const s = new Store(file, { terminology: [] });
      const id = s.create({ resourceType: 'Patient', name: [{ family: 'Smith' }] }).resource.id!;
      const deps = (s.db.prepare("select value from meta where key = 'index'").get() as { value: string }).value;
      expect(deps).toMatch(/^@medplum\/core \S+, @medplum\/definitions \S+$/);
      s.close();
      // A package upgrade changed a search parameter: rows written before it lack its index rows.
      for (const marker of ["update meta set value = 'old' where key = 'index'", "delete from meta where key = 'index'"]) {
        const raw = new DatabaseSync(file);
        raw.exec(`${marker}; delete from idx; delete from sortkeys; delete from comp; delete from idx_text`);
        raw.close();
        const s2 = new Store(file, { terminology: [] });
        expect(s2.search('Patient', [['name', 'smith']], '').entry?.map((e) => e.resource?.id)).toEqual([id]);
        expect(s2.search('Patient', [['_sort', '-_lastUpdated']], '').entry?.map((e) => e.resource?.id)).toEqual([id]);
        expect((s2.db.prepare("select value from meta where key = 'index'").get() as { value: string }).value).toBe(deps);
        s2.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
