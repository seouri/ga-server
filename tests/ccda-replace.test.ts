import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Mock, test, vi } from 'vitest';
import { type MedplumClient, OperationOutcomeError, serverError } from '@medplum/core';
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
const IMM_ID = { system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.768179', value: 'EX-IMM-1' };
const ENC_ID = { system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: 'EX-ENC-1' };
const idsOf = (r: Resource): Identifier[] => [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat();
const ccdaIds = (r: Resource) => idsOf(r).filter((i) => i.system === CCDA).map((i) => i.value);
const hasId = (r: Resource, value: string) => idsOf(r).some((i) => i.value === value);

type World = { client: MedplumClient; pid: string; cfg: GaConfig; configFile: string; file: string; backup: Mock<() => Promise<void>> };

// A patient whose C-CDA document GA imported with the Microsoft converter (its records keyed the Microsoft way), stored or not.
async function world(client: MedplumClient, o: { store?: boolean; ehiVisit?: boolean; ehiLab?: boolean; ehiImm?: string } = {}): Promise<World> {
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
  if (o.ehiImm) {
    // The vaccine from an EHI export, rightly not given, sharing the Epic id with the negated C-CDA entry; ehiImm is its source date.
    await importResources(client, [{ resourceType: 'Immunization', status: 'not-done', statusReason: { text: 'declined' }, lotNumber: 'EHI-LOT',
      vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '140' }] }, occurrenceDateTime: '2023-10-15',
      patient: { reference: `Patient/${pid}` }, identifier: [{ system: 'urn:ga-server:id:ehi:999', value: 'IMMUNE|1' }, IMM_ID] } as Immunization],
    { kind: 'ehi', file: '/ehi', date: o.ehiImm, writer: 'importer' }, pid, 'ehi');
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
const run = (w: World, yes: boolean, after?: (step: string) => void | Promise<void>, client = w.client) => replaceCcda(client, w.cfg, { yes, log: () => undefined, configFile: w.configFile, backup: w.backup, after });
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
    const b = await old('b'); // also protected: it keeps its C-CDA identifier
    const alone = await client.updateResource<Observation>({ ...b, meta: { ...b.meta, tag: [...(b.meta?.tag ?? []), { system: 'urn:ga-server:tag', code: 'source-conflict' }] } });
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

test('a record of another source the new path links to, protected while the run is between steps, is never filled from the old record', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client, { ehiLab: true });
    const old = (await records(client, w.pid)).find((x) => hasId(x, 'EX-RES-2')) as Observation;
    expect(old.category).toBeDefined();
    let id = '';
    await run(w, true, async (step) => {
      if (step !== 'protected') return;
      // A person edits the linked EHI lab (taking its category off) after the match, before the fill.
      const { category: _, ...ehi } = (await records(client, w.pid)).find((x) => hasId(x, 'ORDER_RESULTS|1')) as Observation;
      id = ehi.id as string;
      await client.updateResource({ ...ehi, meta: { ...ehi.meta, tag: [...(ehi.meta?.tag ?? []), { system: 'urn:ga-server:tag', code: 'person-edited' }] } });
    });
    expect(id).not.toBe('');
    expect(await client.readResource('Observation', id)).not.toHaveProperty('category');
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
    const opts = { ehiVisit: true, ehiImm: '2024-01-01' }; // two records another source holds: a crash can fall between their strips
    const reference = await world(client, opts);
    const deletes = Object.values((await run(reference, false)).deleted).reduce((a, b) => a + b, 0);
    await run(reference, true);
    const want = byType(await records(client, reference.pid));
    const crash = (step: string, nth = 1) => { let n = 0; return (s: string) => { if (s === step && ++n === nth) throw new Error(`crash after ${s}`); }; };
    const cases: [string, (w: World) => Promise<unknown>][] = [
      ...['stripped', 'strip', 'document', 'write', 'arrival', 'protected', 'repoint', 'deleted'].map((st) => [st, (w: World) => run(w, true, crash(st))] as [string, (w: World) => Promise<unknown>]),
      ['after the last delete (a Composition)', (w) => run(w, true, crash('deleted', deletes))],
      // inside the import: its fifth write fails
      ['inside the import', (w) => { let n = 0; const bad = new Proxy(client, { get: (t, p) => (p === 'createResource' ? (r: Resource) => { if (++n === 5) throw new Error('crash after import write'); return t.createResource(r); } : ((v) => (typeof v === 'function' ? v.bind(t) : v))(Reflect.get(t, p, t))) }); return run(w, true, undefined, bad); }],
    ];
    for (const [name, crashRun] of cases) {
      const w = await world(client, opts);
      await expect(crashRun(w), name).rejects.toThrow(/crash after/);
      expect(flag(w), name).toBeUndefined();
      const r = await run(w, true);
      expect(r.dangling, name).toBe(0);
      expect(byType(await records(client, w.pid)), name).toEqual(want);
      expect(flag(w), name).toBe('medplum');
      expect((await client.searchResources('Immunization', { patient: `Patient/${w.pid}` })).map((i) => i.status), name).toEqual(['not-done']);
      await clean(w);
    }
  });
}, 240_000);

test('a merged record C-CDA wrote last takes the new path\'s body; one another source wrote last is untouched', async () => {
  await onStore(async ({ client }) => {
    // The EHI vaccine (not given) and visit were overwritten by the newer Microsoft-era document (completed; the CPT code as class).
    const w = await world(client, { ehiVisit: true, ehiImm: '2024-01-01' });
    const [imm0] = await client.searchResources('Immunization', { patient: `Patient/${w.pid}` });
    const [enc0] = await client.searchResources('Encounter', { subject: `Patient/${w.pid}` });
    expect([imm0.status, hasTag(imm0, 'src-ccda'), hasTag(enc0, 'src-ccda')]).toEqual(['completed', true, true]);
    await run(w, true);
    const imms = await client.searchResources('Immunization', { patient: `Patient/${w.pid}` });
    expect(imms.map((i) => [i.id, i.status])).toEqual([[imm0.id, 'not-done']]);
    const encs = await client.searchResources('Encounter', { subject: `Patient/${w.pid}` });
    const neu = convertCcdaLocal(XML).resources.find((r) => r.resourceType === 'Encounter') as Encounter;
    expect(encs.map((e) => e.id)).toEqual([enc0.id]);
    expect([encs[0].status, encs[0].class, encs[0].type]).toEqual([neu.status, neu.class, neu.type]);
    expect(idsOf(encs[0]).some((i) => i.system === 'urn:ga-server:id:ehi:999')).toBe(true);
    await clean(w);

    // A newer EHI export: the Microsoft-era import only linked (an older source), so the EHI body stays as it was.
    const v = await world(client, { ehiImm: '2030-01-01' });
    const [before] = await client.searchResources('Immunization', { patient: `Patient/${v.pid}` });
    expect(hasTag(before, 'src-ccda')).toBe(false);
    await run(v, true);
    const [after] = await client.searchResources('Immunization', { patient: `Patient/${v.pid}` });
    const body = (r: Resource) => { const { meta: _m, identifier: _i, extension: _e, ...rest } = r as Resource & { identifier?: unknown; extension?: unknown }; return rest; };
    expect(after.id).toBe(before.id);
    expect(body(after)).toEqual(body(before));
    expect(after.lotNumber).toBe('EHI-LOT');
    await clean(v);
  });
});

test('a merged record the new path does not link again stops the run before any delete, on every rerun', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    // Held from an EHI export and (by the Microsoft path) from the document, with nothing the new path links it by.
    await client.createResource<Observation>({ resourceType: 'Observation', status: 'final', code: { text: 'Only linked by Microsoft' }, valueString: 'x', subject: { reference: `Patient/${w.pid}` },
      identifier: [{ system: 'urn:ga-server:id:ehi:999', value: 'X|1' }, { system: CCDA, value: 'Observation|urn:oid:2.25.78|m|x' }], meta: { source: w.file, tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] } });
    const old = (await records(client, w.pid)).filter((x) => ccdaIds(x).length && !idsOf(x).some((i) => i.system === 'urn:ga-server:id:ehi:999'));
    for (let i = 0; i < 2; i++) {
      await expect(run(w, true)).rejects.toThrow(/1 records another source also holds were not linked again by the new converter \(Observation 1\).*restore the backup made before the first/);
      expect(flag(w)).toBeUndefined();
      for (const r of old) await expect(client.readResource(r.resourceType as 'Observation', r.id as string)).resolves.toBeTruthy();
    }
  });
});

test('a reference written while the run is between steps is repointed, not left dangling', async () => {
  await onStore(async ({ client }) => {
    // A follow-up recorded after the repoint (record_followup does not take the import lock), and another during the deletes.
    const w = await world(client);
    const [old] = await client.searchResources('DiagnosticReport', { subject: `Patient/${w.pid}` });
    const followup = (): Promise<Basic> => client.createResource<Basic>({ resourceType: 'Basic', subject: { reference: `Patient/${w.pid}` }, code: { text: 'x' },
      extension: [{ url: 'urn:x', valueReference: { reference: `DiagnosticReport/${old.id}` } }] });
    const made: Basic[] = [];
    let deletes = 0;
    const r = await run(w, true, async (s) => { if (s === 'repoint' || (s === 'deleted' && ++deletes === 1)) made.push(await followup()); });
    expect(r.dangling).toBe(0);
    const [neu] = await client.searchResources('DiagnosticReport', { subject: `Patient/${w.pid}` });
    for (const b of made) expect((await client.readResource('Basic', b.id as string)).extension?.[0].valueReference?.reference).toBe(`DiagnosticReport/${neu.id}`);
    expect(made).toHaveLength(2);
    expect(flag(w)).toBe('medplum');
  });
});

test('a rerun after the last delete checks every reference before it sets the flag', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    const deletes = Object.values((await run(w, false)).deleted).reduce((a, b) => a + b, 0);
    const [old] = await client.searchResources('DiagnosticReport', { subject: `Patient/${w.pid}` });
    let n = 0;
    await expect(run(w, true, (s) => { if (s === 'deleted' && ++n === deletes) throw new Error('crash'); })).rejects.toThrow('crash');
    // Written after the crash, pointing at a record the run deleted: the rerun cannot know where it went.
    await client.createResource<Basic>({ resourceType: 'Basic', subject: { reference: `Patient/${w.pid}` }, code: { text: 'x' }, extension: [{ url: 'urn:x', valueReference: { reference: `DiagnosticReport/${old.id}` } }] });
    await expect(run(w, true)).rejects.toThrow(/1 references point at deleted records/);
    expect(flag(w)).toBeUndefined();
  });
});

test('a reference to a record that never existed (a Microsoft placeholder never stored) does not stop the rerun that sets the flag', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    await run(w, true);
    writeFileSync(w.configFile, JSON.stringify(w.cfg)); // flag unset, as after a crash on the last delete
    await client.createResource<Basic>({ resourceType: 'Basic', subject: { reference: `Patient/${w.pid}` }, code: { text: 'x' }, extension: [{ url: 'urn:x', valueReference: { reference: 'Observation/0b6e3c3e-0000-4000-8000-000000000000' } }] });
    expect((await run(w, true)).dangling).toBe(0);
    expect(flag(w)).toBe('medplum');
  });
});

test('a target the check cannot read (the store answers 500) stops the rerun: it never counts as not missing', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    await run(w, true);
    writeFileSync(w.configFile, JSON.stringify(w.cfg)); // flag unset, as after a crash on the last delete
    const target = 'Observation/0b6e3c3e-0000-4000-8000-000000000001';
    await client.createResource<Basic>({ resourceType: 'Basic', subject: { reference: `Patient/${w.pid}` }, code: { text: 'x' }, extension: [{ url: 'urn:x', valueReference: { reference: target } }] });
    const failing = new Proxy(client, { get: (t, p) => (p === 'readResource'
      ? (type: string, id: string) => (`${type}/${id}` === target ? Promise.reject(new OperationOutcomeError(serverError(new Error('down')))) : t.readResource(type as 'Observation', id))
      : ((v) => (typeof v === 'function' ? v.bind(t) : v))(Reflect.get(t, p, t))) });
    await expect(run(w, true, undefined, failing)).rejects.toThrow();
    expect(flag(w)).toBeUndefined();
  });
});

test('records imported before GA kept arrival times: nothing reads as new, and the new records carry no arrival either', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    // No arrival on the old records or the stored document, whose lastUpdated is today (the owner's record, copied into GA's own project).
    const docs = await client.searchResources('DocumentReference', { subject: `Patient/${w.pid}`, identifier: 'urn:ga-server:id:file|' });
    for (const r of [...(await records(client, w.pid)), ...docs]) {
      const ext = (r as { extension?: { url: string }[] }).extension;
      if (ext?.some((e) => e.url === ARRIVED)) await client.updateResource({ ...r, extension: ext.filter((e) => e.url !== ARRIVED) } as Resource);
    }
    const since = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
    const look = () => whatsNew(client, w.pid, Promise.resolve([]), { since, fetch: (async () => { throw new Error('offline'); }) as typeof fetch, dir: mkdtempSync(join(tmpdir(), 'ga-wn-')) });
    const before = await look();
    await run(w, true);
    const after = await look();
    expect(after.tally).toEqual(before.tally);
    expect(after.items.filter((i) => i.kind !== 'health maintenance')).toEqual([]);
    const arrived = (await records(client, w.pid)).filter((x) => ccdaIds(x).length && (x as { extension?: { url: string }[] }).extension?.some((e) => e.url === ARRIVED));
    expect(arrived).toEqual([]);
  });
});

test('a Microsoft-era Composition with no patient whose file is gone but named like a stored document: refused, no flag', async () => {
  await onStore(async ({ client }) => {
    const w = await world(client);
    const [comp] = await client.searchResources('Composition', { subject: `Patient/${w.pid}` });
    const { subject: _, ...rest } = comp as Composition;
    await client.updateResource(rest as Composition);
    rmSync(w.file);
    await expect(run(w, true)).rejects.toThrow(/Compositions with no patient name one of your stored documents \(DOC0001\.XML\)/);
    expect(flag(w)).toBeUndefined();
  });
});

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
