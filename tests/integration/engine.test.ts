import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, MedicationStatement, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { importResources } from '../../src/engine.ts';
import { type SourceInfo, stableIdentifier } from '../../src/identity.ts';
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
  expect(second).toEqual({ created: 0, updated: 0, skipped: 5, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 });
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
