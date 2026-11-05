import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Encounter, Observation, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { convertCcda, importPath } from '../../src/ccda.ts';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { mapConditions } from '../../src/ehi/conditions.ts';
import { mapEncounters } from '../../src/ehi/encounters.ts';
import { type EhiCtx, epicOrgNumber, PATIENT_REF, resolveUnlinked } from '../../src/ehi/ids.ts';
import { linkResultsToExisting, mapLabs } from '../../src/ehi/labs.ts';
import { EhiTables, exportInfo } from '../../src/ehi/read.ts';
import { importResources } from '../../src/engine.ts';
import { type SourceInfo, stableIdentifier } from '../../src/identity.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

// Synthetic fixtures sharing order 9000001 (C-CDA organizer id under an Epic order root, org number 99).
const CCDA = join(import.meta.dirname, '..', 'fixtures', 'ccda-synthetic.xml');
const EHI = join(import.meta.dirname, '..', 'fixtures', 'ehi');
const fileHash = createHash('sha256').update(readFileSync(CCDA)).digest('hex');
let cfg: GaConfig;
let client: MedplumClient;
let pid: string;

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
  pid = await createTestPatient(client);
  await importPath(client, cfg, CCDA, pid);
});

// Same cleanup as ccda.test.ts: stable identifiers are global, delete what the fixture wrote (plus the patient compartment).
afterAll(async () => {
  for (const r of await convertCcda(readFileSync(CCDA, 'utf8'), cfg.converterUrl)) {
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
  await cleanupTestPatient(client, pid);
});

const ldl = () => client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|13457-7' }, { cache: 'no-cache' });
const systems = (r: Resource) => ((r as Observation).identifier ?? []).map((i) => i.system);
const tagged = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === 'urn:ga-server:tag' && t.code === code);

async function importEhi(ctx: EhiCtx, edit: (rs: Resource[]) => void = () => {}) {
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
  const { identified, unidentified, skippedNoName, report } = await importEhi(ctx);
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
  const again = await importEhi(ctx);
  expect(again.report).toMatchObject({ created: 0, updated: 0, possibleDuplicates: 0, invalid: 0 });
});

test('an EHI result of the same order with a different value is a possible duplicate', async () => {
  // Another org's export: distinct GA identifiers, so the content path (not the stable id) decides.
  const ctx: EhiCtx = { ...exportInfo(EHI), org: 'synthetic-health-b', epicOrgNumber: '99' };
  const { report } = await importEhi(ctx, (rs) => {
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
  await importResources(client, [ccdaEnc(`a-${csn}`), ccdaEnc(`b-${csn}`)], { kind: 'ccda', file: 'synthetic.xml', date: '2024-01-01', writer: 'importer' }, pid, 'h');
  const e = { resourceType: 'Encounter', id: 'x', identifier: [{ system: 'urn:ga-server:id:ehi:synthetic-health', value: `PAT_ENC|${csn}` }, ...ids], status: 'finished', subject: { reference: `Patient/${pid}` } } as Encounter;
  const { resources } = await resolveUnlinked(client, [e], pid);
  expect((resources[0] as Encounter).class?.code).toBe('UNK');
  const r = await importResources(client, resources, { kind: 'ehi', file: EHI, date: '2026-01-17T08:30:00-05:00', writer: 'importer' }, pid, 'h');
  expect(r).toMatchObject({ possibleDuplicates: 1, invalid: 0 });
});
