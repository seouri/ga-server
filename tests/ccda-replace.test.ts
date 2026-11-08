import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Mock, test, vi } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Basic, Composition, Encounter, Identifier, Immunization, Observation, Provenance, Resource } from '@medplum/fhirtypes';
import { ccdaDate, convertCcdaLocal, custodian, importPath, repair } from '../src/ccda.ts';
import { replaceCcda } from '../src/ccda-replace.ts';
import type { GaConfig } from '../src/config.ts';
import { storeDocument } from '../src/document.ts';
import { COMPARTMENT, DUP_OF, importResources } from '../src/engine.ts';
import { ARRIVED, hasTag, sha256 } from '../src/identity.ts';
import { whatsNew } from '../src/whats-new.ts';
import { onStore } from './temp-store.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
// The Epic-style fixture and its Microsoft conversion, with the two known corrections: a lab written with a leading dot (".11",
// which Microsoft read as 11) and a vaccine not given (negationInd, which Microsoft stored as completed).
const XML = readFileSync(join(FIXTURES, 'ccda-epic-style.xml'), 'utf8')
  .replace('<value xsi:type="REAL" value="1.1"/>', '<value xsi:type="PQ" value=".11" unit="mg/dL"/>')
  .replace('negationInd="false">', 'negationInd="true">');
// Its Coverage (no status, beneficiary or payor) was refused on the Microsoft path: left out.
const MS = (JSON.parse(readFileSync(join(FIXTURES, 'ccda-epic-style.ms.json'), 'utf8')) as Resource[]).filter((r) => r.resourceType !== 'Coverage').map((r) =>
  (r as { identifier?: Identifier[] }).identifier?.[0]?.value === 'EX-RES-2' ? ({ ...r, valueQuantity: { value: 11, unit: 'mg/dL' } } as Resource) : r);
const CCDA = 'urn:ga-server:id:ccda';
const ENC_ID = { system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: 'EX-ENC-1' };
const idsOf = (r: Resource): Identifier[] => [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat();
const ccdaIds = (r: Resource) => idsOf(r).filter((i) => i.system === CCDA).map((i) => i.value);
const hasId = (r: Resource, value: string) => idsOf(r).some((i) => i.value === value);

type World = { client: MedplumClient; pid: string; cfg: GaConfig; configFile: string; file: string; backup: Mock<() => Promise<void>> };

// A patient whose C-CDA document GA imported with the Microsoft converter (its records keyed the Microsoft way), stored or not.
async function world(client: MedplumClient, o: { store?: boolean; ehiVisit?: boolean; ehiLab?: boolean } = {}): Promise<World> {
  const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
  const dir = mkdtempSync(join(tmpdir(), 'ga-replace-'));
  const file = join(dir, 'DOC0001.XML');
  writeFileSync(file, XML);
  const configFile = join(dir, 'config.json');
  const cfg: GaConfig = { patientId: pid, converterUrl: 'http://127.0.0.1:9/' };
  writeFileSync(configFile, JSON.stringify(cfg));
  if (o.ehiVisit) {
    // The same visit from an EHI export, which the Microsoft-era C-CDA import linked to by its Epic id.
    await importResources(client, [{ resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
      subject: { reference: `Patient/${pid}` }, identifier: [{ system: 'urn:ga-server:id:ehi:999', value: 'PAT_ENC|1' }, ENC_ID] } as Encounter],
    { kind: 'ehi', file: '/ehi', date: '2024-01-01', writer: 'importer' }, pid, 'ehi');
  }
  if (o.ehiLab) {
    // The leading-dot lab from an EHI export, right (0.11) at the same time: the Microsoft record (11) was flagged against it.
    const lab = convertCcdaLocal(XML).resources.find((r) => hasId(r, 'EX-RES-2')) as Observation;
    await importResources(client, [{ resourceType: 'Observation', status: 'final', category: lab.category, code: lab.code, effectiveDateTime: lab.effectiveDateTime,
      valueQuantity: lab.valueQuantity, subject: { reference: `Patient/${pid}` }, identifier: [{ system: 'urn:ga-server:id:ehi:999', value: 'ORDER_RESULTS|1' }] } as Observation],
    { kind: 'ehi', file: '/ehi', date: '2024-01-01', writer: 'importer' }, pid, 'ehi');
  }
  const fileHash = o.store === false ? sha256(XML) : (await storeDocument(client, file, pid, 'application/xml')).fileHash;
  const r = await importResources(client, repair(structuredClone(MS), XML), { kind: 'ccda', file, org: custodian(XML), date: ccdaDate(XML), writer: 'importer' }, pid, fileHash);
  expect(r.invalid).toBe(0);
  return { client, pid, cfg, configFile, file, backup: vi.fn<() => Promise<void>>(async () => undefined) };
}

const records = async (client: MedplumClient, pid: string): Promise<Resource[]> => {
  const out: Resource[] = [];
  for (const [type, field] of [...Object.entries(COMPARTMENT), ['Basic', 'subject']]) {
    out.push(...(await client.searchResources(type as 'Observation', { [field]: `Patient/${pid}`, _count: '1000' }, { cache: 'no-cache' })));
  }
  return out.filter((r) => !idsOf(r).some((i) => i.system === 'urn:ga-server:id:file')); // the stored document itself
};
const snapshot = async (w: World) => (await records(w.client, w.pid)).map((r) => `${r.resourceType}/${r.id}@${r.meta?.versionId}`).sort();
const run = (w: World, yes: boolean, after?: (step: string) => void) => replaceCcda(w.client, w.cfg, { yes, log: () => undefined, configFile: w.configFile, backup: w.backup, after });
const flag = (w: World) => (JSON.parse(readFileSync(w.configFile, 'utf8')) as GaConfig).ccdaConverter;
const byType = (rs: Resource[]) => rs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.resourceType]: (m[r.resourceType] ?? 0) + 1 }), {});

// Every C-CDA record left is one this command wrote, or an old one it reported kept; no two records share a C-CDA key.
async function clean(w: World, kept = 0) {
  const rs = (await records(w.client, w.pid)).filter((r) => ccdaIds(r).length);
  expect(rs.filter((r) => !hasTag(r, 'ccda-replace'))).toHaveLength(kept);
  const keys = rs.flatMap(ccdaIds);
  expect(keys.length).toBe(new Set(keys).size);
  // A re-import of the document on the new path finds everything: nothing created, nothing refused.
  expect(await importPath(w.client, { ...w.cfg, ccdaConverter: 'medplum' }, w.file, w.pid)).toMatchObject({ created: 0, invalid: 0, possibleDuplicates: 0 });
}

test('dry run changes nothing', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client, { ehiVisit: true });
    const before = await snapshot(w);
    const r = await run(w, false);
    expect(await snapshot(w)).toEqual(before);
    expect(flag(w)).toBeUndefined();
    expect(w.backup).not.toHaveBeenCalled();
    expect(r.documents).toBe(1);
    expect(r.stripped).toEqual({ Encounter: 1 });
    expect(r.deleted.Observation).toBeGreaterThan(0);
    expect(r.dangling).toBe(0);
  });
});

test('re-import after replace is a no-op; the corrected values land', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    const r = await run(w, true);
    expect(w.backup).toHaveBeenCalledOnce();
    expect(r.dangling).toBe(0);
    expect(r.deleted.Immunization).toBe(1);
    await clean(w);
    const obs = await client.searchResources('Observation', { subject: `Patient/${w.pid}`, _count: '1000' });
    expect(obs.find((x) => hasId(x, 'EX-RES-2'))?.valueQuantity?.value).toBe(0.11);
    const [imm] = await client.searchResources('Immunization', { patient: `Patient/${w.pid}` });
    expect((imm as Immunization).status).toBe('not-done');
    expect(await client.searchResources('Immunization', { patient: `Patient/${w.pid}` })).toHaveLength(1);
    expect((await records(client, w.pid)).filter((x) => hasTag(x, 'possible-duplicate'))).toEqual([]);
  });
});

test('a merged record keeps its other sources', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client, { ehiVisit: true });
    const [before] = await client.searchResources('Encounter', { subject: `Patient/${w.pid}` });
    expect(idsOf(before).map((i) => i.system)).toEqual(expect.arrayContaining(['urn:ga-server:id:ehi:999', CCDA])); // linked on the Microsoft path
    const oldKey = ccdaIds(before)[0];
    const r = await run(w, true);
    expect(r.stripped).toEqual({ Encounter: 1 });
    const visits = await client.searchResources('Encounter', { subject: `Patient/${w.pid}` });
    expect(visits).toHaveLength(1);
    expect(visits[0].id).toBe(before.id);
    expect(idsOf(visits[0]).some((i) => i.system === 'urn:ga-server:id:ehi:999')).toBe(true);
    expect(ccdaIds(visits[0])).toEqual([`Encounter|${ENC_ID.system}|${ENC_ID.value}`]); // the new key (id alone), not the Microsoft one
    expect(oldKey).not.toBe(ccdaIds(visits[0])[0]);
    await clean(w);
  });
});

test('protected records are kept: only their C-CDA identifier is replaced', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    const conds = await client.searchResources('Condition', { subject: `Patient/${w.pid}` });
    const dx = conds.find((c) => hasId(c, 'EX-VISITDX-1')) as Resource;
    const prob = conds.find((c) => hasId(c, 'EX-PROBLEM-1')) as Resource;
    const conflict = await client.updateResource({ ...dx, meta: { ...dx.meta, tag: [...(dx.meta?.tag ?? []), { system: 'urn:ga-server:tag', code: 'source-conflict' }] } });
    const agent = await client.updateResource({ ...prob, meta: { ...prob.meta, tag: [...(prob.meta?.tag ?? []).filter((t) => t.code !== 'writer-importer'), { system: 'urn:ga-server:tag', code: 'writer-agent' }] } });
    const r = await run(w, true);
    expect(r.kept).toEqual({ Condition: 2 });
    const after = await client.searchResources('Condition', { subject: `Patient/${w.pid}` });
    expect(after).toHaveLength(2);
    for (const p of [conflict, agent]) {
      const now = after.find((c) => c.id === p.id) as Resource;
      const { meta: _a, identifier: _b, ...body } = now as Resource & { identifier?: unknown };
      const { meta: _c, identifier: _d, ...was } = p as Resource & { identifier?: unknown };
      expect(body).toEqual(was); // its body untouched
      expect(ccdaIds(now)).toHaveLength(1);
    }
    // Whatever points at a visit diagnosis or problem points at a protected record.
    const condRefs = (await records(client, w.pid)).flatMap((x) => JSON.stringify(x).match(/Condition\/[\w-]+/g) ?? []);
    expect(new Set(condRefs).size).toBeGreaterThan(0);
    for (const ref of condRefs) expect([conflict.id, agent.id]).toContain(ref.split('/')[1]);
    await clean(w, 2);
  });
});

test('arrival times are preserved; gains take the document\'s import time', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    // The document was imported long ago.
    for (const r of (await records(client, w.pid)).filter((x) => ccdaIds(x).length)) {
      await client.updateResource({ ...r, extension: [...((r as { extension?: { url: string }[] }).extension ?? []).filter((e) => e.url !== ARRIVED), { url: ARRIVED, valueInstant: '2020-01-01T00:00:00.000Z' }] } as Resource);
    }
    const since = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
    const look = () => whatsNew(client, w.pid, Promise.resolve([]), { since, fetch: (async () => { throw new Error('offline'); }) as typeof fetch, dir: mkdtempSync(join(tmpdir(), 'ga-wn-')) });
    const before = await look();
    await run(w, true);
    const after = await look();
    expect(after.tally).toEqual(before.tally);
    expect(after.items.filter((i) => i.kind !== 'health maintenance')).toEqual([]);
    const arrivals = (await records(client, w.pid)).filter((x) => ccdaIds(x).length).map((x) => (x as { extension?: { url: string; valueInstant?: string }[] }).extension?.find((e) => e.url === ARRIVED)?.valueInstant);
    expect(new Set(arrivals)).toEqual(new Set(['2020-01-01T00:00:00.000Z']));
  });
});

test('references are repointed', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    const [report] = await client.searchResources('DiagnosticReport', { subject: `Patient/${w.pid}` });
    const lab = (await client.searchResources('Observation', { subject: `Patient/${w.pid}`, _count: '1000' })).find((o) => hasId(o, 'EX-RES-1')) as Observation;
    // A recorded follow-up as record_followup writes it (src/tools/maintenance.ts): the Basic, and a Provenance naming the report it quotes.
    const followup = await client.createResource<Basic>({ resourceType: 'Basic', subject: { reference: `Patient/${w.pid}` }, created: '2026-01-01', code: { coding: [{ system: 'urn:ga-server:reminder', code: 'followup' }] },
      extension: [{ url: 'urn:ga-server:ext:topic', valueString: 'x' }, { url: 'urn:ga-server:ext:due', valueDate: '2027-01-01' }, { url: 'urn:ga-server:ext:quote', valueString: 'q' }] });
    const prov = await client.createResource<Provenance>({ resourceType: 'Provenance', target: [{ reference: `Basic/${followup.id}` }], recorded: new Date().toISOString(),
      activity: { coding: [{ system: 'urn:ga-server:activity', code: 'followup' }] }, agent: [{ who: { display: 'Claude Code' } }], reason: [{ text: 'x' }],
      entity: [{ role: 'source', what: { reference: `DiagnosticReport/${report.id}` } }] });
    const pdf = await client.createResource<Observation>({ resourceType: 'Observation', status: 'final', code: { text: 'Glucose' }, subject: { reference: `Patient/${w.pid}` },
      identifier: [{ system: 'urn:ga-server:id:pdf', value: 'p1' }], meta: { tag: [{ system: 'urn:ga-server:tag', code: 'possible-duplicate' }] },
      extension: [{ url: DUP_OF, valueReference: { reference: `Observation/${lab.id}` } }] });
    const r = await run(w, true);
    expect(r.repointed).toBeGreaterThanOrEqual(2);
    expect(r.dangling).toBe(0);
    const [newReport] = await client.searchResources('DiagnosticReport', { subject: `Patient/${w.pid}` });
    const newLab = (await client.searchResources('Observation', { subject: `Patient/${w.pid}`, _count: '1000' })).find((o) => hasId(o, 'EX-RES-1') && hasTag(o, 'ccda-replace')) as Observation;
    expect(newReport.id).not.toBe(report.id);
    expect((await client.readResource('Provenance', prov.id as string)).entity?.[0].what.reference).toBe(`DiagnosticReport/${newReport.id}`);
    expect((await client.readResource('Provenance', prov.id as string)).target[0].reference).toBe(`Basic/${followup.id}`);
    const dup = (await client.readResource('Observation', pdf.id as string)).extension?.filter((e) => e.url === DUP_OF).map((e) => e.valueReference?.reference);
    expect(dup).toEqual([`Observation/${newLab.id}`]);
    await clean(w);
  });
});

test('a record with no counterpart that something points at is kept', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    // Microsoft-era records the new path does not continue, one pointed at by a follow-up, one not: both kept (never less).
    const old = (value: string) => client.createResource<Observation>({ resourceType: 'Observation', status: 'final', code: { text: 'Only Microsoft kept this' }, valueString: value,
      subject: { reference: `Patient/${w.pid}` }, identifier: [{ system: 'urn:oid:2.25.77', value }, { system: CCDA, value: `Observation|urn:oid:2.25.77|${value}|x` }],
      meta: { source: w.file, tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] } });
    const pointed = await old('a');
    const alone = await old('b');
    const followup = await client.createResource<Basic>({ resourceType: 'Basic', subject: { reference: `Patient/${w.pid}` }, code: { text: 'x' },
      extension: [{ url: 'urn:x', valueReference: { reference: `Observation/${pointed.id}` } }] });
    const r = await run(w, true);
    expect(r.kept).toEqual({ Observation: 2 });
    expect(r.dangling).toBe(0);
    for (const k of [pointed, alone]) expect((await client.readResource('Observation', k.id as string)).meta?.versionId).toBe(k.meta?.versionId);
    expect((await client.readResource('Basic', followup.id as string)).extension?.[0].valueReference?.reference).toBe(`Observation/${pointed.id}`);
    expect(flag(w)).toBe('medplum');
    await clean(w, 2);
  });
});

test('an old record flagged against the very record the new path merges into: one record, no flag left', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client, { ehiLab: true });
    const flagged = (await records(client, w.pid)).filter((x) => hasTag(x, 'possible-duplicate'));
    expect(flagged.map((x) => (hasId(x, 'EX-RES-2') ? 'old' : 'ehi')).sort()).toEqual(['ehi', 'old']); // the Microsoft path's flag
    const r = await run(w, true);
    expect(r.dangling).toBe(0);
    const labs = (await records(client, w.pid)).filter((x) => x.resourceType === 'Observation' && (hasId(x, 'EX-RES-2') || hasId(x, 'ORDER_RESULTS|1')));
    expect(labs).toHaveLength(1);
    expect(idsOf(labs[0]).some((i) => i.system === 'urn:ga-server:id:ehi:999')).toBe(true);
    expect(hasTag(labs[0], 'possible-duplicate')).toBe(false);
    expect((labs[0] as Observation).extension?.filter((e) => e.url === DUP_OF)).toEqual([]);
    expect((labs[0] as Observation).valueQuantity?.value).toBe(0.11);
    await clean(w);
  });
});

test('a Microsoft-era Composition stored with no patient is replaced too', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    const [comp] = await client.searchResources('Composition', { subject: `Patient/${w.pid}` });
    const { subject: _, ...rest } = comp as Composition;
    await client.updateResource(rest as Composition);
    expect(await client.searchResources('Composition', { subject: `Patient/${w.pid}` })).toHaveLength(0);
    const r = await run(w, true);
    expect(r.deleted.Composition).toBe(1);
    await expect(client.readResource('Composition', comp.id as string)).rejects.toThrow();
    expect([...(await client.searchResources('Composition', { subject: `Patient/${w.pid}` }))].map((c) => hasTag(c, 'ccda-medplum'))).toEqual([true]);
    expect(flag(w)).toBe('medplum');
    await clean(w);
  });
});

test('refuses when a C-CDA record\'s source document is not stored', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client, { store: false });
    const before = await snapshot(w);
    await expect(run(w, true)).rejects.toThrow(/not stored \(DOC0001\.XML\)/);
    expect(await snapshot(w)).toEqual(before);
    expect(w.backup).not.toHaveBeenCalled();
    expect(flag(w)).toBeUndefined();
  });
});

test('refuses when the backup fails, before any write', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client, { ehiVisit: true });
    const before = await snapshot(w);
    w.backup.mockRejectedValueOnce(new Error('no backup'));
    await expect(run(w, true)).rejects.toThrow('no backup');
    expect(await snapshot(w)).toEqual(before);
    expect(flag(w)).toBeUndefined();
  });
});

test('a rerun after a crash finishes the replace', async () => {
  await onStore(async ({ client }) => {
    const reference = await world(client, { ehiVisit: true });
    await run(reference, true);
    const want = byType(await records(client, reference.pid));
    for (const step of ['strip', 'document', 'write', 'arrival', 'protected', 'repoint', 'deleted']) {
      const w = await world(client, { ehiVisit: true });
      await expect(run(w, true, (s) => { if (s === step) throw new Error(`crash after ${s}`); })).rejects.toThrow(`crash after ${step}`);
      expect(flag(w)).toBeUndefined();
      const r = await run(w, true);
      expect(r.dangling, step).toBe(0);
      expect(byType(await records(client, w.pid)), step).toEqual(want);
      expect(flag(w)).toBe('medplum');
      await clean(w);
    }
  });
}, 120_000);

test('sets ccdaConverter to medplum only after success; a second run changes nothing', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    await run(w, false);
    expect(flag(w)).toBeUndefined();
    await expect(run(w, true, (s) => { if (s === 'repoint') throw new Error('crash'); })).rejects.toThrow('crash');
    expect(flag(w)).toBeUndefined();
    await run(w, true);
    expect(flag(w)).toBe('medplum');
    const before = await snapshot(w);
    expect(await run({ ...w, cfg: { ...w.cfg, ccdaConverter: 'medplum' } }, true)).toMatchObject({ deleted: {}, created: {}, documents: 0 });
    expect(await snapshot(w)).toEqual(before);
  });
});
