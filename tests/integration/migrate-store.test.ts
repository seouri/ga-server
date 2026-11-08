// ga migrate-store end to end: the long-lived throwaway ga-test project (synthetic records only, emptied before and after)
// copied into temp SQLite files. Never the user's record or config; services are a fake controller (never docker).
import { GA_STORE_TYPES } from '../../src/store-serve.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { AuditEvent, Basic, Condition, DocumentReference, Encounter, Medication, MedicationRequest, Observation, Provenance, Resource } from '@medplum/fhirtypes';
import { afterAll, expect, test } from 'vitest';
import { getClient } from '../../src/config.ts';
import { BINARY_URL } from '../../src/share/scope.ts';
import { migrateStore, type Services } from '../../src/migrate-store.ts';
import { Store } from '../../src/store/store.ts';
import { emptyTestProject, testProject } from './helpers.ts';

const MARK = `Synthetic migrate marker ${randomUUID()}`;
const BYTES = `synthetic file ${randomUUID()}`;
const saved = process.env.GA_STORE;
delete process.env.GA_STORE; // the source is Medplum
afterAll(() => { if (saved !== undefined) process.env.GA_STORE = saved; });

const fakeServices = () => {
  const calls: string[] = [];
  const s: Services = { stop: async () => { calls.push('stop'); }, start: async (sw) => { calls.push(`start:${sw}`); }, commands: { stop: 'stop', start: () => 'start' } };
  return { s, calls };
};
const refs = (r?: Resource) => (r?.meta?.compartment ?? []).map((c) => c.reference!).filter((x) => x.startsWith('Patient/')).sort();

async function seed(c: MedplumClient, pid: string): Promise<Resource[]> {
  const P = { reference: `Patient/${pid}` };
  const obs = await c.createResource<Observation>({ resourceType: 'Observation', status: 'preliminary', identifier: [{ system: 'urn:ga-test:migrate', value: 'AbC-1' }], code: { text: MARK }, subject: P, effectiveDateTime: '2024-03-01',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], valueQuantity: { value: 5, unit: 'mg/dL' } });
  const obs2 = await c.updateResource<Observation>({ ...obs, status: 'final' });
  // Parity probes (verify.ts): a timed value late in the day (another UTC day) and a period across 2024-03-01.
  const timed = await c.createResource<Observation>({ resourceType: 'Observation', status: 'final', code: { text: `${MARK} timed` }, subject: P, effectiveDateTime: '2024-03-01T23:30:00-05:00' });
  const period = await c.createResource<Observation>({ resourceType: 'Observation', status: 'final', code: { text: `${MARK} period` }, subject: P, effectivePeriod: { start: '2024-02-28', end: '2024-03-02' } });
  const med = await c.createResource<Medication>({ resourceType: 'Medication', code: { text: `${MARK} drug` } });
  const mr = await c.createResource<MedicationRequest>({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: P, medicationReference: { reference: `Medication/${med.id}` } });
  const mr2 = await c.updateResource<MedicationRequest>({ ...mr, status: 'stopped' });
  const bin = await c.createBinary({ data: BYTES, contentType: 'text/plain' });
  const doc = await c.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', subject: P, date: '2024-03-02T00:00:00Z',
    content: [{ attachment: { contentType: 'text/plain', url: `Binary/${bin.id}`, title: 'synthetic.txt' } }] });
  const prov = await c.createResource<Provenance>({ resourceType: 'Provenance', target: [{ reference: `Observation/${obs.id}` }], recorded: '2024-03-01T00:00:00Z', agent: [{ who: { display: 'synthetic' } }] });
  const enc = await c.createResource<Encounter>({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: P, period: { start: '2024-03-01' } });
  const cond = await c.createResource<Condition>({ resourceType: 'Condition', subject: P, encounter: { reference: `Encounter/${enc.id}` }, code: { text: `${MARK} condition` },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }] });
  const audit = await c.createResource<AuditEvent>({ resourceType: 'AuditEvent', type: { code: 'rest' }, recorded: '2024-03-03T00:00:00Z', agent: [{ requestor: false, who: { display: 'synthetic' } }],
    source: { observer: { display: 'ga' } }, entity: [{ what: P }], meta: { tag: [{ system: 'urn:ga-server:share', code: randomUUID() }] } });
  const basic = await c.createResource<Basic>({ resourceType: 'Basic', code: { coding: [{ system: 'urn:ga-server:reminder', code: 'not-now' }] }, subject: P });
  return [obs2, timed, period, med, mr2, doc, prov, enc, cond, audit, basic];
}

// Medplum is the source: the Medplum run covers it (GA_STORE=sqlite has no Medplum config here).
test.skipIf(saved === 'sqlite')('migrate-store copies the record, verifies it, and switches only on a clean gate', { timeout: 600_000 }, async () => {
  const { dir, cfg } = await testProject();
  const client = await getClient(cfg);
  const tmp = mkdtempSync(join(tmpdir(), 'ga-migrate-store-'));
  try {
    await emptyTestProject(client);
    const seeded = await seed(client, cfg.patientId);
    const doc = seeded.find((r) => r.resourceType === 'DocumentReference') as DocumentReference;
    const binId = BINARY_URL.exec(doc.content[0].attachment.url ?? '')![1]; // Medplum answers with a signed /storage/<id>/... link

    // 1. Clean run with --yes: copied, verified, switched.
    const cfgFile = join(tmp, 'config.json'); // a copy of the throwaway config: the switch writes here
    writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
    const file = join(tmp, 'a', 'ga.db'), reportFile = join(tmp, 'a', 'report.json');
    const { s, calls } = fakeServices();
    const lines: string[] = [];
    const { report, switched } = await migrateStore({ file, configFile: cfgFile, reportFile, yes: true, allowSwitch: true, servicesStopped: false, services: s, cfg, log: (l) => lines.push(l) });
    expect(report.gate?.problems, lines.join('\n')).toEqual([]);
    expect(switched).toBe(true);
    expect(JSON.parse(readFileSync(cfgFile, 'utf8'))).toEqual({ ...cfg, store: 'sqlite' });
    expect(calls).toEqual(['stop', 'start:true']);
    expect(report.types.MedicationRequest.copied).toBeGreaterThanOrEqual(1);
    expect(report.replay.length).toBeGreaterThan(50);

    const store = new Store(file, { types: GA_STORE_TYPES });
    try {
      for (const r of seeded) {
        const m = await client.readResource(r.resourceType, r.id!, { cache: 'no-cache' });
        const got = store.read(r.resourceType, r.id!);
        expect(got?.meta?.versionId, `${r.resourceType}`).toBe(m.meta?.versionId);
        expect(got?.meta?.lastUpdated).toBe(m.meta?.lastUpdated);
        expect(refs(got)).toEqual(refs(m));
      }
      const mr = seeded.find((r) => r.resourceType === 'MedicationRequest')!;
      expect(store.history({ type: 'MedicationRequest', id: mr.id! }).map((v) => v.versionId).sort()).toEqual(
        ((await client.readHistory('MedicationRequest', mr.id!)).entry ?? []).map((e) => e.resource?.meta?.versionId).sort());
      expect(store.history({ type: 'MedicationRequest', id: mr.id! })).toHaveLength(2);
      expect(store.history({ type: 'Observation', id: seeded[0].id! })).toHaveLength(1); // current version only for types GA reads no history of
      expect((store.read('DocumentReference', doc.id!) as DocumentReference | undefined)?.content?.[0]?.attachment?.url ?? '').toBe(`Binary/${binId}`);
      expect(await new Response(store.openBinary(binId)!.stream()).text()).toBe(BYTES);
      // Token case (If-None-Exist dedupes on identifiers): the store matches exactly what Medplum matches.
      for (const v of ['AbC-1', 'abc-1', 'ABC-1']) {
        const q = { identifier: `urn:ga-test:migrate|${v}` };
        expect(store.search('Observation', Object.entries(q), 'http://x/').entry?.length ?? 0, v).toBe((await client.searchResources('Observation', q, { cache: 'no-cache' })).length);
      }
      // Every stored resource's patient compartment equals Medplum's.
      for (const row of store.db.prepare('select type, id from resources').all() as { type: string; id: string }[]) {
        expect(refs(store.read(row.type, row.id)), `${row.type}`).toEqual(refs(await client.readResource(row.type as 'Patient', row.id, { cache: 'no-cache' })));
      }
    } finally { store.close(); }

    // The report holds counts and categories only.
    const text = readFileSync(reportFile, 'utf8');
    for (const secret of [cfg.patientId, MARK, BYTES, binId, ...seeded.map((r) => r.id!)]) expect(text).not.toContain(secret);

    // 2. A forced compartment mismatch fails the gate and leaves the config as it was, even with --yes.
    writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
    const before = readFileSync(cfgFile, 'utf8');
    const cond = seeded.find((r) => r.resourceType === 'Condition')!;
    const bad = await migrateStore({
      file: join(tmp, 'b', 'ga.db'), configFile: cfgFile, reportFile: join(tmp, 'b', 'report.json'), yes: true, allowSwitch: true, servicesStopped: false, services: fakeServices().s, cfg, log: () => undefined,
      hooks: { afterCopy: (st) => {
        const r = st.read('Condition', cond.id!)!;
        st.db.prepare('update resources set json = ? where type = ? and id = ?').run(JSON.stringify({ ...r, meta: { ...r.meta, compartment: [{ reference: 'Patient/someone-else' }] } }), 'Condition', cond.id!);
      } },
    });
    expect(bad.switched).toBe(false);
    expect(bad.report.compartmentMismatches).toEqual({ Condition: 1 });
    expect(bad.report.gate?.problems).toContain('1 compartment mismatch with Medplum (Condition: 1)'); // the replay sees it too
    expect(readFileSync(cfgFile, 'utf8')).toBe(before);
  } finally {
    await emptyTestProject(client);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
