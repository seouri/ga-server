import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Condition, DiagnosticReport, Encounter, Immunization, Observation, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { convertCcdaMs, importPath } from '../../src/ccda.ts';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { mapConditions } from '../../src/ehi/conditions.ts';
import { mapEncounters } from '../../src/ehi/encounters.ts';
import { type EhiCtx, epicOrgNumber, PATIENT_REF, resolveUnlinked } from '../../src/ehi/ids.ts';
import { importEhi, prepareEhi } from '../../src/ehi/import.ts';
import { linkResultsToExisting, mapLabs } from '../../src/ehi/labs.ts';
import { EhiTables, exportInfo } from '../../src/ehi/read.ts';
import { importResources } from '../../src/engine.ts';
import { type SourceInfo, stableIdentifier } from '../../src/identity.ts';
import { cleanupTestMaps, cleanupTestPatient, createTestPatient } from './helpers.ts';

// Synthetic fixtures sharing order 9000001 (C-CDA organizer id under an Epic order root, org number 99).
const CCDA = join(import.meta.dirname, '..', 'fixtures', 'ccda-synthetic.xml');
const EHI = join(import.meta.dirname, '..', 'fixtures', 'ehi');
const fileHash = createHash('sha256').update(readFileSync(CCDA)).digest('hex');
let cfg: GaConfig;
let client: MedplumClient;
let pid: string;

beforeAll(async () => {
  cfg = { ...loadConfig(), ccdaConverter: 'microsoft' }; // what these tests and their cleanup expect
  client = await getClient(cfg);
  pid = await createTestPatient(client);
  await importPath(client, cfg, CCDA, pid);
});

// Same cleanup as ccda.test.ts: stable identifiers are global, delete what the fixture wrote (plus the patient compartment).
afterAll(async () => {
  await cleanupTestMaps(client);
  for (const r of await convertCcdaMs(readFileSync(CCDA, 'utf8'), cfg.converterUrl)) {
    const ident = stableIdentifier(r, { kind: 'ccda', file: '', date: '', writer: 'importer' }, '', pid);
    for (const hit of await client.searchResources(r.resourceType, { identifier: `${ident.system}|${ident.value}` }, { cache: 'no-cache' })) {
      if (hit.resourceType !== 'Patient' && hit.meta?.source === CCDA) await client.deleteResource(hit.resourceType, hit.id as string);
    }
  }
  for (const d of await client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}` }, { cache: 'no-cache' })) {
    if (d.subject?.reference !== `Patient/${pid}`) continue;
    const bin = d.content?.[0]?.attachment?.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
    if (bin) await client.deleteResource('Binary', bin);
    await client.deleteResource('DocumentReference', d.id as string);
  }
  // Stored files (RTF, media, archive): their Binaries are not in the patient compartment.
  for (const d of await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, _count: '1000' }, { cache: 'no-cache' })) {
    for (const c of d.content ?? []) {
      const bin = c.attachment.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
      if (bin) await client.deleteResource('Binary', bin);
    }
  }
  await cleanupTestPatient(client, pid);
});

const ldl = () => client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|13457-7' }, { cache: 'no-cache' });
const systems = (r: Resource) => ((r as Observation).identifier ?? []).map((i) => i.system);
const tagged = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === 'urn:ga-server:tag' && t.code === code);

async function importLabs(ctx: EhiCtx, edit: (rs: Resource[]) => void = () => {}) {
  const t = new EhiTables(EHI);
  const batch: Resource[] = [{ resourceType: 'Patient', id: PATIENT_REF.reference.split('/')[1] }, ...mapEncounters(t, ctx), ...mapConditions(t, ctx), ...mapLabs(t, ctx)];
  edit(batch);
  const linked = await linkResultsToExisting(client, batch, pid);
  const { resources, skippedNoName } = await resolveUnlinked(client, linked.resources, pid);
  const src: SourceInfo = { kind: 'ehi', file: EHI, date: ctx.date, writer: 'importer' };
  return { ...linked, skippedNoName, report: await importResources(client, resources, src, pid, 'synthetic-ehi') };
}

test('EHI result merges with the C-CDA result of the same order', async () => {
  const n = await epicOrgNumber(client, pid);
  expect(n).toBe('99');
  const ctx: EhiCtx = { ...exportInfo(EHI), epicOrgNumber: n };
  const { identified, unidentified, skippedNoName, report } = await importLabs(ctx);
  expect({ identified, unidentified, skippedNoName }).toEqual({ identified: 1, unidentified: 1, skippedNoName: 1 });
  expect(report).toMatchObject({ possibleDuplicates: 0, invalid: 0 });
  // The unlinked Encounter was created with class UNK; the named visit diagnosis was kept.
  const [e] = await client.searchResources('Encounter', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(e.class?.code).toBe('UNK');
  const dx = await client.searchResources('Condition', { subject: `Patient/${pid}`, category: 'encounter-diagnosis' }, { cache: 'no-cache' });
  expect(dx.map((c) => c.code?.text)).toEqual(['Test problem']);
  const found = await ldl();
  expect(found).toHaveLength(1);
  expect(found[0].valueQuantity?.value).toBe(111);
  expect(systems(found[0])).toEqual(expect.arrayContaining(['urn:ga-server:id:ccda', 'urn:ga-server:id:ehi:synthetic-health']));
  expect(tagged(found[0], 'possible-duplicate')).toBe(false);
  // The EHI report linked to the C-CDA report by order id and kept its LOINC code.
  const [dr] = await client.searchResources('DiagnosticReport', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(systems(dr)).toEqual(expect.arrayContaining(['urn:ga-server:id:ccda', 'urn:ga-server:id:ehi:synthetic-health']));
  expect(dr.code.coding?.[0]?.code).toBe('57698-3');
  // Re-import is a no-op.
  const again = await importLabs(ctx);
  expect(again.report).toMatchObject({ created: 0, updated: 0, possibleDuplicates: 0, invalid: 0 });
});

test('an EHI result of the same order with a different value is a possible duplicate', async () => {
  // Another org's export: distinct GA identifiers, so the content path (not the stable id) decides.
  const ctx: EhiCtx = { ...exportInfo(EHI), org: 'synthetic-health-b', epicOrgNumber: '99' };
  const { report } = await importLabs(ctx, (rs) => {
    const o = rs.find((r) => r.resourceType === 'Observation' && (r as Observation).code?.text === 'LDL CALCULATED') as Observation;
    o.valueQuantity = { ...o.valueQuantity, value: 112 };
  });
  expect(report.possibleDuplicates).toBe(1); // the LDL only
  const found = await ldl();
  expect(found.map((o) => o.valueQuantity?.value).sort()).toEqual([111, 112]);
  expect(found.every((o) => tagged(o, 'possible-duplicate'))).toBe(true);
});

test('an ambiguous CSN link counts as unlinked: the EHI Encounter gets class UNK and is flagged, not rejected', async () => {
  const csn = `syn-${randomUUID()}`;
  const ids = [{ system: 'urn:oid:1.2.840.114350.1.13.99.2.7.3.698084.8', value: csn }];
  const ccdaEnc = (n: string): Resource => ({ resourceType: 'Encounter', id: n, identifier: [{ system: 'urn:test:src', value: n }, ...ids], status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${pid}` } }) as Resource;
  await importResources(client, [ccdaEnc(`a-${csn}`), ccdaEnc(`b-${csn}`)], { kind: 'ccda', file: '/synthetic-clinic/synthetic.xml', date: '2024-01-01', writer: 'importer' }, pid, 'h');
  const e = { resourceType: 'Encounter', id: 'x', identifier: [{ system: 'urn:ga-server:id:ehi:synthetic-health', value: `PAT_ENC|${csn}` }, ...ids], status: 'finished', subject: { reference: `Patient/${pid}` } } as Encounter;
  const { resources } = await resolveUnlinked(client, [e], pid);
  expect((resources[0] as Encounter).class?.code).toBe('UNK');
  const r = await importResources(client, resources, { kind: 'ehi', file: EHI, date: '2026-01-17T08:30:00-05:00', writer: 'importer' }, pid, 'h');
  expect(r).toMatchObject({ possibleDuplicates: 1, invalid: 0 });
});

test('resolveUnlinked passes a record with no identifiers through without a lookup', async () => {
  const e = { resourceType: 'Encounter', id: 'y', identifier: [], status: 'finished', subject: { reference: `Patient/${pid}` } } as unknown as Encounter;
  const { resources } = await resolveUnlinked(client, [e], pid);
  expect((resources[0] as Encounter).class?.code).toBe('UNK');
});

// The full orchestrator. Same patient as the tests above: EHI stable identifiers are global, so the fixture's records
// already belong to this patient.
test('R21: an EHI text-only medication never replaces a coded C-CDA medication', async () => {
  const order = `syn-${randomUUID()}`;
  const epic = { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.798268', value: order };
  const med = { resourceType: 'Medication', id: 'm1', identifier: [{ system: 'urn:test:med', value: order }], code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '0000' }], text: 'Synthetic drug' } } as Resource;
  const ccdaMr = { resourceType: 'MedicationRequest', id: 'r1', identifier: [{ system: 'urn:test:src', value: order }, epic], status: 'active', intent: 'order', medicationReference: { reference: 'Medication/m1' }, subject: { reference: `Patient/${pid}` } } as Resource;
  await importResources(client, [med, ccdaMr], { kind: 'ccda', file: '/synthetic-clinic/synthetic.xml', date: '2024-01-01', writer: 'importer' }, pid, 'h');
  const ehiMr = { resourceType: 'MedicationRequest', id: 'x', identifier: [{ system: 'urn:ga-server:id:ehi:synthetic-health', value: `ORDER_MED|${order}` }, epic], status: 'active', intent: 'order', medicationCodeableConcept: { text: 'SYNTHETIC DRUG' }, subject: { reference: `Patient/${pid}` } } as Resource;
  const src: SourceInfo = { kind: 'ehi', file: EHI, date: '2026-01-17T08:30:00-05:00', writer: 'importer' };
  expect(await importResources(client, [ehiMr], src, pid, '')).toMatchObject({ invalid: 0, possibleDuplicates: 0, created: 0 });
  const [mr] = await client.searchResources('MedicationRequest', { subject: `Patient/${pid}`, identifier: `${epic.system}|${order}` }, { cache: 'no-cache' });
  expect(mr.medicationReference?.reference).toMatch(/^Medication\//);
  expect(mr.medicationCodeableConcept).toBeUndefined();
  expect(await importResources(client, [ehiMr], src, pid, '')).toMatchObject({ created: 0, updated: 0 });
  const m = await client.readReference(mr.medicationReference as never);
  await client.deleteResource('Medication', m.id as string); // shared type: not in the patient compartment
});

// C1/I1: real mapper output over richer C-CDA records. Random keys: stable identifiers are global.
test('an EHI update never replaces coded, referenced or more precise C-CDA values', async () => {
  const k = randomUUID().slice(0, 8);
  const [csn, prob, order, imm] = ['csn', 'prob', 'ord', 'imm'].map((x) => `${x}-${k}`);
  const root = 'urn:oid:1.2.840.114350.1.13.99.';
  const ccda = (type: string, id: string, epic: string | undefined, body: object): Resource =>
    ({ resourceType: type, id, identifier: [{ system: 'urn:test:src', value: `${id}-${k}` }, ...(epic ? [{ system: `${root}${epic}`, value: id === 'e' ? csn : id === 'c' ? prob : id === 'd' ? order : imm }] : [])], ...body }) as Resource;
  const subject = { reference: `Patient/${pid}` };
  const at = '2024-01-05T09:30:00-05:00';
  const cholesterol = { coding: [{ system: 'http://loinc.org', code: '2093-3' }], text: 'Cholesterol' };
  const ucum = (value: number) => ({ value, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' });
  const seed = [
    { resourceType: 'Practitioner', id: 'pr', identifier: [{ system: 'urn:test:src', value: `pr-${k}` }], name: [{ text: 'Synthetic Doctor' }] } as Resource,
    ccda('Encounter', 'e', '2.7.3.698084.8', { status: 'finished', class: { code: 'AMB' }, subject, period: { start: '2024-01-05T09:00:00-05:00', end: '2024-01-05T10:00:00-05:00' }, participant: [{ individual: { reference: 'Practitioner/pr', display: 'Synthetic Doctor' } }] }),
    ccda('Condition', 'c', '2.7.2.768076', { category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }], code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003' }] }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, subject }),
    ccda('Observation', 'o1', undefined, { status: 'final', code: cholesterol, subject, effectiveDateTime: at, valueQuantity: ucum(190), interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'H' }] }] }),
    ccda('Observation', 'o2', undefined, { status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '2085-9' }], text: 'HDL' }, subject, effectiveDateTime: at, valueQuantity: ucum(50) }),
    ccda('DiagnosticReport', 'd', '2.7.2.798268', { status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '57698-3' }] }, subject, effectivePeriod: { start: at, end: '2024-01-05T11:00:00-05:00' }, result: [{ reference: 'Observation/o1' }, { reference: 'Observation/o2' }] }),
    ccda('Immunization', 'i', '2.7.2.768076', { status: 'completed', vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '141' }] }, patient: subject, occurrenceDateTime: '2023-10-01', route: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration', code: 'IM' }] } }),
  ];
  expect(await importResources(client, seed, { kind: 'ccda', file: '/synthetic-clinic/synthetic-fill.xml', date: '2024-01-06', writer: 'importer' }, pid, 'h')).toMatchObject({ created: 7, invalid: 0 });
  const data: Record<string, Record<string, string>[]> = {
    PAT_ENC: [{ PAT_ENC_CSN_ID: csn, CONTACT_DATE: '1/5/2024 12:00:00 AM', VISIT_PROV_ID_PROV_NAME: 'DOCTOR, SYNTHETIC' }],
    PROBLEM_LIST: [{ PROBLEM_LIST_ID: prob, DESCRIPTION: 'Synthetic problem', PROBLEM_STATUS_C_NAME: 'Active' }],
    ORDER_PROC: [{ ORDER_PROC_ID: order, PROC_ID_PROC_NAME: 'LIPID PANEL', LAB_STATUS_C_NAME: 'Final result', PAT_ENC_CSN_ID: csn }],
    ORDER_RESULTS: [{ ORDER_PROC_ID: order, LINE: '1', COMPONENT_ID_NAME: 'CHOLESTEROL', ORD_VALUE: '190', REFERENCE_UNIT: 'mg/dL', RESULT_STATUS_C_NAME: 'Final', RESULT_FLAG_C_NAME: 'High', RESULT_DATE: '1/5/2024 12:00:00 AM', PAT_ENC_CSN_ID: csn }],
    IMMUNE: [{ IMMUNE_ID: imm, IMMUNZATN_ID_NAME: 'Influenza', IMMUNE_DATE: '10/1/2023 12:00:00 AM', ROUTE_C_NAME: 'Intramuscular', IMMNZTN_STATUS_C_NAME: 'Given' }],
  };
  const t = { rows: (n: string) => (data[n] ?? []).map((r) => new Proxy(r, { get: (o, f: string) => o[f] ?? '' })), skipped: [] } as unknown as EhiTables;
  const ctx: EhiCtx = { org: `synthetic-fill-${k}`, date: '2026-01-17T08:30:00-05:00', timeZone: 'America/New_York', epicOrgNumber: '99' };
  const ehi = async () => {
    const { resources } = await prepareEhi(client, t, ctx, pid);
    return importResources(client, resources, { kind: 'ehi', file: 'synthetic-fill', date: ctx.date, writer: 'importer' }, pid, '');
  };
  expect(await ehi()).toMatchObject({ created: 0, updated: 4, merged: 1, conflicts: 0, possibleDuplicates: 0, invalid: 0 });
  const one = async <T extends Resource>(type: string, epic: string, value: string) =>
    (await client.searchResources(type as 'Encounter', { identifier: `${root}${epic}|${value}` }, { cache: 'no-cache' }))[0] as unknown as T;
  const e = await one<Encounter>('Encounter', '2.7.3.698084.8', csn);
  expect(e).toMatchObject({ status: 'finished', class: { code: 'AMB' }, period: { end: '2024-01-05T10:00:00-05:00' } });
  expect(e.participant?.[0].individual?.reference).toMatch(/^Practitioner\//);
  const c = await one<Condition>('Condition', '2.7.2.768076', prob);
  expect(c.code).toEqual({ coding: [{ system: 'http://snomed.info/sct', code: '38341003' }], text: 'Synthetic problem' });
  const d = await one<DiagnosticReport>('DiagnosticReport', '2.7.2.798268', order);
  expect(d.effectivePeriod?.end).toBe('2024-01-05T11:00:00-05:00');
  expect(d.effectiveDateTime).toBeUndefined();
  expect(d.result).toHaveLength(2); // the unmatched C-CDA result is kept
  const [o] = await client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|2093-3' }, { cache: 'no-cache' });
  expect(o.interpretation?.[0].coding?.[0].code).toBe('H');
  expect(o.valueQuantity).toEqual(ucum(190));
  const i = await one<Immunization>('Immunization', '2.7.2.768076', imm);
  expect(i.route?.coding?.[0].code).toBe('IM');
  expect(i.route?.text).toBe('Intramuscular');
  expect(await ehi()).toMatchObject({ created: 0, updated: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 });
  const pr = await client.readReference(e.participant?.[0].individual as never);
  await client.deleteResource('Practitioner', pr.id as string); // shared type: not in the patient compartment
});

const files = (d: string): { n: number; size: number } => {
  const fs = readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  return { n: fs.length, size: fs.reduce((s, e) => s + statSync(join(e.parentPath, e.name)).size, 0) };
};
const archives = () => client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: 'urn:ga-server:id:ehi-archive|' }, { cache: 'no-cache' });

test('importing the EHI fixture twice is a no-op', async () => {
  const first = await importEhi(client, cfg, EHI, pid);
  expect(first).toMatchObject({ invalid: 0, skippedTables: 0, archived: 'stored' });
  const second = await importEhi(client, cfg, EHI, pid);
  expect(second).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0, archived: 'already-present' });
});

test('archive is stored once and unpacks to the same file count', async () => {
  const found = await archives();
  expect(found).toHaveLength(1);
  // Created with its manifest identifier (never untagged) and the file hash.
  expect(found[0].identifier?.map((i) => i.system).sort()).toEqual(['urn:ga-server:id:ehi-archive', 'urn:ga-server:id:file']);
  const url = found[0].content[0].attachment.url as string;
  const blob = await client.download(url);
  const tmp = mkdtempSync(join(tmpdir(), 'ga-ehi-test-'));
  try {
    writeFileSync(join(tmp, 'a.tar.gz'), Buffer.from(await blob.arrayBuffer()));
    execFileSync('mkdir', [join(tmp, 'x')]);
    execFileSync('tar', ['-xzf', join(tmp, 'a.tar.gz'), '-C', join(tmp, 'x')]);
    expect(files(join(tmp, 'x'))).toEqual(files(EHI));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('skipped tables and unused files are reported with reasons', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ga-ehi-test-'));
  try {
    cpSync(EHI, tmp, { recursive: true });
    rmSync(join(tmp, 'EHITables', 'SOCIAL_HX.tsv'));
    const q = join(tmp, 'EHITables', 'V_EHI_HQA_QUEST_ANSWER.tsv');
    writeFileSync(q, `${readFileSync(q, 'utf8').split('\r\n')[0]}\r\n`);
    writeFileSync(join(tmp, 'Media', 'odd.xyz'), 'synthetic');
    writeFileSync(join(tmp, 'Rich Text', 'HNO_999999_1_41.RTF'), '{\\rtf1 synthetic}');
    const r = await importEhi(client, cfg, tmp, pid);
    expect(r.skips).toMatchObject({ mediaUnknownType: 1, rtfNoNote: 1 });
    expect(r.archived).toBe('stored');
    expect(r.skippedTables).toBe(2);
    expect(r.skips.tables).toEqual(expect.arrayContaining([{ table: 'SOCIAL_HX', reason: 'missing' }, { table: 'V_EHI_HQA_QUEST_ANSWER', reason: 'empty' }]));
    expect(r).toMatchObject({ created: 0, invalid: 0 });
    expect(await archives()).toHaveLength(2); // a different folder is a different archive
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the archive is stored before any record, so a failed import still keeps the original (M3)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ga-ehi-test-'));
  try {
    cpSync(EHI, tmp, { recursive: true });
    const f = join(tmp, 'EHITables', 'PAT_ENC.tsv');
    writeFileSync(f, readFileSync(f, 'utf8').replace('1/15/2026 12:00:00 AM', 'not a date'));
    await expect(importEhi(client, cfg, tmp, pid)).rejects.toThrow('unexpected EHI date format');
    expect(await archives()).toHaveLength(3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
