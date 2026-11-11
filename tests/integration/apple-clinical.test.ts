import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { AllergyIntolerance, Condition, Resource } from '@medplum/fhirtypes';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { importAppleHealth } from '../../src/apple/import.ts';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { importResources } from '../../src/engine.ts';
import { APPLE } from '../../src/identity.ts';
import { sourceKey } from '../../src/smart/auth.ts';
import { mapForGa } from '../../src/smart/fetch.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'apple', 'clinical');
const READINGS = join(import.meta.dirname, '..', 'fixtures', 'apple'); // readings plus one R4 allergy
const BASE = 'https://fhir.example.org/api/FHIR/R4';
let cfg: GaConfig;
let client: MedplumClient;
let pid: string;

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
});
beforeEach(async () => { pid = await createTestPatient(client); });
afterEach(async () => { await cleanupTestPatient(client, pid); });

const count = async (type: string) => (await client.searchResources(type as 'Condition', { subject: `Patient/${pid}`, patient: `Patient/${pid}` } as never, { cache: 'no-cache' })).length;
const conditions = () => client.searchResources('Condition', { subject: `Patient/${pid}` }, { cache: 'no-cache' }) as Promise<Condition[]>;
const allergies = () => client.searchResources('AllergyIntolerance', { patient: `Patient/${pid}` }, { cache: 'no-cache' }) as Promise<AllergyIntolerance[]>;

// The hospital's own copy of Condition/c1, as a portal sync maps and writes it (with lastUpdated).
async function importHospital(): Promise<void> {
  const cond = { resourceType: 'Condition', id: 'c1', meta: { lastUpdated: '2025-11-01T00:00:00Z' }, code: { text: 'hospital wording' }, subject: { reference: 'Patient/p1' } } as Resource;
  const { resources } = mapForGa([{ resourceType: 'Patient', id: 'p1' }, cond], { key: sourceKey(BASE), name: 'Synthetic Hospital', fhirBase: BASE });
  const at = new Date().toISOString();
  await importResources(client, resources, { kind: 'smart', file: BASE, date: at, writer: 'importer', dateOf: (r) => r.meta?.lastUpdated, fillOnly: (r) => !r.meta?.lastUpdated, seenAt: at }, pid, '');
}

test('Apple only: every R4 record lands', async () => {
  await importAppleHealth(client, cfg, FIXTURE, pid);
  expect(await allergies()).toHaveLength(1);
  expect(await conditions()).toHaveLength(1);
  for (const t of ['Observation', 'DiagnosticReport']) expect(await count(t)).toBe(1);
});

test('keeps references between clinical records', async () => {
  await importAppleHealth(client, cfg, FIXTURE, pid);
  const [d] = await client.searchResources('DiagnosticReport', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  const [o] = await client.searchResources('Observation', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(d.result?.[0].reference).toBe(`Observation/${o.id}`);
  const [m] = await client.searchResources('MedicationRequest', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  const med = await client.readReference(m.medicationReference as never) as { code?: { coding?: { code?: string }[] } };
  expect(med.code?.coding?.[0].code).toBe('197361');
});

test('an inline pdf is stored as a Binary', async () => {
  await importAppleHealth(client, cfg, FIXTURE, pid);
  const [doc] = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: `urn:ga-server:id:smart:${sourceKey(BASE)}|` }, { cache: 'no-cache' });
  expect(doc.content[0].attachment.url).toMatch(/^Binary\/|\/storage\//); // Medplum answers a Binary with its presigned storage URL
});

test('Apple then hospital', async () => {
  await importAppleHealth(client, cfg, FIXTURE, pid);
  await importHospital();
  const all = await conditions();
  expect(all).toHaveLength(1);
  expect(all[0].code?.text).toBe('hospital wording');
});

test('hospital then Apple', async () => {
  await importHospital();
  await importAppleHealth(client, cfg, FIXTURE, pid);
  const all = await conditions();
  expect(all).toHaveLength(1);
  expect(all[0].code?.text).toBe('hospital wording');
});

test('old Apple allergy gains the new identifier', async () => {
  await client.createResource({
    resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${pid}` }, code: { text: 'Penicillin' },
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
    identifier: [{ system: APPLE, value: `${BASE}/AllergyIntolerance/a1` }],
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }] },
  } as AllergyIntolerance);
  await importAppleHealth(client, cfg, FIXTURE, pid);
  const all = await allergies();
  expect(all).toHaveLength(1);
  expect(all[0].identifier?.some((i) => i.system === `urn:ga-server:id:smart:${sourceKey(BASE)}` && i.value === 'AllergyIntolerance/a1')).toBe(true);
});

test('an adopted main-era allergy takes the newer export\'s status', async () => {
  await client.createResource({
    resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${pid}` }, code: { text: 'Penicillin' },
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'inactive' }] },
    identifier: [{ system: APPLE, value: `${BASE}/AllergyIntolerance/a1` }],
    extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2025-01-01' }],
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }, { system: 'urn:ga-server:tag', code: 'writer-importer' }] },
  } as AllergyIntolerance);
  await importAppleHealth(client, cfg, FIXTURE, pid);
  const all = await allergies();
  expect(all).toHaveLength(1);
  expect(all[0].clinicalStatus?.coding?.[0]?.code).toBe('active');
  expect(srcTags(all[0])).toEqual(['src-apple-clinical']);
});

test('re-import is a no-op', async () => {
  await importAppleHealth(client, cfg, FIXTURE, pid);
  expect((await importAppleHealth(client, cfg, FIXTURE, pid)).created).toBe(0);
});

test('two hospitals with the same resource id stay apart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-two-'));
  try {
    cpSync(FIXTURE, dir, { recursive: true });
    const other = 'https://other.example.org/api/FHIR/R4';
    const rec = (type: string, id: string, file: string) => ` <ClinicalRecord type="${type}" identifier="${id}" sourceName="Other Hospital" sourceURL="${other}/${type}/${id}" fhirVersion="4.0.1" receivedDate="2025-11-02 00:15:50 -0800" resourceFilePath="/clinical-records/${file}"/>\n`;
    writeFileSync(join(dir, 'clinical-records', 'O2-1.json'), JSON.stringify({ resourceType: 'Observation', id: 'o1', status: 'final', code: { text: 'Other result' }, subject: { reference: 'Patient/q' }, valueString: 'other' }));
    writeFileSync(join(dir, 'clinical-records', 'D2-1.json'), JSON.stringify({ resourceType: 'DiagnosticReport', id: 'd1', status: 'final', code: { text: 'Other report' }, subject: { reference: 'Patient/q' }, result: [{ reference: 'Observation/o1' }] }));
    const x = readFileSync(join(dir, 'export.xml'), 'utf8').replace('</HealthData>', `${rec('Observation', 'o1', 'O2-1.json')}${rec('DiagnosticReport', 'd1', 'D2-1.json')}</HealthData>`);
    writeFileSync(join(dir, 'export.xml'), x);
    await importAppleHealth(client, cfg, dir, pid);
    const reports = await client.searchResources('DiagnosticReport', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
    expect(reports).toHaveLength(2);
    for (const d of reports) {
      const o = await client.readReference(d.result?.[0] as never) as { code?: { text?: string } };
      expect(o.code?.text).toBe(d.code?.text === 'Other report' ? 'Other result' : 'Result');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const srcTags = (r: Resource) => (r.meta?.tag ?? []).filter((t) => t.system === 'urn:ga-server:tag' && t.code?.startsWith('src-')).map((t) => t.code);

test('clinical copies carry src-apple-clinical, readings still src-apple-health', async () => {
  await importAppleHealth(client, cfg, READINGS, pid);
  const [a] = await allergies();
  expect(srcTags(a)).toEqual(['src-apple-clinical']);
  const readings = await client.searchResources('Observation', { subject: `Patient/${pid}`, identifier: `${APPLE}|`, _count: '1000' }, { cache: 'no-cache' });
  expect(readings.length).toBeGreaterThan(0);
  for (const o of readings) expect(srcTags(o)).toEqual(['src-apple-health']);
});

test('an export whose only readable clinical records are Patient files still merges their identifiers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-patient-'));
  try {
    cpSync(FIXTURE, dir, { recursive: true });
    const x = readFileSync(join(dir, 'export.xml'), 'utf8').split('\n').filter((l) => !l.includes('<ClinicalRecord ') || l.includes('type="Patient"')).join('\n');
    writeFileSync(join(dir, 'export.xml'), x);
    await importAppleHealth(client, cfg, dir, pid);
    const p = await client.readResource('Patient', pid, { cache: 'no-cache' });
    expect(p.identifier?.some((i) => i.system === 'urn:example:mrn' && i.value === '123')).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
