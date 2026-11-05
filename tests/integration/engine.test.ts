import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, MedicationStatement, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { importResources } from '../../src/engine.ts';
import type { SourceInfo } from '../../src/identity.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let pid: string;
beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
});
afterAll(async () => cleanupTestPatient(client, pid));

const ccda = (date: string): SourceInfo => ({ kind: 'ccda', file: 'synthetic.xml', date, writer: 'importer' });
// Source ids are random per test: identifier search is global, never match leftovers or real data.
const uid = (p: string) => `${p}-${randomUUID()}`;
const TAG = 'urn:ga-server:tag';
const tagged = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);
// Batches without a source Patient reference the test patient directly (collapse only rewrites batch Patients).
const subj = { reference: 'Patient/src-pt' };
const me = () => ({ reference: `Patient/${pid}` });
const chol = (id: string, value: number, day = '2024-02-03'): Observation => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '2093-3' }] },
  effectiveDateTime: day,
  valueQuantity: { value, unit: 'mg/dL' },
  subject: me(),
});
const med = (id: string, status: MedicationStatement['status']): MedicationStatement => ({
  resourceType: 'MedicationStatement',
  id,
  status,
  medicationCodeableConcept: { text: 'synthetic-med' },
  subject: me(),
});
const all = async (): Promise<Resource[]> =>
  ((await client.get<Bundle>(`fhir/R4/Patient/${pid}/$everything?_count=1000`, { cache: 'no-cache' })).entry ?? [])
    .map((e) => e.resource as Resource)
    .filter((r) => r.resourceType !== 'Patient');

test('reimport is a no-op', async () => {
  const mrn = uid('mrn');
  const enc = uid('enc');
  const batch: Resource[] = [
    { resourceType: 'Patient', id: 'src-pt', identifier: [{ system: 'urn:test:mrn', value: mrn }] },
    { resourceType: 'Encounter', id: enc, status: 'finished', class: { code: 'AMB' }, subject: subj },
    { ...chol(uid('obs'), 150, '2023-01-05'), subject: subj, encounter: { reference: `urn:uuid:${enc}` } },
    { resourceType: 'Condition', id: uid('cond'), code: { text: 'synthetic-condition' }, subject: subj },
    { ...med(uid('med'), 'active'), subject: subj },
    {
      resourceType: 'AllergyIntolerance',
      id: uid('alg'),
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
      code: { text: 'synthetic-allergen' },
      patient: subj,
    },
  ];
  const first = await importResources(client, batch, ccda('2024-01-01'), pid, 'h');
  expect(first).toMatchObject({ created: 5, updated: 0 });
  const before = (await all()).length;
  const second = await importResources(client, batch, ccda('2024-01-01'), pid, 'h');
  expect(second).toEqual({ created: 0, updated: 0, skipped: 5, merged: 0, conflicts: 0, possibleDuplicates: 0 });
  expect((await all()).length).toBe(before);
  const p = await client.readResource('Patient', pid);
  expect((p as Patient).identifier?.filter((i) => i.value === mrn)).toHaveLength(1);
});

test('rewrites intra-bundle references', async () => {
  const enc = uid('enc');
  const obs = { ...chol(uid('obs'), 140, '2023-02-01'), encounter: { reference: `Encounter/${enc}` } };
  // Observation first: the engine must order the Encounter before it.
  await importResources(client, [obs, { resourceType: 'Encounter', id: enc, status: 'finished', class: { code: 'AMB' }, subject: me() }], ccda('2024-01-01'), pid, 'h');
  const e = await client.searchOne('Encounter', { identifier: `urn:ga-server:id:ccda|${enc}` });
  const o = await client.searchOne('Observation', { identifier: `urn:ga-server:id:ccda|${obs.id}` });
  expect(o?.encounter?.reference).toBe(`Encounter/${e?.id}`);
  expect(o?.subject?.reference).toBe(`Patient/${pid}`);
});

test('throws on reference cycle', async () => {
  const a = uid('a');
  const b = uid('b');
  const before = (await all()).length;
  await expect(
    importResources(client, [
      { ...chol(a, 1, '2023-03-01'), hasMember: [{ reference: `Observation/${b}` }] },
      { ...chol(b, 2, '2023-03-01'), hasMember: [{ reference: `urn:uuid:${a}` }] },
    ], ccda('2024-01-01'), pid, 'h'),
  ).rejects.toThrow(/reference cycle/);
  expect((await all()).length).toBe(before);
});

test('content match with different identifier merges', async () => {
  const a = chol(uid('obs'), 199, '2023-04-01');
  const b = chol(uid('obs'), 199, '2023-04-01');
  expect(await importResources(client, [a], ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 1 });
  expect(await importResources(client, [b], ccda('2024-02-01'), pid, 'h')).toMatchObject({ created: 0, merged: 1 });
  const found = await client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|2093-3', date: '2023-04-01' });
  expect(found).toHaveLength(1);
  expect(found[0].identifier?.map((i) => i.value).sort()).toEqual([a.id, b.id].sort());
  expect(await importResources(client, [b], ccda('2024-02-01'), pid, 'h')).toMatchObject({ skipped: 1, merged: 0 });
});

test('different value flags possible-duplicate', async () => {
  const a = chol(uid('obs'), 180, '2023-05-01');
  const b = chol(uid('obs'), 220, '2023-05-01');
  await importResources(client, [a], ccda('2024-01-01'), pid, 'h');
  expect(await importResources(client, [b], ccda('2024-02-01'), pid, 'h')).toMatchObject({ possibleDuplicates: 1, merged: 0 });
  const found = await client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|2093-3', date: '2023-05-01' });
  expect(found).toHaveLength(2);
  for (const o of found) {
    expect(tagged(o, 'possible-duplicate')).toBe(true);
    const other = found.find((x) => x.id !== o.id);
    expect(o.extension?.find((e) => e.url === 'urn:ga-server:ext:possible-duplicate-of')?.valueReference?.reference).toBe(`Observation/${other?.id}`);
  }
});

test('newer source updates MedicationStatement status', async () => {
  const id = uid('med');
  await importResources(client, [med(id, 'active')], ccda('2024-01-01'), pid, 'h');
  expect(await importResources(client, [med(id, 'stopped')], ccda('2024-06-01'), pid, 'h')).toMatchObject({ updated: 1 });
  const m = await client.searchOne('MedicationStatement', { identifier: `urn:ga-server:id:ccda|${id}` });
  expect(m?.status).toBe('stopped');
  expect((await client.readHistory('MedicationStatement', m?.id as string)).entry).toHaveLength(2);
});

test('older source after newer does not revert', async () => {
  const id = uid('med');
  await importResources(client, [med(id, 'stopped')], ccda('2024-06-01'), pid, 'h');
  expect(await importResources(client, [med(id, 'active')], ccda('2024-03-01'), pid, 'h')).toMatchObject({ skipped: 1, updated: 0 });
  const m = await client.searchOne('MedicationStatement', { identifier: `urn:ga-server:id:ccda|${id}` });
  expect(m?.status).toBe('stopped');
});

test('merged observation differing in a non-key field re-imports as a no-op', async () => {
  const a = { ...chol(uid('obs'), 205, '2023-07-01'), issued: '2023-07-02T00:00:00Z' };
  const b = { ...chol(uid('obs'), 205, '2023-07-01'), issued: '2023-07-09T00:00:00Z' };
  await importResources(client, [a], ccda('2024-01-01'), pid, 'h');
  expect(await importResources(client, [b], ccda('2024-02-01'), pid, 'h')).toMatchObject({ merged: 1, created: 0 });
  expect(await importResources(client, [b], ccda('2024-02-01'), pid, 'h')).toMatchObject({ skipped: 1, updated: 0, merged: 0 });
  expect(await importResources(client, [a], ccda('2024-01-01'), pid, 'h')).toMatchObject({ skipped: 1, updated: 0, merged: 0 });
  const found = await client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|2093-3', date: '2023-07-01' });
  expect(found).toHaveLength(1);
  expect(found[0].identifier).toHaveLength(2);
});

test('equal value already written by the agent is skipped without a conflict', async () => {
  const agent: SourceInfo = { kind: 'pdf', file: 'synthetic.pdf', date: '2024-01-01', writer: 'agent', llm: true };
  await importResources(client, [chol(uid('obs'), 210, '2023-08-01')], agent, pid, uid('file'));
  const b = chol(uid('obs'), 210, '2023-08-01');
  for (let i = 0; i < 2; i++) {
    expect(await importResources(client, [b], ccda('2024-02-01'), pid, 'h')).toMatchObject({ skipped: 1, conflicts: 0, merged: 0, created: 0 });
  }
  const found = await client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|2093-3', date: '2023-08-01' });
  expect(found).toHaveLength(1);
  expect(tagged(found[0], 'source-conflict')).toBe(false);
  expect(found[0].identifier).toHaveLength(1);
});

test('newer importer source does not overwrite agent-written record', async () => {
  const id = uid('med');
  // Same ccda identifier on both sides so the importer finds the agent's record by identifier.
  await importResources(client, [med(id, 'active')], { ...ccda('2024-01-01'), writer: 'agent' }, pid, 'h');
  expect(await importResources(client, [med(id, 'stopped')], ccda('2024-06-01'), pid, 'h')).toMatchObject({ conflicts: 1, updated: 0 });
  expect(await importResources(client, [med(id, 'stopped')], ccda('2024-06-01'), pid, 'h')).toMatchObject({ conflicts: 1, updated: 0 });
  const m = await client.searchOne('MedicationStatement', { identifier: `urn:ga-server:id:ccda|${id}` });
  expect(m?.status).toBe('active');
  expect(m?.meta?.tag?.filter((t) => t.system === TAG && t.code === 'source-conflict')).toHaveLength(1);
});
