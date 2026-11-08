// `ga ccda replace` on Medplum (or the store with GA_STORE=sqlite), on a throwaway test Patient: Microsoft-era records made from
// the Epic-style fixture's Microsoft conversion, one visit also held from an EHI export, a follow-up pointing at the old report.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Basic, Encounter, Identifier, Provenance, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ccdaDate, convertCcdaLocal, custodian, importPath, repair } from '../../src/ccda.ts';
import { replaceCcda } from '../../src/ccda-replace.ts';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { storeDocument } from '../../src/document.ts';
import { batchKeys, COMPARTMENT, importResources } from '../../src/engine.ts';
import { hasTag, type SourceInfo } from '../../src/identity.ts';
import { cleanupTestMaps, cleanupTestPatient, createTestPatient } from './helpers.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
// The custodian renamed to a synthetic source the map cleanup knows; a leading-dot lab and a vaccine not given, which the
// Microsoft path stored as 11 and completed.
const XML = readFileSync(join(FIXTURES, 'ccda-epic-style.xml'), 'utf8')
  .replaceAll('<name>Example Health System</name>', '<name>Synthetic Clinic</name>')
  .replace('<value xsi:type="REAL" value="1.1"/>', '<value xsi:type="PQ" value=".11" unit="mg/dL"/>')
  .replace('negationInd="false">', 'negationInd="true">');
const MS = (JSON.parse(readFileSync(join(FIXTURES, 'ccda-epic-style.ms.json'), 'utf8')) as Resource[]).filter((r) => r.resourceType !== 'Coverage').map((r) =>
  (r as { identifier?: Identifier[] }).identifier?.[0]?.value === 'EX-RES-2' ? ({ ...r, valueQuantity: { value: 11, unit: 'mg/dL' } } as Resource) : r);
const CCDA = 'urn:ga-server:id:ccda';
const ENC_ID = { system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: 'EX-ENC-1' };
const idsOf = (r: Resource): Identifier[] => [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat();
const dir = mkdtempSync(join(tmpdir(), 'ga-replace-int-'));
const FILE = join(dir, 'DOC0001.XML');
const configFile = join(dir, 'config.json');
let client: MedplumClient;
let cfg: GaConfig;
let pid: string;
let fileHash: string;
let prov: Provenance | undefined; // outside the compartment: deleted after
const source = (local: boolean): SourceInfo => ({ kind: 'ccda', file: FILE, org: custodian(XML), date: ccdaDate(XML), writer: 'importer', ...(local && { local }) });

beforeAll(async () => {
  writeFileSync(FILE, XML);
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
  cfg = { patientId: pid, converterUrl: 'http://127.0.0.1:9/' };
  writeFileSync(configFile, JSON.stringify(cfg));
  await importResources(client, [{ resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
    subject: { reference: `Patient/${pid}` }, identifier: [{ system: `urn:ga-server:id:ehi:${pid}`, value: 'PAT_ENC|1' }, ENC_ID] } as Encounter],
  { kind: 'ehi', file: FILE, date: '2024-01-01', writer: 'importer' }, pid, 'ehi');
  fileHash = (await storeDocument(client, FILE, pid, 'application/xml')).fileHash;
  expect((await importResources(client, repair(structuredClone(MS), XML), source(false), pid, fileHash)).invalid).toBe(0);
});

// The compartment goes with the Patient. Records outside it (practitioners, organizations, a patient-less device) are found by
// the C-CDA keys either path gives them and deleted only when this test's file wrote them; then the stored file and the maps.
afterAll(async () => {
  if (!client || !pid) return;
  const keys = [batchKeys(repair(structuredClone(MS), XML), source(false), fileHash, pid), batchKeys(convertCcdaLocal(XML).resources, source(true), fileHash, pid)]
    .flatMap((b) => b.ordered.map((r) => [r.resourceType, b.idOf(r)] as const));
  for (const [type, key] of keys) {
    for (const hit of await client.searchResources(type as 'Observation', { identifier: `${CCDA}|${key}` }, { cache: 'no-cache' })) {
      const field = COMPARTMENT[type];
      if (hit.meta?.source === FILE && !(field && (hit as unknown as Record<string, unknown>)[field])) await client.deleteResource(type as 'Observation', hit.id as string);
    }
  }
  for (const d of await client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}`, subject: `Patient/${pid}` }, { cache: 'no-cache' })) {
    const bin = d.content?.[0]?.attachment?.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
    if (bin) await client.deleteResource('Binary', bin).catch(() => undefined);
    await client.deleteResource('DocumentReference', d.id as string);
  }
  if (prov) await client.deleteResource('Provenance', prov.id as string);
  await cleanupTestMaps(client);
  await cleanupTestPatient(client, pid);
});

const records = async (): Promise<Resource[]> => {
  const out: Resource[] = [];
  for (const [type, field] of [...Object.entries(COMPARTMENT), ['Basic', 'subject']]) {
    out.push(...(await client.searchResources(type as 'Observation', { [field]: `Patient/${pid}`, _count: '1000' }, { cache: 'no-cache' })));
  }
  return out.filter((r) => !idsOf(r).some((i) => i.system === 'urn:ga-server:id:file'));
};
const run = (yes: boolean) => replaceCcda(client, cfg, { yes, log: () => undefined, configFile, backup: async () => undefined });

test('ga ccda replace: a dry run changes nothing; the replace keeps the EHI visit, repoints the follow-up, and a re-import is a no-op', async () => {
  const [report] = await client.searchResources('DiagnosticReport', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  // A recorded follow-up as record_followup writes it: the Basic, and a Provenance naming the report it quotes.
  const followup = await client.createResource<Basic>({ resourceType: 'Basic', subject: { reference: `Patient/${pid}` }, created: '2026-01-01', code: { coding: [{ system: 'urn:ga-server:reminder', code: 'followup' }] },
    extension: [{ url: 'urn:ga-server:ext:topic', valueString: 'x' }, { url: 'urn:ga-server:ext:due', valueDate: '2027-01-01' }, { url: 'urn:ga-server:ext:quote', valueString: 'q' }] });
  prov = await client.createResource<Provenance>({ resourceType: 'Provenance', target: [{ reference: `Basic/${followup.id}` }], recorded: new Date().toISOString(),
    activity: { coding: [{ system: 'urn:ga-server:activity', code: 'followup' }] }, agent: [{ who: { display: 'test' } }], reason: [{ text: 'x' }],
    entity: [{ role: 'source', what: { reference: `DiagnosticReport/${report.id}` } }] });
  const [visit] = await client.searchResources('Encounter', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(idsOf(visit).some((i) => i.system === CCDA)).toBe(true); // linked on the Microsoft path

  const snap = async () => (await records()).map((r) => `${r.resourceType}/${r.id}@${r.meta?.versionId}`).sort();
  const before = await snap();
  const dry = await run(false);
  expect(await snap()).toEqual(before);
  expect(dry).toMatchObject({ stripped: { Encounter: 1 }, documents: 1 });

  const r = await run(true);
  expect(r).toMatchObject({ stripped: { Encounter: 1 }, kept: {}, dangling: 0, documents: 1 });
  expect(r.deleted).toEqual(dry.deleted);
  expect((JSON.parse(readFileSync(configFile, 'utf8')) as GaConfig).ccdaConverter).toBe('medplum');

  const all = await records();
  const visits = all.filter((x) => x.resourceType === 'Encounter');
  expect(visits.map((v) => v.id)).toEqual([visit.id]);
  expect(idsOf(visits[0]).filter((i) => i.system === CCDA).map((i) => i.value)).toEqual([`Encounter|${ENC_ID.system}|${ENC_ID.value}`]);
  const [newReport] = all.filter((x) => x.resourceType === 'DiagnosticReport');
  expect(newReport.id).not.toBe(report.id);
  expect((await client.readResource('Provenance', prov?.id as string)).entity?.[0].what.reference).toBe(`DiagnosticReport/${newReport.id}`);
  expect((all.find((x) => x.resourceType === 'Observation' && idsOf(x).some((i) => i.value === 'EX-RES-2')) as { valueQuantity?: { value?: number } }).valueQuantity?.value).toBe(0.11);
  expect(all.filter((x) => x.resourceType === 'Immunization').map((x) => (x as { status?: string }).status)).toEqual(['not-done']);
  expect(all.filter((x) => idsOf(x).some((i) => i.system === CCDA) && !hasTag(x, 'ccda-replace'))).toEqual([]);
  const keys = all.flatMap((x) => idsOf(x).filter((i) => i.system === CCDA).map((i) => i.value));
  expect(keys.length).toBe(new Set(keys).size);

  expect(await importPath(client, { ...cfg, ccdaConverter: 'medplum' }, FILE, pid)).toMatchObject({ created: 0, invalid: 0, possibleDuplicates: 0 });
  expect(await run(true)).toMatchObject({ deleted: {}, documents: 0 }); // no Microsoft-era Composition left: nothing to do
}, 120_000);
