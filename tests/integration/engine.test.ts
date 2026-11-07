import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Condition, MedicationStatement, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { CONCEPT_SRC } from '../../src/concept-apply.ts';
import { loadMaps, lookup, mapUrl, sourceKey, upsertEntry } from '../../src/conceptmap.ts';
import { importResources } from '../../src/engine.ts';
import { APPLE, LAST_SEEN, type SourceInfo, stableIdentifier } from '../../src/identity.ts';
import { cleanupTestMaps, cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let pid: string;
beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
});
afterAll(async () => {
  await cleanupTestMaps(client);
  await cleanupTestPatient(client, pid);
});

const ccda = (date: string): SourceInfo => ({ kind: 'ccda', file: 'synthetic.xml', date, writer: 'importer' });
// Source ids are random per test: identifier search is global, never match leftovers or real data.
const uid = (p: string) => `${p}-${randomUUID()}`;
const TAG = 'urn:ga-server:tag';
const tagged = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);
// Batches without a source Patient reference the test patient directly (collapse only rewrites batch Patients).
const subj = { reference: 'Patient/src-pt' };
const me = () => ({ reference: `Patient/${pid}` });
// ccda identity keys on the source identifier (R6); test resources carry one under urn:test:src.
const src = (id: string) => [{ system: 'urn:test:src', value: id }];
const key = (type: string, id: string) => `urn:ga-server:id:ccda|${type}|urn:test:src|${id}`;
const ccdaIds = (r: Resource) => ((r as Observation).identifier ?? []).filter((i) => i.system === 'urn:ga-server:id:ccda').map((i) => i.value);
const chol = (id: string, value: number, day = '2024-02-03'): Observation => ({
  resourceType: 'Observation',
  id,
  identifier: src(id),
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '2093-3' }] },
  effectiveDateTime: day,
  valueQuantity: { value, unit: 'mg/dL' },
  subject: me(),
});
const med = (id: string, status: MedicationStatement['status']): MedicationStatement => ({
  resourceType: 'MedicationStatement',
  id,
  identifier: src(id),
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
  expect(second).toEqual({ created: 0, updated: 0, skipped: 5, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: [] });
  expect((await all()).length).toBe(before);
  const p = await client.readResource('Patient', pid);
  expect((p as Patient).identifier?.filter((i) => i.value === mrn)).toHaveLength(1);
});

test('rewrites intra-bundle references', async () => {
  const enc = uid('enc');
  const obs = { ...chol(uid('obs'), 140, '2023-02-01'), encounter: { reference: `Encounter/${enc}` } };
  // Observation first: the engine must order the Encounter before it.
  await importResources(client, [obs, { resourceType: 'Encounter', id: enc, identifier: src(enc), status: 'finished', class: { code: 'AMB' }, subject: me() }], ccda('2024-01-01'), pid, 'h');
  const e = await client.searchOne('Encounter', { identifier: `urn:test:src|${enc}` });
  const o = await client.searchOne('Observation', { identifier: `urn:test:src|${obs.id}` });
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
  expect(ccdaIds(found[0]).sort()).toEqual([a, b].map((o) => stableIdentifier(o, ccda('x'), 'h', pid).value).sort());
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
  const m = await client.searchOne('MedicationStatement', { identifier: key('MedicationStatement', id) });
  expect(m?.status).toBe('stopped');
  expect((await client.readHistory('MedicationStatement', m?.id as string)).entry).toHaveLength(2);
});

test('older source after newer does not revert', async () => {
  const id = uid('med');
  await importResources(client, [med(id, 'stopped')], ccda('2024-06-01'), pid, 'h');
  expect(await importResources(client, [med(id, 'active')], ccda('2024-03-01'), pid, 'h')).toMatchObject({ skipped: 1, updated: 0 });
  const m = await client.searchOne('MedicationStatement', { identifier: key('MedicationStatement', id) });
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
  expect(ccdaIds(found[0])).toHaveLength(2);
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
  expect(ccdaIds(found[0])).toHaveLength(0);
});

test('same day but different time of day flags possible-duplicate, not a merge', async () => {
  const a = chol(uid('obs'), 230, '2023-10-01T08:00:00Z');
  const b = chol(uid('obs'), 230, '2023-10-01T17:30:00Z');
  await importResources(client, [a], ccda('2024-01-01'), pid, 'h');
  expect(await importResources(client, [b], ccda('2024-02-01'), pid, 'h')).toMatchObject({ possibleDuplicates: 1, merged: 0 });
  const found = await client.searchResources('Observation', `subject=Patient/${pid}&code=http://loinc.org|2093-3&date=ge2023-10-01&date=lt2023-10-02`);
  expect(found).toHaveLength(2);
  expect(found.every((o) => tagged(o, 'possible-duplicate'))).toBe(true);
});

test('agent value equal to an importer record only adds its identifier; the hospital body stays', async () => {
  const a = { ...chol(uid('obs'), 240, '2023-11-01'), interpretation: [{ text: 'hospital' }] };
  await importResources(client, [a], ccda('2024-01-01'), pid, 'h');
  const [before] = await client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|2093-3', date: '2023-11-01' });
  const agent: SourceInfo = { kind: 'pdf', file: 'synthetic.pdf', date: '2025-01-01', writer: 'agent', llm: true };
  const b = { ...chol(uid('obs'), 240, '2023-11-01'), interpretation: [{ text: 'llm' }] };
  expect(await importResources(client, [b], agent, pid, uid('file'))).toMatchObject({ merged: 1, created: 0, updated: 0 });
  const found = await client.searchResources('Observation', { subject: `Patient/${pid}`, code: 'http://loinc.org|2093-3', date: '2023-11-01' }, { cache: 'no-cache' });
  expect(found).toHaveLength(1);
  const gaIds = (found[0].identifier ?? []).filter((i) => i.system?.startsWith('urn:ga-server:id:'));
  expect(gaIds.map((i) => i.system).sort()).toEqual(['urn:ga-server:id:ccda', 'urn:ga-server:id:pdf']);
  expect(found[0].interpretation).toEqual(before.interpretation);
  expect(tagged(found[0], 'writer-importer')).toBe(true);
  expect(await importResources(client, [a], ccda('2024-01-01'), pid, 'h')).toMatchObject({ skipped: 1, updated: 0, merged: 0 });
});

test('newer importer source does not overwrite agent-written record', async () => {
  const id = uid('med');
  // Same ccda identifier on both sides so the importer finds the agent's record by identifier.
  await importResources(client, [med(id, 'active')], { ...ccda('2024-01-01'), writer: 'agent' }, pid, 'h');
  expect(await importResources(client, [med(id, 'stopped')], ccda('2024-06-01'), pid, 'h')).toMatchObject({ conflicts: 1, updated: 0 });
  expect(await importResources(client, [med(id, 'stopped')], ccda('2024-06-01'), pid, 'h')).toMatchObject({ conflicts: 1, updated: 0 });
  const m = await client.searchOne('MedicationStatement', { identifier: key('MedicationStatement', id) });
  expect(m?.status).toBe('active');
  expect(m?.meta?.tag?.filter((t) => t.system === TAG && t.code === 'source-conflict')).toHaveLength(1);
});

test('one invalid resource does not abort the batch', async () => {
  const bad = { resourceType: 'Observation', id: uid('obs'), status: 'final', subject: me() } as Observation; // no code
  const r = await importResources(client, [bad, chol(uid('obs'), 121, '2023-09-01')], ccda('2024-01-01'), pid, 'h');
  expect(r).toMatchObject({ created: 1, invalid: 1 });
});

test('two different resources sharing one source id are both stored; re-import is a no-op', async () => {
  const sid = uid('cond');
  const c = (code: string): Resource =>
    ({ resourceType: 'Condition', id: uid('c'), identifier: src(sid), code: { coding: [{ system: 'http://snomed.info/sct', code }] }, subject: me() }) as Resource;
  const batch = [c('111'), c('222')];
  expect(await importResources(client, batch, ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 2 });
  expect(await importResources(client, batch, ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 0, updated: 0, skipped: 2 });
  expect(await client.searchResources('Condition', { identifier: `urn:test:src|${sid}` }, { cache: 'no-cache' })).toHaveLength(2);
});

test('source patient demographics fill the GA patient once and never overwrite', async () => {
  const sp = (birthDate: string): Patient => ({ resourceType: 'Patient', id: 'src-demo', birthDate, gender: 'female', name: [{ family: 'Synthetic', given: ['Test'] }] });
  await importResources(client, [sp('1970-01-02')], ccda('2024-01-01'), pid, 'h');
  const p1 = await client.readResource('Patient', pid);
  expect([p1.birthDate, p1.gender, p1.name?.[0]?.family]).toEqual(['1970-01-02', 'female', 'Synthetic']);
  await importResources(client, [sp('1970-01-02')], ccda('2024-01-01'), pid, 'h');
  expect((await client.readResource('Patient', pid)).meta?.versionId).toBe(p1.meta?.versionId);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await importResources(client, [sp('1999-09-09')], ccda('2024-01-01'), pid, 'h');
    expect(err).toHaveBeenCalledWith('patient demographic conflict: birthDate');
  } finally {
    err.mockRestore();
  }
  const p3 = await client.readResource('Patient', pid);
  expect(p3.birthDate).toBe('1970-01-02');
  expect(p3.meta?.versionId).toBe(p1.meta?.versionId);
});

// EHI: GA identifier first, then Epic link identifiers (synthetic values under Epic-standard OID roots).
const ehiSrc = (date: string, file = 'synthetic-ehi'): SourceInfo => ({ kind: 'ehi', file, date, writer: 'importer' });
const EHI_SYS = 'urn:ga-server:id:ehi:synthetic-org';
const CSN_OID = 'urn:oid:1.2.840.114350.1.13.99.2.7.3.698084.8';
const PROBLEM_OID = 'urn:oid:1.2.840.114350.1.13.99.2.7.2.768076';
const enc = (ids: { system: string; value: string }[], status: 'finished' | 'cancelled', patient = pid) =>
  ({ resourceType: 'Encounter', id: uid('e'), identifier: ids, status, class: { code: 'AMB' }, subject: { reference: `Patient/${patient}` } }) as Resource;
const problem = (ids: { system: string; value: string }[], status: 'active' | 'resolved', patient = pid) =>
  ({
    resourceType: 'Condition',
    id: uid('c'),
    identifier: ids,
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }] },
    code: { text: 'synthetic-problem' },
    subject: { reference: `Patient/${patient}` },
  }) as Resource;
const byId = <T extends 'Encounter' | 'Condition'>(type: T, system: string, value: string) =>
  client.searchResources(type, { identifier: `${system}|${value}` }, { cache: 'no-cache' });
const systems = (r: Resource) => ((r as Observation).identifier ?? []).map((i) => i.system).sort();

test('link identifier merges an EHI Encounter into the C-CDA Encounter with the same CSN', async () => {
  const csn = { system: CSN_OID, value: uid('csn') };
  await importResources(client, [enc([csn], 'finished')], ccda('2024-01-01'), pid, 'h');
  const e = enc([{ system: EHI_SYS, value: `PAT_ENC|${csn.value}` }, csn], 'cancelled');
  expect(await importResources(client, [e], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ created: 0, updated: 1 });
  const found = await byId('Encounter', csn.system, csn.value);
  expect(found).toHaveLength(1);
  expect(systems(found[0])).toEqual([CSN_OID, EHI_SYS, 'urn:ga-server:id:ccda'].sort());
  expect(found[0].status).toBe('cancelled');
  expect(await importResources(client, [e], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 0, skipped: 1 });
});

test('newer export updates a problem; older export does not revert', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  const ehiId = { system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` };
  await importResources(client, [problem([pl], 'active')], ccda('2024-01-01'), pid, 'h');
  expect(await importResources(client, [problem([ehiId, pl], 'resolved')], ehiSrc('2026-01-01'), pid, 'h')).toMatchObject({ updated: 1, created: 0 });
  expect(await importResources(client, [problem([ehiId, pl], 'active')], ehiSrc('2025-06-01', 'older-ehi'), pid, 'h')).toMatchObject({
    created: 0,
    updated: 0,
    skipped: 1,
  });
  const found = await byId('Condition', pl.system, pl.value);
  expect(found).toHaveLength(1);
  expect(found[0].clinicalStatus?.coding?.[0]?.code).toBe('resolved');
});

test('link identifier never crosses patients', async () => {
  const other = await createTestPatient(client);
  try {
    const pl = { system: PROBLEM_OID, value: uid('pl') };
    await importResources(client, [problem([pl], 'active', other)], ccda('2024-01-01'), other, 'h');
    const r = await importResources(client, [problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'resolved')], ehiSrc('2026-11-04'), pid, 'h');
    expect(r).toMatchObject({ created: 1, updated: 0, merged: 0 });
    const found = await byId('Condition', pl.system, pl.value);
    expect(found.map((c) => c.subject?.reference).sort()).toEqual([`Patient/${other}`, `Patient/${pid}`].sort());
    const theirs = found.find((c) => c.subject?.reference === `Patient/${other}`) as Resource;
    expect(systems(theirs)).not.toContain(EHI_SYS);
  } finally {
    await cleanupTestPatient(client, other);
  }
});

test('an older EHI source only adds its identifier to the linked record; re-import is a no-op', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  const e = problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'resolved');
  await importResources(client, [problem([pl], 'active')], ccda('2026-06-01'), pid, 'h');
  expect(await importResources(client, [e], ehiSrc('2026-01-01'), pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 1 });
  const found = await byId('Condition', pl.system, pl.value);
  expect(found).toHaveLength(1);
  expect(systems(found[0])).toContain(EHI_SYS);
  expect(found[0].clinicalStatus?.coding?.[0]?.code).toBe('active');
  expect(await importResources(client, [e], ehiSrc('2026-01-01'), pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 0, skipped: 1 });
});

test('a C-CDA batch with two different Encounters sharing one CSN stores both; re-import is a no-op', async () => {
  const csn = { system: CSN_OID, value: uid('csn') };
  const batch = [enc([csn], 'finished'), enc([csn], 'cancelled')];
  expect(await importResources(client, batch, ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 2 });
  expect(await importResources(client, batch, ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 0, skipped: 2 });
  expect(await byId('Encounter', csn.system, csn.value)).toHaveLength(2);
});

test('a patient-compartment resource without a subject does not link to another patient record', async () => {
  const other = await createTestPatient(client);
  const csn = { system: CSN_OID, value: uid('csn') };
  const ehiId = { system: EHI_SYS, value: `PAT_ENC|${csn.value}` };
  try {
    await importResources(client, [enc([csn], 'finished', other)], ccda('2024-01-01'), other, 'h');
    const { subject: _s, ...noSubject } = enc([ehiId, csn], 'cancelled') as Resource & { subject?: unknown };
    expect(await importResources(client, [noSubject as Resource], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ created: 1, updated: 0, merged: 0 });
    const theirs = (await byId('Encounter', csn.system, csn.value)).find((e) => e.subject?.reference === `Patient/${other}`) as Resource;
    expect(systems(theirs)).not.toContain(EHI_SYS);
    expect((theirs as { status?: string }).status).toBe('finished');
  } finally {
    // outside any patient compartment, so cleanupTestPatient would miss it
    for (const e of await byId('Encounter', ehiId.system, ehiId.value)) await client.deleteResource('Encounter', e.id as string);
    await cleanupTestPatient(client, other);
  }
});

test('a C-CDA Encounter without subject and Device without patient are found again on re-import', async () => {
  const e = uid('enc');
  const d = uid('dev');
  const batch: Resource[] = [
    { resourceType: 'Encounter', id: e, identifier: src(e), status: 'finished', class: { code: 'AMB' } },
    { resourceType: 'Device', id: d, identifier: src(d), deviceName: [{ name: 'synthetic-ehr', type: 'user-friendly-name' }] },
  ];
  try {
    expect(await importResources(client, batch, ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 2 });
    expect(await importResources(client, batch, ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 0, skipped: 2 });
  } finally {
    // outside any patient compartment, so cleanupTestPatient would miss them
    for (const [type, id] of [['Encounter', e], ['Device', d]] as const)
      for (const r of await client.searchResources(type, { identifier: `urn:test:src|${id}` }, { cache: 'no-cache' })) await client.deleteResource(type, r.id as string);
  }
});

const dupOf = (r: Resource) => ((r as Observation).extension ?? []).filter((e) => e.url === 'urn:ga-server:ext:possible-duplicate-of').map((e) => e.valueReference?.reference);

test('an ambiguous link creates a possible-duplicate pointing at every candidate', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  // two different C-CDA problems sharing one Epic id (collision guard stores both)
  const a = { ...problem([pl], 'active'), code: { text: 'synthetic-a' } } as Resource;
  const b = { ...problem([pl], 'active'), code: { text: 'synthetic-b' } } as Resource;
  expect(await importResources(client, [a, b], ccda('2024-01-01'), pid, 'h')).toMatchObject({ created: 2 });
  const e = problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'resolved');
  expect(await importResources(client, [e], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 0, possibleDuplicates: 1 });
  const found = await byId('Condition', pl.system, pl.value);
  expect(found).toHaveLength(3);
  expect(found.every((c) => tagged(c, 'possible-duplicate'))).toBe(true);
  const created = found.find((c) => systems(c).includes(EHI_SYS)) as Resource;
  const olds = found.filter((c) => c !== created);
  expect(dupOf(created).sort()).toEqual(olds.map((c) => `Condition/${c.id}`).sort());
  for (const c of olds) expect(dupOf(c)).toEqual([`Condition/${created.id}`]);
  expect(await importResources(client, [e], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ created: 0, updated: 0, possibleDuplicates: 0, skipped: 1 });
});

test('a second EHI record with an Epic id already linked by another EHI record is flagged, not merged', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  await importResources(client, [problem([pl], 'active')], ccda('2024-01-01'), pid, 'h');
  const e1 = problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'active');
  const e2 = { ...problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}-2` }, pl], 'resolved'), code: { text: 'synthetic-other' } } as Resource;
  expect(await importResources(client, [e1, e2], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ created: 0, updated: 1, possibleDuplicates: 1 });
  const found = await byId('Condition', pl.system, pl.value);
  expect(found).toHaveLength(2);
  expect(found.every((c) => tagged(c, 'possible-duplicate'))).toBe(true);
});

// R11: an EHI update keeps top-level fields the export lacks; the export's own fields win.
test('an EHI problem without a name keeps the C-CDA name and takes the EHI status', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  await importResources(client, [problem([pl], 'active')], ccda('2024-01-01'), pid, 'h');
  const { code: _c, ...nameless } = problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'resolved') as Resource & { code?: unknown };
  expect(await importResources(client, [nameless as Resource], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ updated: 1, created: 0 });
  const [found] = await byId('Condition', pl.system, pl.value);
  expect(found.code?.text).toBe('synthetic-problem');
  expect(found.clinicalStatus?.coding?.[0]?.code).toBe('resolved');
  expect(await importResources(client, [nameless as Resource], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ updated: 0, skipped: 1 });
});

test('an EHI Encounter without class keeps the C-CDA class', async () => {
  const csn = { system: CSN_OID, value: uid('csn') };
  await importResources(client, [enc([csn], 'finished')], ccda('2024-01-01'), pid, 'h');
  const { class: _k, ...classless } = enc([{ system: EHI_SYS, value: `PAT_ENC|${csn.value}` }, csn], 'cancelled') as Resource & { class?: unknown };
  expect(await importResources(client, [classless as Resource], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ updated: 1 });
  const [found] = await byId('Encounter', csn.system, csn.value);
  expect(found.class?.code).toBe('AMB');
  expect(found.status).toBe('cancelled');
});

test('a newer C-CDA update still replaces the body', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  const id = uid('src');
  await importResources(client, [{ ...problem([pl], 'active'), id, identifier: src(id) } as Resource], ccda('2024-01-01'), pid, 'h');
  const { code: _c, ...nameless } = { ...problem([pl], 'resolved'), id, identifier: src(id) } as Resource & { code?: unknown };
  expect(await importResources(client, [nameless as Resource], ccda('2025-01-01'), pid, 'h')).toMatchObject({ updated: 1 });
  const [found] = await client.searchResources('Condition', { identifier: key('Condition', id) }, { cache: 'no-cache' });
  expect(found.code).toBeUndefined();
  expect(found.clinicalStatus?.coding?.[0]?.code).toBe('resolved');
});

// R11 fill never keeps a field that contradicts the incoming record.
test('an active EHI problem over a C-CDA problem with abatement drops the abatement', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  await importResources(client, [{ ...problem([pl], 'resolved'), abatementDateTime: '2023-01-01', onsetPeriod: { start: '2020-01-01' }, text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">old</div>' } } as Resource], ccda('2024-01-01'), pid, 'h');
  const { code: _c, ...e } = { ...problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'active'), onsetDateTime: '2020-01-02' } as Resource & { code?: unknown };
  expect(await importResources(client, [e as Resource], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ updated: 1 });
  const [found] = await byId('Condition', pl.system, pl.value);
  expect(found.code?.text).toBe('synthetic-problem');
  expect(found.clinicalStatus?.coding?.[0]?.code).toBe('active');
  expect(found.abatementDateTime).toBeUndefined();
  expect(found.onsetDateTime).toBe('2020-01-02');
  expect(found.onsetPeriod).toBeUndefined();
  expect(found.text).toBeUndefined();
});

test('an entered-in-error EHI problem drops the C-CDA clinical status and abatement', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  await importResources(client, [{ ...problem([pl], 'resolved'), abatementDateTime: '2023-01-01' } as Resource], ccda('2024-01-01'), pid, 'h');
  const { code: _c, clinicalStatus: _s, ...e } = {
    ...problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'active'),
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'entered-in-error' }] },
  } as Resource & { code?: unknown; clinicalStatus?: unknown };
  expect(await importResources(client, [e as Resource], ehiSrc('2026-11-04'), pid, 'h')).toMatchObject({ updated: 1 });
  const [found] = await byId('Condition', pl.system, pl.value);
  expect(found.clinicalStatus).toBeUndefined();
  expect(found.verificationStatus?.coding?.[0]?.code).toBe('entered-in-error');
  expect(found.abatementDateTime).toBeUndefined();
});

const apple = (date: string): SourceInfo => ({ kind: 'apple-health', file: 'synthetic-apple.xml', date, writer: 'importer' });
const weight = (sys: string, id: string, at: string, kg: number): Observation => ({
  resourceType: 'Observation',
  identifier: [{ system: sys, value: id }],
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '29463-7' }] },
  effectiveDateTime: at,
  valueQuantity: { value: kg, unit: 'kg' },
  subject: me(),
});
const hospital = (at: string, kg: number) => weight(EHI_SYS, uid('h'), at, kg);
const phone = (at: string, kg: number) => weight(APPLE, uid('a'), at, kg);
const flagged = async () => (await all()).filter((r) => tagged(r, 'possible-duplicate') && (r as Observation).code?.coding?.[0]?.code === '29463-7');

test('apple reading on a hospital day is not a possible duplicate', async () => {
  const day = '2026-03-01';
  await importResources(client, [hospital(`${day}T09:00:00-05:00`, 80)], ehiSrc('2026-01-01'), pid, 'h');
  expect(await importResources(client, [phone(`${day}T07:00:00-05:00`, 79)], apple('2026-11-05'), pid, 'a')).toMatchObject({ possibleDuplicates: 0, created: 1 });
  expect(await flagged()).toHaveLength(0);
});

test('hospital reading after apple on the same day is not a possible duplicate', async () => {
  const day = '2026-03-02';
  await importResources(client, [phone(`${day}T07:00:00-05:00`, 79)], apple('2026-11-05'), pid, 'a');
  expect(await importResources(client, [hospital(`${day}T09:00:00-05:00`, 80)], ehiSrc('2026-12-01'), pid, 'h')).toMatchObject({ possibleDuplicates: 0, created: 1 });
  expect(await flagged()).toHaveLength(0);
});

test('two apple readings same day are both kept', async () => {
  const day = '2026-03-03';
  const r = await importResources(client, [phone(`${day}T07:00:00-05:00`, 79), phone(`${day}T21:00:00-05:00`, 79.4)], apple('2026-11-05'), pid, 'a');
  expect(r).toMatchObject({ created: 2, possibleDuplicates: 0 });
});

test('apple exact match keeps the hospital body', async () => {
  const at = '2026-03-04T09:00:00-05:00';
  const h = { ...hospital(at, 80), note: [{ text: 'clinic' }] };
  await importResources(client, [h], ehiSrc('2026-01-01'), pid, 'h');
  const a = phone(at, 80);
  expect(await importResources(client, [a], apple('2026-11-05'), pid, 'a')).toMatchObject({ merged: 1, created: 0 });
  const rows = (await all()).filter((r) => r.resourceType === 'Observation' && (r as Observation).effectiveDateTime === at) as Observation[];
  expect(rows).toHaveLength(1);
  expect(rows[0].note?.[0].text).toBe('clinic');
  expect(rows[0].identifier?.map((i) => i.system)).toEqual(expect.arrayContaining([EHI_SYS, APPLE]));
  // Re-import: found by its Apple identifier on the hospital record; nothing is written.
  expect(await importResources(client, [a], apple('2026-11-05'), pid, 'a')).toMatchObject({ created: 0, updated: 0, conflicts: 0, merged: 0, skipped: 1 });
  const again = (await all()).find((r) => r.id === rows[0].id) as Observation;
  expect(again.note?.[0].text).toBe('clinic');
  expect(tagged(again, 'src-ehi')).toBe(true);
});

const rowAt = async (at: string) => ((await all()).filter((r) => r.resourceType === 'Observation' && (r as Observation).effectiveDateTime === at)) as Observation[];

test('hospital exact match after apple wins, and a newer apple export changes nothing', async () => {
  const at = '2026-03-05T09:00:00-05:00';
  const a = phone(at, 80);
  await importResources(client, [a], apple('2026-11-05'), pid, 'a');
  expect(await importResources(client, [{ ...hospital(at, 80), note: [{ text: 'clinic' }] }], ehiSrc('2026-12-01'), pid, 'h')).toMatchObject({ merged: 1, created: 0 });
  let rows = await rowAt(at);
  expect(rows).toHaveLength(1);
  expect(rows[0].note?.[0].text).toBe('clinic');
  expect(await importResources(client, [a], apple('2027-01-01'), pid, 'a')).toMatchObject({ created: 0, updated: 0, conflicts: 0 });
  rows = await rowAt(at);
  expect(rows).toHaveLength(1);
  expect(rows[0].note?.[0].text).toBe('clinic');
  expect(tagged(rows[0], 'src-ehi')).toBe(true);
  expect(rows[0].identifier?.map((i) => i.system)).toContain(APPLE);
});

test('older hospital export exact match still beats an apple-only record', async () => {
  const at = '2026-03-06T09:00:00-05:00';
  await importResources(client, [phone(at, 80)], apple('2026-11-05'), pid, 'a');
  await importResources(client, [{ ...hospital(at, 80), note: [{ text: 'clinic' }] }], ehiSrc('2026-01-01'), pid, 'h');
  const rows = await rowAt(at);
  expect(rows).toHaveLength(1);
  expect(rows[0].note?.[0].text).toBe('clinic');
  expect(tagged(rows[0], 'src-ehi')).toBe(true);
  expect(rows[0].identifier?.map((i) => i.system)).toContain(APPLE);
});

test('one Apple identifier for two patients makes two records; the first is never moved or changed', async () => {
  const other = await createTestPatient(client);
  try {
    const id = uid('daily'); // Apple daily ids are sha(type|day): the same for every patient
    const at = '2026-03-07';
    const theirs = { ...weight(APPLE, id, at, 70), subject: { reference: `Patient/${other}` } };
    expect(await importResources(client, [theirs], apple('2026-11-05'), other, 'a')).toMatchObject({ created: 1 });
    expect(await importResources(client, [weight(APPLE, id, at, 90)], apple('2027-01-01'), pid, 'a')).toMatchObject({ created: 1, updated: 0 });
    const found = await client.searchResources('Observation', { identifier: `${APPLE}|${id}` }, { cache: 'no-cache' });
    expect(found.map((o) => o.subject?.reference).sort()).toEqual([`Patient/${other}`, `Patient/${pid}`].sort());
    const first = found.find((o) => o.subject?.reference === `Patient/${other}`) as Observation;
    expect(first.valueQuantity?.value).toBe(70);
  } finally {
    await cleanupTestPatient(client, other);
  }
});

test('a newer Apple copy of an allergy carrying its hospital identifiers updates it', async () => {
  const allergy = (criticality: 'low' | 'high'): Resource =>
    ({ resourceType: 'AllergyIntolerance', identifier: [{ system: APPLE, value: uid('allergy') }, { system: 'urn:test:hospital', value: 'a1' }], patient: me(), code: { text: 'synthetic allergen' }, criticality, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] } }) as Resource;
  const first = allergy('low');
  expect(await importResources(client, [first], apple('2026-11-05'), pid, 'a')).toMatchObject({ created: 1 });
  const next = { ...allergy('high'), identifier: (first as Observation).identifier } as Resource;
  expect(await importResources(client, [next], apple('2027-01-01'), pid, 'a')).toMatchObject({ updated: 1, skipped: 0 });
  const rows = (await all()).filter((r) => r.resourceType === 'AllergyIntolerance' && r.code?.text === 'synthetic allergen');
  expect(rows).toHaveLength(1);
  expect((rows[0] as { criticality?: string }).criticality).toBe('high');
});

// SMART: GA identifier first (urn:ga-server:id:smart:<host>|<Type>/<id>), then the server's Epic ids for linking.
const SMART_SYS = 'urn:ga-server:id:smart:fhir-example-org';
const smartSrc = (date: string, extra: Partial<SourceInfo> = {}): SourceInfo => ({ kind: 'smart', file: 'https://fhir.example.org/R4', date, writer: 'importer', ...extra });
const CODED = { coding: [{ system: 'http://snomed.info/sct', code: '38341003' }], text: 'synthetic-problem' };
const ehiProblem = (pl: { system: string; value: string }) =>
  ({ ...problem([{ system: EHI_SYS, value: `PROBLEM_LIST|${pl.value}` }, pl], 'active'), code: CODED, note: [{ text: 'synthetic-note' }] }) as Resource;
const smartProblem = (pl: { system: string; value: string }, status: 'active' | 'resolved') =>
  ({ ...problem([{ system: SMART_SYS, value: `Condition/${pl.value}` }, pl], status), code: { text: 'portal-name' }, onsetDateTime: '2020-01-02' }) as Resource;

test('fill-only smart never replaces an EHI body', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  await importResources(client, [ehiProblem(pl)], ehiSrc('2026-01-01'), pid, 'h');
  const s = smartProblem(pl, 'resolved');
  const fill = (date: string) => smartSrc(date, { fillOnly: () => true });
  expect(await importResources(client, [s], fill('2026-11-05T00:00:00Z'), pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 1 });
  // Permanent: the second sync finds it by the SMART id and still only fills.
  expect(await importResources(client, [s], fill('2026-11-06T00:00:00Z'), pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 0, skipped: 1 });
  const found = await byId('Condition', pl.system, pl.value);
  expect(found).toHaveLength(1);
  expect(found[0].code).toEqual(CODED);
  expect(found[0].note).toEqual([{ text: 'synthetic-note' }]);
  expect(found[0].clinicalStatus?.coding?.[0]?.code).toBe('active');
  expect(found[0].onsetDateTime).toBe('2020-01-02');
  expect(systems(found[0])).toContain(SMART_SYS);
});

test('smart with a real newer date updates', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  await importResources(client, [ehiProblem(pl)], ehiSrc('2026-01-01'), pid, 'h');
  // The sync date is older than the EHI export: only the per-resource date makes it newer.
  const newer = smartSrc('2025-01-01T00:00:00Z', { fillOnly: () => false, dateOf: () => '2026-10-01T00:00:00Z' });
  expect(await importResources(client, [smartProblem(pl, 'resolved')], newer, pid, 'h')).toMatchObject({ created: 0, updated: 1 });
  const [found] = await byId('Condition', pl.system, pl.value);
  expect(found.clinicalStatus?.coding?.[0]?.code).toBe('resolved');
  // A newer text-only code never replaces the coded EHI one; fields the portal lacks are kept.
  expect(found.code?.coding).toEqual(CODED.coding);
  expect(found.note).toEqual([{ text: 'synthetic-note' }]);
  expect(found.extension?.find((e) => e.url === 'urn:ga-server:ext:source-date')?.valueDateTime).toBe('2026-10-01T00:00:00Z');
});

test('unchanged re-import only advances last-seen', async () => {
  const o = uid('o');
  const c = uid('c');
  // No meta.lastUpdated: a different sync date each run must not count as an update.
  const batch: Resource[] = [
    { ...chol(o, 170, '2026-02-03'), identifier: [{ system: SMART_SYS, value: `Observation/${o}` }] },
    { ...problem([{ system: SMART_SYS, value: `Condition/${c}` }], 'active'), id: c },
  ];
  const run = (date: string, seenAt: string) => importResources(client, batch, smartSrc(date, { seenAt, fillOnly: () => true }), pid, 'h');
  const T1 = '2026-11-04T00:00:00Z';
  const T2 = '2026-11-05T00:00:00Z';
  expect(await run(T1, T1)).toMatchObject({ created: 2, seen: 0 });
  const fetch = async () =>
    [
      ...(await client.searchResources('Observation', { identifier: `${SMART_SYS}|Observation/${o}` }, { cache: 'no-cache' })),
      ...(await client.searchResources('Condition', { identifier: `${SMART_SYS}|Condition/${c}` }, { cache: 'no-cache' })),
    ] as (Resource & { extension?: { url: string; valueDateTime?: string }[] })[];
  const before = await fetch();
  const second = await run(T2, T2);
  expect(second).toMatchObject({ created: 0, updated: 0, merged: 0, seen: 2 });
  const zero = { created: 0, linked: 0, updated: 0, flagged: 0 };
  expect(second.byType).toEqual({ Observation: { ...zero, seen: 1 }, Condition: { ...zero, seen: 1 } });
  const after = await fetch();
  expect(after).toHaveLength(2);
  const strip = ({ meta: _m, extension, ...r }: Resource & { extension?: { url: string }[] }) => ({ ...r, extension: extension?.filter((e) => e.url !== LAST_SEEN) });
  for (const r of after) expect(r.extension?.find((e) => e.url === LAST_SEEN)?.valueDateTime).toBe(T2);
  expect(after.map(strip)).toEqual(before.map(strip));
  // A third run at the same time writes nothing.
  expect(await run(T2, T2)).toMatchObject({ created: 0, updated: 0, seen: 0 });
});

test('a conflict wins over fill-only: no fill, no smart identifier, no last-seen', async () => {
  const at = '2026-03-04T08:00:00Z';
  const agentObs = chol(uid('o'), 155, at);
  await importResources(client, [agentObs], { kind: 'pdf', file: 'synthetic.pdf', date: '2026-01-01', writer: 'agent', llm: true }, pid, uid('h'));
  const o = uid('o');
  const portal = { ...chol(o, 155, at), identifier: [{ system: SMART_SYS, value: `Observation/${o}` }], issued: '2026-03-05T00:00:00Z' } as Resource;
  const r = await importResources(client, [portal], smartSrc('2026-11-05T00:00:00Z', { seenAt: '2026-11-05T00:00:00Z', fillOnly: () => true }), pid, 'h');
  expect(r).toMatchObject({ created: 0, merged: 0, skipped: 1, seen: 0 });
  const [found] = await client.searchResources('Observation', { identifier: `urn:test:src|${agentObs.id}` }, { cache: 'no-cache' });
  expect(systems(found)).not.toContain(SMART_SYS);
  expect(found.issued).toBeUndefined();
  expect(found.extension?.some((e) => e.url === LAST_SEEN)).toBe(false);
});

test('a person-edited record gets neither a fill nor a last-seen stamp from an older-dated smart copy', async () => {
  const pl = { system: PROBLEM_OID, value: uid('pl') };
  await importResources(client, [ehiProblem(pl)], ehiSrc('2026-06-01'), pid, 'h');
  const [before] = await byId('Condition', pl.system, pl.value);
  // Someone other than GA's own client last wrote it: the engine sees a different author than the record's.
  const spy = vi.spyOn(client, 'getProfile').mockReturnValue({ resourceType: 'Practitioner', id: 'someone-else' });
  try {
    const s = smartSrc('2026-11-05T00:00:00Z', { fillOnly: () => true, dateOf: () => '2026-01-01T00:00:00Z', seenAt: '2026-11-05T00:00:00Z' });
    expect(await importResources(client, [smartProblem(pl, 'resolved')], s, pid, 'h')).toMatchObject({ created: 0, updated: 0, merged: 0, conflicts: 0, skipped: 1, seen: 0 });
  } finally {
    spy.mockRestore();
  }
  const [found] = await byId('Condition', pl.system, pl.value);
  expect(found.meta?.versionId).toBe(before.meta?.versionId);
  expect(found.onsetDateTime).toBeUndefined();
  expect(systems(found)).not.toContain(SMART_SYS);
  expect(found.extension?.some((e) => e.url === LAST_SEEN)).toBe(false);
  expect(tagged(found, 'source-conflict')).toBe(false);
});

test('a fill-only smart copy of an Apple-only reading takes over the body (hospital beats Apple)', async () => {
  const at = '2026-04-01T07:30:00-05:00';
  await importResources(client, [phone(at, 81)], apple('2026-04-02'), pid, 'a');
  const o = uid('o');
  const portal = { ...weight(SMART_SYS, `Observation/${o}`, at, 81), status: 'amended' } as Resource;
  expect(await importResources(client, [portal], smartSrc('2026-11-05T00:00:00Z', { fillOnly: () => true }), pid, 'h')).toMatchObject({ created: 0, merged: 1 });
  const [found] = await client.searchResources('Observation', { identifier: `${SMART_SYS}|Observation/${o}` }, { cache: 'no-cache' });
  expect(found.status).toBe('amended');
  expect(systems(found)).toContain(APPLE);
});

// Concept layer (spec Decision 4): a source's own codes teach its map; its uncoded copies of the same term then get coded.
const lab = (id: string, code: Observation['code'], value: number, day = '2024-03-04'): Observation => ({
  ...chol(id, value, day), code, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
});
const ldlText = 'LDL Cholesterol Calc';
const mapOf = (org: string) => sourceKey({ ...ccda(''), org }, { resourceType: 'Observation' } as Resource);
const ga = (o: Observation) => o.code.coding?.filter((c) => c.extension?.some((e) => e.url === CONCEPT_SRC)) ?? [];
const one = async (id: string) => (await client.searchResources('Observation', { identifier: `urn:test:src|${id}`, subject: `Patient/${pid}` }, { cache: 'no-cache' }))[0];

test('a coded LDL teaches the source map; a later uncoded same-term LDL is coded; re-import changes nothing', async () => {
  const org = uid('Synthetic Clinic'); // a space in the source key: the ConceptMap url must still be accepted
  const map = mapOf(org);
  const s: SourceInfo = { ...ccda('2024-01-01'), org };
  const coded = [lab(uid('ldl'), { coding: [{ system: 'http://loinc.org', code: '13457-7' }], text: ldlText }, 101)];
  const plainId = uid('ldl');
  const odd = uid('odd');
  const plain = [lab(plainId, { text: ldlText }, 102, '2024-05-06'), lab(odd, { text: 'Synthetic odd test' }, 1, '2024-05-06')];
  expect(await importResources(client, coded, s, pid, 'h')).toMatchObject({ created: 1, unmapped: [] });
  const r = await importResources(client, plain, s, pid, 'h');
  expect(r).toMatchObject({ created: 2, unmapped: [{ source: map, type: 'Observation', key: 'synthetic odd test|mg/dl', name: 'Synthetic odd test', unit: 'mg/dL', count: 1 }] });
  const o = await one(plainId);
  expect(o.code.coding).toEqual([{ system: 'http://loinc.org', code: '13457-7', extension: [{ url: CONCEPT_SRC, valueCode: 'source-map' }] }]);
  expect(o.code.text).toBe(ldlText);
  expect(tagged(await one(odd), 'concept-unmapped')).toBe(true);
  for (const batch of [coded, plain]) expect(await importResources(client, batch, s, pid, 'h')).toMatchObject({ created: 0, updated: 0, conflicts: 0, merged: 0, possibleDuplicates: 0 });
  expect((await one(plainId)).meta?.versionId).toBe(o.meta?.versionId);
});

test('in one batch an uncoded record before its coded twin is still coded', async () => {
  const org = uid('synthetic-batch');
  const s: SourceInfo = { ...ccda('2024-01-01'), org };
  const plainId = uid('hdl');
  const batch = [lab(plainId, { text: 'HDL Cholesterol' }, 50, '2024-07-01'), lab(uid('hdl'), { coding: [{ system: 'http://loinc.org', code: '2085-9' }], text: 'HDL Cholesterol' }, 51)];
  expect(await importResources(client, batch, s, pid, 'h')).toMatchObject({ created: 2, unmapped: [] });
  expect(ga(await one(plainId))).toHaveLength(1);
  expect(await importResources(client, batch, s, pid, 'h')).toMatchObject({ created: 0, updated: 0, conflicts: 0 });
});

test('a newer importer update of an uncoded record keeps its GA coding and suggested tag', async () => {
  const org = uid('synthetic-carry'); // no map entry for the term
  const s = (date: string): SourceInfo => ({ ...ccda(date), org });
  const id = uid('c');
  const cond = (note?: string): Condition => ({ resourceType: 'Condition', id, identifier: src(id), code: { text: 'Synthetic carry problem' }, subject: me(), ...(note && { note: [{ text: note }] }) });
  const get = async () => (await client.searchResources('Condition', { identifier: `urn:test:src|${id}`, subject: `Patient/${pid}` }, { cache: 'no-cache' }))[0];
  expect((await importResources(client, [cond()], s('2024-01-01'), pid, 'h')).unmapped).toHaveLength(1);
  const stored = await get();
  // As an agent mapping (Task 5) leaves it: GA's coding, marked suggested, the unmapped tag gone.
  const mapped = { system: 'http://snomed.info/sct', code: '1', extension: [{ url: CONCEPT_SRC, valueCode: 'agent' }] };
  await client.updateResource({ ...stored, code: { ...stored.code, coding: [mapped] }, meta: { ...stored.meta, tag: [...(stored.meta?.tag ?? []).filter((t) => t.code !== 'concept-unmapped'), { system: TAG, code: 'concept-suggested' }] } });
  // Skipped, and the stored record is mapped now: not a review line.
  expect(await importResources(client, [cond()], s('2024-01-01'), pid, 'h')).toMatchObject({ updated: 0, conflicts: 0, skipped: 1, unmapped: [] });
  expect(await importResources(client, [cond('newer')], s('2024-02-01'), pid, 'h')).toMatchObject({ updated: 1, conflicts: 0 });
  const c = await get();
  expect(c.note?.[0].text).toBe('newer');
  expect(c.code?.coding).toEqual([mapped]);
  expect(tagged(c, 'concept-suggested')).toBe(true);
  expect(tagged(c, 'concept-unmapped')).toBe(false);
});

test('an agent entry is never replaced by a source learn, even when this process cached the map before the agent wrote it', async () => {
  const org = uid('synthetic-dup');
  const source = mapOf(org);
  const s: SourceInfo = { ...ccda('2024-01-01'), org };
  const key = 'ldl cholesterol calc|mg/dl';
  await loadMaps(client); // this process's cache: no map for the source yet
  // Another process (an agent's map_concept) writes the map directly: this process's cache doesn't know.
  await client.createResource({
    resourceType: 'ConceptMap', status: 'active', url: mapUrl(source), meta: { tag: [{ system: TAG, code: 'concept-map' }] },
    group: [{ source: 'urn:ga-server:termkey', target: 'http://loinc.org', element: [{ code: key, target: [{ code: '18262-6', equivalence: 'equivalent', extension: [{ url: 'urn:ga-server:ext:concept-by', valueCode: 'agent' }, { url: 'urn:ga-server:ext:concept-confident', valueBoolean: true }] }] }] }],
  });
  const plainId = uid('ldl');
  await importResources(client, [lab(uid('ldl'), { coding: [{ system: 'http://loinc.org', code: '13457-7' }], text: ldlText }, 101), lab(plainId, { text: ldlText }, 99, '2024-09-09')], s, pid, 'h');
  await upsertEntry(client, source, { key, target: { system: 'http://loinc.org', code: '13457-7' }, equivalence: 'equivalent', confident: true, by: 'source' }); // stale caller
  expect(lookup(await loadMaps(client, true), source, key)).toMatchObject({ target: { code: '18262-6' }, by: 'agent' });
  expect(ga(await one(plainId))).toEqual([{ system: 'http://loinc.org', code: '18262-6', extension: [{ url: CONCEPT_SRC, valueCode: 'agent' }] }]);
});

test('a record coded only by GA is never a content match for a source-coded record', async () => {
  const org = uid('synthetic-batch');
  const s: SourceInfo = { ...ccda('2024-01-01'), org };
  const [at1, at2] = ['2024-10-10T09:00:00Z', '2024-10-12T09:00:00Z'];
  const [p1, p2] = [uid('tg'), uid('tg')];
  // The map (learned from the coded twin) codes the uncoded ones: their LOINC is GA's, not the source's.
  await importResources(client, [lab(uid('tg'), { coding: [{ system: 'http://loinc.org', code: '2571-8' }], text: 'Triglycerides' }, 1), lab(p1, { text: 'Triglycerides' }, 150, at1), lab(p2, { text: 'Triglycerides' }, 150, at2)], s, pid, 'h');
  expect(ga(await one(p1))).toHaveLength(1);
  const pdf: SourceInfo = { kind: 'pdf', file: `/tmp/${uid('r')}.pdf`, date: '2024-10-13', writer: 'agent' };
  const tg = (value: number, at: string): Observation => ({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '2571-8' }], text: 'TG' }, effectiveDateTime: at, valueQuantity: { value, unit: 'mg/dL' }, subject: me() });
  // Same value and time would have merged, a different value on the day been flagged: neither happens through a GA code.
  expect(await importResources(client, [tg(150, at1), tg(160, at2)], pdf, pid, uid('h'))).toMatchObject({ created: 2, merged: 0, possibleDuplicates: 0 });
  for (const id of [p1, p2]) expect(tagged(await one(id), 'possible-duplicate')).toBe(false);
});
