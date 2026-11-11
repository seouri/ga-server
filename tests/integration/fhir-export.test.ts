// Epic FHIR export import against the local Medplum, on a throwaway test patient.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getClient, loadConfig, type GaConfig } from '../../src/config.ts';
import { importResources } from '../../src/engine.ts';
import { importFhirExport } from '../../src/fhir-export/import.ts';
import { APPLE, NEWEST_IMPORT } from '../../src/identity.ts';
import { currentList } from '../../src/lists.ts';
import { sourceKey } from '../../src/smart/auth.ts';
import { cleanupTestPatient, compartmentOf, createTestPatient } from './helpers.ts';

const dir = join(import.meta.dirname, '..', 'fixtures', 'fhir-export');
const MINI = join(dir, 'mini.json');
const MINI_NOTE = join(dir, 'mini-note.json');
const BASE = 'https://fhir.example.org/api/FHIR/R4/';
const ID = `urn:ga-server:id:smart:${sourceKey(BASE)}`;

let client: MedplumClient;
let cfg: GaConfig;
let patientId: string;
const cond = () => client.searchOne('Condition', { identifier: `${ID}|Condition/c1`, subject: `Patient/${patientId}` }, { cache: 'no-cache' });

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
  patientId = await createTestPatient(client);
});

afterAll(async () => {
  for (const r of await compartmentOf(client, patientId)) {
    for (const c of (r as DocumentReference).content ?? []) {
      const id = /(?:Binary|storage)\/([0-9a-f-]{36})/.exec(c.attachment?.url ?? '')?.[1];
      if (id) await client.deleteResource('Binary', id).catch(() => undefined);
    }
  }
  await cleanupTestPatient(client, patientId);
});

describe('importFhirExport', () => {
  it('imports the export', async () => {
    const r = await importFhirExport(client, cfg, MINI, patientId, { fhirBase: BASE });
    expect(r.created).toBe(4);
    expect(r.attachmentsUnplaced).toBe(1);
    expect(r.skippedTypes).toEqual({ Account: 1 });
    const c = await cond();
    expect(c?.meta?.tag?.map((t) => t.code)).toContain('src-fhir-export');
  });
  it('re-import is a no-op', async () => {
    const r = await importFhirExport(client, cfg, MINI, patientId, { fhirBase: BASE });
    expect(r.created).toBe(0);
    expect(r.updated).toBe(0);
  });
  // A real Epic export has no meta.lastUpdated at all: its records are fill-only with no source date. One identical to an Apple
  // clinical copy takes that copy over: the export's tag, no source date (the Apple export date removed), the Apple id kept.
  it('a file with no lastUpdated takes over an identical apple-only copy', async () => {
    const id = `a-${randomUUID()}`;
    const body = { resourceType: 'Condition', id, code: { text: 'synthetic apple problem' }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] } };
    const apple = { ...body, subject: { reference: `Patient/${patientId}` }, identifier: [{ system: ID, value: `Condition/${id}` }, { system: APPLE, value: `${BASE}Condition/${id}` }] } as Resource;
    await importResources(client, [apple], { kind: 'apple-clinical', file: '/synthetic/export.xml', date: '2025-11-10T00:00:00Z', writer: 'importer', fillOnly: () => true }, patientId, '');
    const tmp = mkdtempSync(join(tmpdir(), 'fhir-export-apple-'));
    const file = join(tmp, 'ehr.json');
    writeFileSync(file, JSON.stringify({ fhir: { Patient: [{ resourceType: 'Patient', id: 'p1' }], Condition: [{ ...body, subject: { reference: 'Patient/p1' } }] } }));
    try {
      expect(await importFhirExport(client, cfg, file, patientId, { fhirBase: BASE })).toMatchObject({ updated: 1, created: 0 });
      const c = await client.searchOne('Condition', { identifier: `${ID}|Condition/${id}`, subject: `Patient/${patientId}` }, { cache: 'no-cache' });
      const tags = c?.meta?.tag?.map((t) => t.code);
      expect(tags).toContain('src-fhir-export');
      expect(tags).not.toContain('src-apple-clinical');
      expect(c?.extension?.some((e) => e.url === 'urn:ga-server:ext:source-date')).toBe(false);
      expect(c?.identifier?.map((i) => i.system)).toContain(APPLE);
      expect(await importFhirExport(client, cfg, file, patientId, { fhirBase: BASE })).toMatchObject({ updated: 0, created: 0 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('an added note updates the record', async () => {
    await importFhirExport(client, cfg, MINI_NOTE, patientId, { fhirBase: BASE });
    expect((await cond())?.note?.map((n) => n.text)).toContain('patient note');
  });
});

// A FHIR export file written to a temp folder (the importer reads a path); each test its own content.
const tmp = mkdtempSync(join(tmpdir(), 'fhir-export-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const writeExport = (name: string, rs: Resource[]): string => {
  const fhir: Record<string, Resource[]> = {};
  for (const r of rs) (fhir[r.resourceType] ??= []).push(r);
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify({ fhir, attachments: [] }));
  return path;
};
// A fresh patient per test: these tests read the whole compartment.
const withPatient = async (f: (pid: string) => Promise<void>) => {
  const pid = await createTestPatient(client);
  try { await f(pid); } finally { await cleanupTestPatient(client, pid); }
};

describe('patient-less exports', () => {
  it("imports the personalrecord tool's output into the patient compartment", () => withPatient(async (pid) => {
    // Synthetic output of the rebuild tool (kept in the dataset folder it serves), run on its own fixtures.
    const out = Object.values((JSON.parse(readFileSync(join(dir, 'rebuilt-sample.json'), 'utf8')) as { fhir: Record<string, Resource[]> }).fhir).flat();
    const r = await importFhirExport(client, cfg, writeExport('rebuilt.json', out), pid, { fhirBase: BASE });
    expect(r.invalid).toBe(0);
    expect(r.created).toBe(out.length);
    const mine = (await compartmentOf(client, pid)).filter((x) => x.meta?.tag?.some((t) => t.code === 'src-fhir-export'));
    expect(mine).toHaveLength(out.length);
  }));

  it('a rebuilt-only file does not make portal medications unconfirmed', async () => {
    const at = '2025-09-01T00:00:00Z';
    const knownFile = (name: string) => writeExport(name, [
      { resourceType: 'Patient', id: 'p1', meta: { lastUpdated: at } },
      { resourceType: 'MedicationRequest', id: 'm1', meta: { lastUpdated: at }, status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Synthetic drug 5 mg' }, subject: { reference: 'Patient/p1' }, authoredOn: '2025-08-01' },
    ] as Resource[]);
    // Reconstructed records: no meta.lastUpdated, no patient, dated after the known export.
    const rebuiltFile = (name: string) => writeExport(name, [
      { resourceType: 'Observation', id: 'eREBUILT0000000000001', status: 'final', code: { text: 'Synthetic later lab' }, effectiveDateTime: '2026-05-01', valueString: 'x' },
      { resourceType: 'Condition', id: 'eREBUILT0000000000002', code: { text: 'Synthetic later problem' }, recordedDate: '2026-06-01' },
    ] as Resource[]);
    const current = async (pid: string) => (await currentList(client, pid, 'medications', undefined, [])).rows.map((x) => x.currency);
    const stored = async (pid: string) => (await client.readResource('Patient', pid, { cache: 'no-cache' })).extension?.find((e) => e.url === NEWEST_IMPORT)?.valueDateTime;
    await withPatient(async (pid) => { // known export, then the rebuilt file
      await importFhirExport(client, cfg, knownFile('known-1.json'), pid, { fhirBase: BASE });
      await importFhirExport(client, cfg, rebuiltFile('rebuilt-1.json'), pid, { fhirBase: BASE });
      expect(await stored(pid)).toBe(at.replace('Z', '.000Z'));
      expect(await current(pid)).toEqual(['current']);
    });
    await withPatient(async (pid) => { // the rebuilt file first: it stores nothing, and a later scan does not count it
      await importFhirExport(client, cfg, rebuiltFile('rebuilt-2.json'), pid, { fhirBase: BASE });
      expect(await stored(pid)).toBeUndefined();
      await importFhirExport(client, cfg, knownFile('known-2.json'), pid, { fhirBase: BASE });
      expect(await stored(pid)).toBe(at.replace('Z', '.000Z'));
      expect(await current(pid)).toEqual(['current']);
    });
  });

  it('an older active medication in a dated export reads current', () => withPatient(async (pid) => {
    // One file: the medication was last updated months before another record in it; the file is one whole-record list.
    const file = writeExport('dated-mixed.json', [
      { resourceType: 'Patient', id: 'p1', meta: { lastUpdated: '2025-08-01T00:00:00Z' } },
      { resourceType: 'MedicationRequest', id: 'm-old', meta: { lastUpdated: '2025-03-01T00:00:00Z' }, status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Synthetic older drug 5 mg' }, subject: { reference: 'Patient/p1' }, authoredOn: '2025-02-01' },
      { resourceType: 'Observation', id: 'o-new', meta: { lastUpdated: '2025-08-01T00:00:00Z' }, status: 'final', code: { text: 'Synthetic lab' }, effectiveDateTime: '2025-07-30', valueString: 'x', subject: { reference: 'Patient/p1' } },
    ] as Resource[]);
    await importFhirExport(client, cfg, file, pid, { fhirBase: BASE });
    expect((await currentList(client, pid, 'medications', undefined, [])).rows.map((x) => x.currency)).toEqual(['current']);
  }));

  // Medplum refuses a record over 1 MB: an inline report PDF goes to a Binary, the report keeps only its url.
  it('imports a report with a large inline PDF', () => withPatient(async (pid) => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_200_000, 0x41)]);
    const file = writeExport('report-pdf.json', [
      { resourceType: 'Patient', id: 'p1', meta: { lastUpdated: '2025-09-01T00:00:00Z' } },
      { resourceType: 'DiagnosticReport', id: 'dr-pdf', meta: { lastUpdated: '2025-09-01T00:00:00Z' }, status: 'final', code: { text: 'Synthetic CT report' }, subject: { reference: 'Patient/p1' }, effectiveDateTime: '2025-08-30', presentedForm: [{ contentType: 'application/pdf', data: pdf.toString('base64') }] },
    ] as Resource[]);
    const r = await importFhirExport(client, cfg, file, pid, { fhirBase: BASE });
    expect(r).toMatchObject({ created: 1, invalid: 0 }); // the report; the Patient links to the test patient
    const dr = await client.searchOne('DiagnosticReport', { identifier: `${ID}|DiagnosticReport/dr-pdf`, subject: `Patient/${pid}` }, { cache: 'no-cache' });
    const a = dr?.presentedForm?.[0];
    expect(a?.data).toBeUndefined();
    const bin = /(?:Binary|storage)\/([0-9a-f-]{36})/.exec(a?.url ?? '')?.[1];
    expect(bin).toBeDefined();
    if (bin) await client.deleteResource('Binary', bin).catch(() => undefined);
  }));

  // Medplum reads a stored Binary/<id> back as a presigned storage URL: the same report again must not count as a change.
  it('a report with a Binary-backed PDF re-imported unchanged is not updated', () => withPatient(async (pid) => {
    const pdf = Buffer.from('%PDF-1.4\nsynthetic report\n');
    const file = writeExport('report-pdf-again.json', [
      { resourceType: 'Patient', id: 'p1' },
      { resourceType: 'DiagnosticReport', id: 'dr-again', status: 'final', code: { text: 'Synthetic MRI report' }, subject: { reference: 'Patient/p1' }, effectiveDateTime: '2025-08-30', presentedForm: [{ contentType: 'application/pdf', data: pdf.toString('base64') }] },
    ] as Resource[]);
    expect(await importFhirExport(client, cfg, file, pid, { fhirBase: BASE })).toMatchObject({ created: 1 });
    const created = vi.spyOn(client, 'createBinary');
    try {
      expect(await importFhirExport(client, cfg, file, pid, { fhirBase: BASE })).toMatchObject({ created: 0, updated: 0 });
      expect(created).not.toHaveBeenCalled();
    } finally {
      created.mockRestore();
      const dr = await client.searchOne('DiagnosticReport', { identifier: `${ID}|DiagnosticReport/dr-again`, subject: `Patient/${pid}` }, { cache: 'no-cache' });
      const bin = /(?:Binary|storage)\/([0-9a-f-]{36})/.exec(dr?.presentedForm?.[0]?.url ?? '')?.[1];
      if (bin) await client.deleteResource('Binary', bin).catch(() => undefined);
    }
  }));

  // An import from before pending Binaries stored a small report PDF inline: importing it again keeps it inline, no new Binary.
  it('a report stored with an inline PDF is re-imported without a new Binary', () => withPatient(async (pid) => {
    const pdf = Buffer.from('%PDF-1.4\nsynthetic inline report\n').toString('base64');
    const report = { resourceType: 'DiagnosticReport', status: 'final', code: { text: 'Synthetic echo report' }, effectiveDateTime: '2025-08-30', presentedForm: [{ contentType: 'application/pdf', data: pdf }] } as const;
    await client.createResource({ ...report, subject: { reference: `Patient/${pid}` }, identifier: [{ system: ID, value: 'DiagnosticReport/dr-inline' }], meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-fhir-export' }] } } as Resource);
    const file = writeExport('report-inline.json', [{ resourceType: 'Patient', id: 'p1' }, { ...report, id: 'dr-inline', subject: { reference: 'Patient/p1' } }] as Resource[]);
    const created = vi.spyOn(client, 'createBinary');
    try {
      expect(await importFhirExport(client, cfg, file, pid, { fhirBase: BASE })).toMatchObject({ created: 0, updated: 0 });
      expect(await importFhirExport(client, cfg, file, pid, { fhirBase: BASE })).toMatchObject({ created: 0, updated: 0 });
      expect(created).not.toHaveBeenCalled();
    } finally {
      created.mockRestore();
    }
    const dr = await client.searchOne('DiagnosticReport', { identifier: `${ID}|DiagnosticReport/dr-inline`, subject: `Patient/${pid}` }, { cache: 'no-cache' });
    expect(dr?.presentedForm?.[0]).toMatchObject({ data: pdf });
    expect(dr?.presentedForm?.[0]?.url).toBeUndefined();
  }));
});
