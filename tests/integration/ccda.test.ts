import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { importPath } from '../../src/ccda.ts';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { cleanupCcda, cleanupTestMaps, cleanupTestPatient, compartmentOf, createTestPatient } from './helpers.ts';

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
// including Practitioner/Organization and the Binary, which $everything doesn't reach.
afterAll(async () => {
  await cleanupTestMaps(client);
  await cleanupCcda(client, FIXTURE);
  for (const d of await client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}` }, { cache: 'no-cache' })) {
    if (d.subject?.reference !== `Patient/${pid}`) continue;
    const bin = d.content?.[0]?.attachment?.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
    if (bin) await client.deleteResource('Binary', bin);
    await client.deleteResource('DocumentReference', d.id as string);
  }
  await cleanupTestPatient(client, pid);
});

const all = async (): Promise<Resource[]> =>
  [await client.readResource('Patient', pid), ...(await compartmentOf(client, pid))];
// The compartment plus the shared records it references (Practitioner, Organization, Location, Medication...), so a
// re-import that re-versions or duplicates a shared record is caught.
const withShared = async (): Promise<Resource[]> => {
  const mine = await all();
  const refs = new Set([...JSON.stringify(mine).matchAll(/"reference":"((?:Practitioner|PractitionerRole|Organization|Location|Medication|Device)\/[^"/]+)"/g)].map((m) => m[1]));
  return [...mine, ...(await Promise.all([...refs].map((ref) => client.readReference({ reference: ref }) as Promise<Resource>)))];
};
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
});

test('importing the same ccda twice changes nothing', async () => {
  await importPath(client, cfg, FIXTURE, pid);
  const before = (await withShared()).map((r) => `${r.resourceType}/${r.id}/${r.meta?.versionId}`).sort();
  expect(before.some((k) => /^(Practitioner|Organization)\//.test(k))).toBe(true); // the fixture's author and custodian
  const report = await importPath(client, cfg, FIXTURE, pid);
  expect(report).toMatchObject({ created: 0, updated: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 });
  expect(report.skipped).toBeGreaterThan(0);
  expect((await withShared()).map((r) => `${r.resourceType}/${r.id}/${r.meta?.versionId}`).sort()).toEqual(before);
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
