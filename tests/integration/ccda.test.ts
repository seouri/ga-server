import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, DocumentReference, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { convertCcda, importPath } from '../../src/ccda.ts';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { stableIdentifier } from '../../src/identity.ts';
import { cleanupTestMaps, cleanupTestPatient, createTestPatient } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'ccda-synthetic.xml');
const fileHash = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
let cfg: GaConfig;
let client: MedplumClient;
let pid: string;

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
  pid = await createTestPatient(client);
});

// Stable identifiers are deterministic and identifier search is global: delete everything the fixture produced,
// including Practitioner/Organization/Medication and the Binary, which $everything doesn't reach.
afterAll(async () => {
  await cleanupTestMaps(client);
  for (const r of await convertCcda(readFileSync(FIXTURE, 'utf8'), cfg.converterUrl)) {
    const ident = stableIdentifier(r, { kind: 'ccda', file: '', date: '', writer: 'importer' }, '', pid);
    for (const hit of await client.searchResources(r.resourceType, { identifier: `${ident.system}|${ident.value}` }, { cache: 'no-cache' })) {
      // Ownership check: identifier search is global; only delete what this fixture wrote.
      if (hit.resourceType !== 'Patient' && hit.meta?.source === FIXTURE) await client.deleteResource(hit.resourceType, hit.id as string);
    }
  }
  for (const d of await client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}` }, { cache: 'no-cache' })) {
    if (d.subject?.reference !== `Patient/${pid}`) continue;
    const bin = d.content?.[0]?.attachment?.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
    if (bin) await client.deleteResource('Binary', bin);
    await client.deleteResource('DocumentReference', d.id as string);
  }
  await cleanupTestPatient(client, pid);
});

const all = async (): Promise<Resource[]> =>
  ((await client.get<Bundle>(`fhir/R4/Patient/${pid}/$everything?_count=1000`, { cache: 'no-cache' })).entry ?? []).map((e) => e.resource as Resource);
const obs = (code: string) => client.searchResources('Observation', { subject: `Patient/${pid}`, code: `http://loinc.org|${code}` }, { cache: 'no-cache' });

test('synthetic ccda imports LDL, BP, med, problem, smoking with GA patient as subject', async () => {
  const report = await importPath(client, cfg, FIXTURE, pid);
  expect(report.created).toBeGreaterThan(0);
  const [ldl] = await obs('13457-7');
  expect(ldl?.valueQuantity).toMatchObject({ value: 111, unit: 'mg/dL' });
  const [sbp] = await obs('8480-6');
  expect(sbp?.valueQuantity?.value).toBe(123);
  expect(await obs('72166-2')).toHaveLength(1);
  const meds = await client.searchResources('MedicationStatement', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(meds).toHaveLength(1);
  expect(meds[0].status).toBe('active');
  const conds = await client.searchResources('Condition', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  const status = Object.fromEntries(conds.map((c) => [c.code?.coding?.[0]?.code, c.clinicalStatus?.coding?.[0]?.code]));
  // Hyperlipidemia: concern act active. Asthma: Problem Status observation says resolved, overriding the active act.
  expect(status).toEqual({ '55822004': 'active', '195967001': 'resolved' });
  // The converter's Patient collapsed onto the GA patient: no second Patient for the fake MRN.
  expect(await client.searchResources('Patient', { identifier: 'FAKE-MRN-0001' }, { cache: 'no-cache' })).toHaveLength(1);
  expect((await all()).filter((r) => r.resourceType === 'Patient').map((r) => r.id)).toEqual([pid]);
});

test('importing the same ccda twice changes nothing', async () => {
  await importPath(client, cfg, FIXTURE, pid);
  const before = (await all()).map((r) => `${r.resourceType}/${r.id}/${r.meta?.versionId}`).sort();
  const report = await importPath(client, cfg, FIXTURE, pid);
  expect(report).toMatchObject({ created: 0, updated: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 });
  expect(report.skipped).toBeGreaterThan(0);
  expect((await all()).map((r) => `${r.resourceType}/${r.id}/${r.meta?.versionId}`).sort()).toEqual(before);
});

test('ccda file stored once as DocumentReference', async () => {
  await importPath(client, cfg, FIXTURE, pid);
  const docs = await client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}` }, { cache: 'no-cache' });
  expect(docs).toHaveLength(1);
  const d = docs[0] as DocumentReference;
  expect(d.subject?.reference).toBe(`Patient/${pid}`);
  const url = d.content?.[0]?.attachment?.url as string;
  expect(url).toMatch(/(Binary|storage)\//);
  const bin = await client.readResource('Binary', url.match(/(?:Binary|storage)\/([^/?]+)/)?.[1] as string);
  expect(bin.contentType).toBe('application/xml');
});
