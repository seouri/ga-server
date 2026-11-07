import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Endpoint, Medication, Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const PDF = join(import.meta.dirname, '..', 'fixtures', 'labs-synthetic.pdf');
const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const fileHash = createHash('sha256').update(readFileSync(PDF)).digest('hex');
// A second, never-imported PDF (distinct bytes), outside the repo.
const PDF2 = join(tmpdir(), `ga-test-${randomUUID()}.pdf`);
const PDF3 = join(tmpdir(), `ga-test-${randomUUID()}.pdf`);
let cfg: GaConfig;
let client: MedplumClient;
let pid: string;
let mcp: Client;

const ldl = (): Observation => ({
  resourceType: 'Observation',
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '13457-7' }], text: 'LDL' },
  effectiveDateTime: '2024-03-01',
  valueQuantity: { value: 111, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
});
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0].text;
  return { isError: !!r.isError, text };
};
const count = async () => (await client.searchResources('Observation', { subject: `Patient/${pid}` }, { cache: 'no-cache' })).length;

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
  pid = await createTestPatient(client);
  writeFileSync(PDF2, Buffer.concat([readFileSync(PDF), Buffer.from(`\n%${randomUUID()}\n`)]));
  writeFileSync(PDF3, Buffer.concat([readFileSync(PDF), Buffer.from(`\n%${randomUUID()}\n`)]));
  mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(
    new StdioClientTransport({ command: 'node', args: [CLI, 'mcp'], env: { ...process.env, GA_PATIENT_ID: pid } as Record<string, string> }),
  );
});

afterAll(async () => {
  await mcp?.close();
  rmSync(PDF2, { force: true });
  rmSync(PDF3, { force: true });
  for (const d of await client.searchResources('DocumentReference', { subject: `Patient/${pid}` }, { cache: 'no-cache' })) {
    const bin = d.content?.[0]?.attachment?.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
    if (bin) await client.deleteResource('Binary', bin);
    await client.deleteResource('DocumentReference', d.id as string);
  }
  await cleanupTestPatient(client, pid);
});

test('ga_import stores document and links observations', async () => {
  const r = await call('ga_import', { resources: [ldl()], sourceFile: PDF, documentDate: '2024-03-02' });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text).created).toBe(1);
  const docs = await client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}` }, { cache: 'no-cache' });
  expect(docs.filter((d) => d.subject?.reference === `Patient/${pid}`)).toHaveLength(1);
  const [o] = await client.searchResources('Observation', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(o.derivedFrom?.[0]?.reference).toBe(`DocumentReference/${docs.find((d) => d.subject?.reference === `Patient/${pid}`)?.id}`);
  expect(o.meta?.tag?.map((t) => t.code)).toEqual(expect.arrayContaining(['writer-agent', 'src-pdf', 'extracted-by-llm']));
});

test('ga_import of an already imported file is refused without writing', async () => {
  const r = await call('ga_import', { resources: [{ ...ldl(), valueQuantity: { value: 112, unit: 'mg/dL' } }], sourceFile: PDF, documentDate: '2024-03-02' });
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/^already imported: labs-synthetic\.pdf \(if that import failed, delete DocumentReference\/[\w-]+ to retry\)$/);
  expect(await count()).toBe(1);
});

test('ga_import rejects a bad or future documentDate', async () => {
  for (const documentDate of ['yesterday', '2024-02-30', '2024-03-02T10:00', '2999-01-01']) {
    const r = await call('ga_import', { resources: [ldl()], sourceFile: PDF2, documentDate });
    expect(r.text).toMatch(/^documentDate must be/);
  }
});

test('ga_import drops agent meta and GA bookkeeping; Encounter and DiagnosticReport import without note', async () => {
  const inject = {
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'writer-importer' }] },
    extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2999-01-01' }],
    identifier: [{ system: 'urn:ga-server:id:ccda', value: 'forged' }],
  };
  const resources = [
    { resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, ...inject },
    { resourceType: 'DiagnosticReport', status: 'final', code: { text: 'synthetic panel' } },
  ];
  const r = await call('ga_import', { resources, sourceFile: PDF2, documentDate: '2024-03-02' });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text)).toMatchObject({ created: 2, invalid: 0 });
  const [e] = await client.searchResources('Encounter', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  const codes = e.meta?.tag?.map((t) => t.code);
  expect(codes).toContain('writer-agent');
  expect(codes).not.toContain('writer-importer');
  expect(e.extension?.filter((x) => x.url === 'urn:ga-server:ext:source-date').map((x) => x.valueDateTime)).toEqual(['2024-03-02']);
  expect(e.identifier?.some((i) => i.value === 'forged')).toBe(false);
});

test('ga_import rejects bad input atomically', async () => {
  const before = await count();
  expect((await call('ga_import', { resources: [ldl()], sourceFile: '/nonexistent.pdf' })).text).toMatch(/^sourceFile not found/);
  expect((await call('ga_import', { resources: [ldl(), { status: 'final' }], sourceFile: PDF })).text).toMatch(/^every resource needs/);
  expect(await count()).toBe(before);
});

test('fhir_search returns imported LDL', async () => {
  const r = await call('fhir_search', { resourceType: 'Observation', params: { subject: `Patient/${pid}`, code: 'http://loinc.org|13457-7' } });
  const b = JSON.parse(r.text) as Bundle;
  expect(b.entry).toHaveLength(1);
  const res = b.entry?.[0].resource as Observation;
  expect(res.text).toBeUndefined();
  expect(Object.keys(res.meta ?? {}).sort()).toEqual(['source', 'tag']);
  const read = await call('fhir_read', { resourceType: 'Observation', id: b.entry?.[0].resource?.id as string });
  expect(JSON.parse(read.text).valueQuantity.value).toBe(111);
  expect((await call('fhir_read', { resourceType: 'Enterprise', id: 'x' })).text).toMatch(/not available/);
  // A list repeats the param: a date range is AND, not the comma-joined OR Medplum's client would build.
  const range = async (date: string[]) =>
    (JSON.parse((await call('fhir_search', { resourceType: 'Observation', params: { subject: `Patient/${pid}`, code: 'http://loinc.org|13457-7', date } })).text) as Bundle).entry?.length ?? 0;
  expect(await range(['ge2024-01-01', 'lt2025-01-01'])).toBe(1);
  expect(await range(['ge2025-01-01', 'lt2026-01-01'])).toBe(0);
});

test('cardiovascular_risk_10yr returns PREVENT and PCE', async () => {
  const r = await call('cardiovascular_risk_10yr', { age: 50, sex: 'male', sbp: 120, bpTx: false, totalC: 200, hdlC: 50, statin: false, diabetes: false, smoker: false, egfr: 90 });
  expect(JSON.parse(r.text)).toMatchObject({ preventAscvd: expect.closeTo(0.019, 3), pce: expect.closeTo(0.0309, 3) });
});

test('vaccine_gaps reads the test patient from GA and reports per-vaccine status', async () => {
  expect((await call('vaccine_gaps', {})).text).toBe('Patient has no birthDate in GA');
  const p = await client.readResource('Patient', pid);
  await client.updateResource({ ...p, birthDate: '1970-06-15', gender: 'male' });
  const imm = { resourceType: 'Immunization' as const, status: 'completed' as const, patient: { reference: `Patient/${pid}` } };
  await client.createResource({ ...imm, vaccineCode: { coding: [{ system: 'urn:oid:2.16.840.1.113883.12.292', code: '115' }], text: 'Tdap' }, occurrenceDateTime: '2014-03-01' });
  await client.createResource({ ...imm, vaccineCode: { text: 'Typhoid Vi' }, occurrenceDateTime: '2019-05-01' });
  await client.createResource({ ...imm, status: 'not-done', vaccineCode: { text: 'Shingrix' }, occurrenceDateTime: '2024-01-10' });
  const r = JSON.parse((await call('vaccine_gaps', { asOf: '2026-11-05' })).text);
  expect(r.edition).toMatch(/2025/);
  const by = Object.fromEntries(r.results.map((x: { vaccine: string; status: string }) => [x.vaccine, x.status]));
  expect(by).toMatchObject({ 'td-tdap': 'overdue', zoster: 'due', influenza: 'due', hpv: 'not-recommended' });
  expect(r.unmatched).toEqual([{ date: '2019-05-01', name: 'Typhoid Vi', source: '' }]);
  expect((await call('vaccine_gaps', { asOf: 'tomorrow' })).text).toMatch(/^asOf must be/);
  await client.updateResource({ ...(await client.readResource('Patient', pid, { cache: 'no-cache' })), gender: 'other' });
  const other = JSON.parse((await call('vaccine_gaps', { asOf: '2026-11-05' })).text);
  expect(other.note).toMatch(/gender in GA is other/);
  expect(other.results.find((x: { vaccine: string }) => x.vaccine === 'td-tdap').status).toBe('overdue');
});

test('ga_import rejects non-document files, unsupported types and invalid resources without writing', async () => {
  const docs = () => client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}` }, { cache: 'no-cache' });
  const before = (await docs()).length;
  const pem = join(import.meta.dirname, '..', '..', 'package.json');
  expect((await call('ga_import', { resources: [ldl()], sourceFile: pem })).text).toMatch(/^sourceFile must be/);
  expect((await call('ga_import', { resources: [{ resourceType: 'Patient' }], sourceFile: PDF })).text).toMatch(/^unsupported resourceType/);
  expect((await call('ga_import', { resources: [], sourceFile: PDF })).text).toMatch(/^no resources/);
  const { code: _c, ...noCode } = ldl();
  const r = await call('ga_import', { resources: [{ ...noCode, status: 'bogus' }], sourceFile: PDF });
  expect(r.text).toMatch(/^invalid Observation/);
  expect((await docs()).length).toBe(before);
});

test('fhir_search and fhir_read show a text/plain attachment as decoded text; stored data stays base64 (I3)', async () => {
  const data = Buffer.from('Synthetic note text', 'utf8').toString('base64');
  const doc = await client.createResource({
    resourceType: 'DocumentReference', status: 'current', subject: { reference: `Patient/${pid}` },
    content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data } }],
  });
  const read = JSON.parse((await call('fhir_read', { resourceType: 'DocumentReference', id: doc.id as string })).text);
  expect(read.content[0].attachment).toEqual({ contentType: 'text/plain; charset=utf-8', text: 'Synthetic note text' });
  const b = JSON.parse((await call('fhir_search', { resourceType: 'DocumentReference', params: { _id: doc.id as string } })).text) as Bundle;
  expect((b.entry?.[0].resource as { content: { attachment: unknown }[] }).content[0].attachment).toEqual({ contentType: 'text/plain; charset=utf-8', text: 'Synthetic note text' });
  const stored = await client.readResource('DocumentReference', doc.id as string, { cache: 'no-cache' });
  expect(stored.content[0].attachment.data).toBe(data);
});

test('ga_import of a vaccination certificate adds itself as a source of doses GA already holds, and creates only new ones', async () => {
  const imm = (date: string, text: string, lot?: string) =>
    ({ resourceType: 'Immunization', status: 'completed', vaccineCode: { text }, occurrenceDateTime: date, ...(lot ? { lotNumber: lot } : {}) }) as const;
  const CVX = 'urn:oid:2.16.840.1.113883.12.292';
  const held = await client.createResource({ ...imm('2022-10-07', 'INFLUENZA VACCINE', 'LOT1'), patient: { reference: `Patient/${pid}` }, vaccineCode: { text: 'INFLUENZA VACCINE', coding: [{ system: CVX, code: '171' }] } });
  const imms = () => client.searchResources('Immunization', { patient: `Patient/${pid}` }, { cache: 'no-cache' });
  const before = (await imms()).length;
  const r = await call('ga_import', {
    resources: [imm('2022-10-07', 'FLU-CCIIV4, P-FREE', 'lot1'), imm('2023-01-01', 'NEW VACCINE')],
    sourceFile: PDF3,
    documentDate: '2026-11-05',
  });
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text)).toMatchObject({ created: 1, merged: 1 });
  const after = await client.readResource('Immunization', held.id as string, { cache: 'no-cache' });
  expect(after.vaccineCode).toEqual(held.vaccineCode); // existing body kept
  expect(after.identifier?.some((i) => i.system === 'urn:ga-server:id:pdf')).toBe(true);
  expect((await imms()).length).toBe(before + 1); // only the new dose was created
});

test('lab_results: labs incl. uncategorised AI-extracted, no Apple Health or vitals; name, dates, order, flags, paging', async () => {
  const p = await createTestPatient(client);
  try {
    const cat = (code: string) => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }] }];
    const tag = (...codes: string[]) => ({ tag: codes.map((code) => ({ system: 'urn:ga-server:tag', code })) });
    const o = (text: string, date: string, extra: Partial<Observation> = {}): Observation =>
      ({ resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${p}` }, code: { text }, effectiveDateTime: date, valueQuantity: { value: 5.6, unit: '%' }, ...extra });
    const fixed = [
      o('Hemoglobin A1c', '2023-06-01', { category: cat('laboratory') }),
      o('HEMOGLOBIN A1C', '2024-12-31T15:00:00Z', { category: cat('laboratory'), meta: tag('possible-duplicate') }),
      o('Glucose', '2024-03-01', { meta: tag('extracted-by-llm') }),
      o('Hemoglobin A1c (Apple)', '2024-04-01', { category: cat('laboratory'), meta: tag('src-apple-health') }),
      o('Body weight a1c', '2024-05-01', { category: cat('vital-signs'), meta: tag('extracted-by-llm') }),
    ];
    // A panel on one day, more than one 100-row page: ties must neither repeat nor go missing across pages.
    const panel = Array.from({ length: 110 }, (_, n) => o(`Panel item ${n}`, '2022-01-01', { category: cat('laboratory') }));
    await client.executeBatch({ resourceType: 'Bundle', type: 'batch', entry: [...fixed, ...panel].map((resource) => ({ resource, request: { method: 'POST', url: 'Observation' } })) });
    const sub = new Client({ name: 'test', version: '0' });
    await sub.connect(new StdioClientTransport({ command: 'node', args: [CLI, 'mcp'], env: { ...process.env, GA_PATIENT_ID: p } as Record<string, string> }));
    const labs = async (args: Record<string, unknown>) => JSON.parse(((await sub.callTool({ name: 'lab_results', arguments: args })).content as { text: string }[])[0].text);
    try {
      const all = await labs({ limit: 1000 });
      expect(all.total).toBe(113);
      expect(all.truncated).toBeUndefined();
      expect(new Set(all.rows.map((r: { id: string }) => r.id)).size).toBe(113);
      expect(all.rows.slice(0, 3).map((r: { name: string }) => r.name)).toEqual(['HEMOGLOBIN A1C', 'Glucose', 'Hemoglobin A1c']);
      expect(all.rows.some((r: { name: string }) => /Apple|weight/.test(r.name))).toBe(false);
      expect(all.rows[0]).toMatchObject({ date: '2024-12-31', value: '5.6 %', flags: ['possible-duplicate'] });
      expect(all.rows[1].flags).toEqual(['read from a document by AI']);
      expect((await labs({ name: 'a1c' })).rows.map((r: { date: string }) => r.date)).toEqual(['2024-12-31', '2023-06-01']);
      expect((await labs({ since: '2024-01-01', until: '2024-12-31' })).rows.map((r: { name: string }) => r.name)).toEqual(['HEMOGLOBIN A1C', 'Glucose']);
      expect((await labs({ until: '2024-02-29', name: 'a1c' })).rows.map((r: { date: string }) => r.date)).toEqual(['2023-06-01']);
      expect(await labs({ limit: 2 })).toMatchObject({ total: 2, truncated: true });
      const bad = await sub.callTool({ name: 'lab_results', arguments: { since: '2024' } });
      expect(bad.isError).toBe(true);
    } finally {
      await sub.close();
    }
  } finally {
    await cleanupTestPatient(client, p);
  }
});

// One throwaway patient and one MCP process for the purpose-built read tools (each process logs in; Medplum rate-limits logins).
describe('purpose-built read tools', () => {
  const T = '2026-11-01T00:00:00.000Z';
  let p: string;
  let ep: Endpoint;
  let sub: Client;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await sub.callTool({ name, arguments: args });
    const t = (r.content as { text: string }[])[0].text;
    return r.isError ? { error: t } : JSON.parse(t);
  };
  beforeAll(async () => {
    p = await createTestPatient(client);
    // Endpoints are in no patient compartment: deleted in afterAll. status error: also a stale source.
    ep = await client.createResource<Endpoint>({
      resourceType: 'Endpoint', status: 'error', connectionType: { code: 'hl7-fhir-rest' }, payloadType: [{ text: 'x' }], address: 'https://hosp.example/fhir',
      identifier: [{ system: 'urn:ga-server:id:smart-source', value: `test-${randomUUID()}` }],
      extension: [
        { url: 'urn:ga-server:ext:smart-last-success', valueDateTime: T },
        { url: 'urn:ga-server:ext:smart-patient', valueReference: { reference: `Patient/${p}` } },
      ],
    });
    sub = new Client({ name: 'test', version: '0' });
    await sub.connect(new StdioClientTransport({ command: 'node', args: [CLI, 'mcp'], env: { ...process.env, GA_PATIENT_ID: p } as Record<string, string> }));
  });
  afterAll(async () => {
    await sub?.close();
    if (ep?.id) await client.deleteResource('Endpoint', ep.id);
    if (p) await cleanupTestPatient(client, p);
  });

  test('current_medications, current_problems, allergies apply the currency rule', async () => {
    const key = ep.identifier?.[0].value as string;
    const subject = { reference: `Patient/${p}` };
    const seen = (t: string) => ({ identifier: [{ system: `urn:ga-server:id:smart:${key}`, value: 'x' }], extension: [{ url: 'urn:ga-server:ext:last-seen', valueDateTime: t }] });
    const med = await client.createResource<Medication>({ resourceType: 'Medication', code: { text: 'Synthetic drug A' } });
    const entry = [
      { resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject, medicationReference: { reference: `Medication/${med.id}` }, ...seen(T) },
      { resourceType: 'MedicationStatement', status: 'active', subject, medicationCodeableConcept: { text: 'Synthetic drug B' }, ...seen('2026-10-01T00:00:00.000Z') },
      { resourceType: 'MedicationStatement', status: 'stopped', subject, medicationCodeableConcept: { text: 'Synthetic drug C' } },
      { resourceType: 'Condition', subject, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }], code: { text: 'Synthetic problem' } },
      { resourceType: 'Condition', subject, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }], code: { text: 'Synthetic visit dx' } },
      { resourceType: 'AllergyIntolerance', patient: subject, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { text: 'Synthetic allergen' } },
    ].map((resource) => ({ resource, request: { method: 'POST', url: resource.resourceType } }));
    try {
      await client.executeBatch({ resourceType: 'Bundle', type: 'batch', entry } as Bundle);
      const meds = await tool('current_medications');
      expect(meds.rows.map((r: { name: string; currency: string }) => [r.name, r.currency])).toEqual([['Synthetic drug A', 'current'], ['Synthetic drug B', 'unconfirmed']]);
      expect((await tool('current_medications', { include: 'all' })).rows[2]).toMatchObject({ name: 'Synthetic drug C', currency: 'inactive' });
      expect((await tool('current_problems')).rows.map((r: { name: string }) => r.name)).toEqual(['Synthetic problem']);
      expect((await tool('allergies')).rows).toMatchObject([{ name: 'Synthetic allergen', currency: 'current' }]);
    } finally {
      await client.deleteResource('Medication', med.id as string);
    }
  });
  test('vitals: clinic and home readings by default, Apple daily summaries only with daily', async () => {
    const cat = (code: string) => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }] }];
    const apple = { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }] };
    const o = (text: string, date: string, extra: Partial<Observation>): Observation =>
      ({ resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${p}` }, code: { text }, effectiveDateTime: date, valueQuantity: { value: 70, unit: 'kg' }, ...extra });
    const entry = [
      o('Body weight', '2025-03-01', { category: cat('vital-signs') }),
      o('Body weight', '2025-03-01T20:00:00Z', { category: cat('vital-signs'), meta: apple }),
      o('Steps, daily total (Apple Health)', '2025-03-01', { category: cat('activity'), meta: apple }),
      o('Hemoglobin A1c', '2025-03-01', { category: cat('laboratory') }),
    ].map((resource) => ({ resource, request: { method: 'POST', url: 'Observation' } }));
    await client.executeBatch({ resourceType: 'Bundle', type: 'batch', entry } as Bundle);
    const v = await tool('vitals');
    expect(v.rows.map((r: { setting: string; kind: string }) => [r.setting, r.kind])).toEqual([['home', 'reading'], ['clinic', 'reading']]);
    expect((await tool('vitals', { daily: true })).rows).toMatchObject([{ name: 'Steps, daily total (Apple Health)', kind: 'daily total', setting: 'home' }]);
    expect((await tool('vitals', { name: 'weight', until: '2025-02-28' })).rows).toEqual([]);
    expect(await tool('vitals', { limit: 1 })).toMatchObject({ truncated: true, hint: expect.stringContaining('daily: true') });
  });
  test('notes_search: text inside notes and messages; archives and source files skipped', async () => {
    const subject = { reference: `Patient/${p}` };
    const b64 = (t: string) => Buffer.from(t).toString('base64');
    const note = (body: string, extra: object = {}) => ({ resourceType: 'DocumentReference', status: 'current', subject, date: '2025-02-01T09:00:00Z', type: { text: 'Progress note' }, content: [{ attachment: { contentType: 'text/plain', data: b64(body) } }], ...extra });
    const entry = [
      note('Synthetic visit: patient mentions zebrafinch symptoms.'),
      note('zebrafinch inside an archive', { identifier: [{ system: 'urn:ga-server:id:ehi-archive', value: randomUUID() }] }),
      { resourceType: 'Communication', status: 'completed', subject, sent: '2025-03-01T10:00:00Z', sender: { display: 'Synthetic clinic' }, payload: [{ contentString: 'About your ZEBRAFINCH question' }] },
    ].map((resource) => ({ resource, request: { method: 'POST', url: resource.resourceType } }));
    await client.executeBatch({ resourceType: 'Bundle', type: 'batch', entry } as Bundle);
    const r = await tool('notes_search', { text: 'zebrafinch' });
    expect(r.rows.map((x: { kind: string; date: string }) => [x.kind, x.date])).toEqual([['message', '2025-03-01'], ['Progress note', '2025-02-01']]);
    expect(r.rows[1].snippet).toContain('zebrafinch symptoms');
    expect((await tool('notes_search', { text: 'zebrafinch', until: '2025-02-15' })).rows).toHaveLength(1);
    expect((await tool('notes_search', { since: '2025' })).error).toMatch(/since must be/);
  });
  test('portalWarning: a stale source is named with its fix; a patient without sources gets no field', async () => {
    for (const name of ['lab_results', 'vitals', 'notes_search', 'current_medications'])
      expect((await tool(name)).portalWarning).toMatch(/status error, last success 2026-11-01T00:00:00\.000Z: sync: `ga sync`/);
    expect(JSON.parse((await call('fhir_search', { resourceType: 'Observation', params: { _count: '1' } })).text).portalWarning).toBeUndefined();
  });
  test('fhir_search nextPage: page 2 differs from page 1; a tampered token is refused', async () => {
    const entry = ['2020-01-01', '2020-01-02', '2020-01-03'].map((d) => ({
      resource: { resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${p}` }, code: { text: 'Synthetic paging' }, effectiveDateTime: d },
      request: { method: 'POST', url: 'Observation' },
    }));
    await client.executeBatch({ resourceType: 'Bundle', type: 'batch', entry } as Bundle);
    const search = async (args: object) => sub.callTool({ name: 'fhir_search', arguments: { resourceType: 'Observation', ...args } }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
    const ids = (r: { content: { text: string }[] }) => (JSON.parse(r.content[0].text) as Bundle).entry?.map((e) => e.resource?.id);
    const p1 = await search({ params: { subject: `Patient/${p}`, 'code:text': 'Synthetic paging', _sort: '-date', _count: '2' } });
    const { nextPage } = JSON.parse(p1.content[0].text);
    const p2 = await search({ page: nextPage });
    expect(ids(p1)).toHaveLength(2);
    expect(ids(p2)).toHaveLength(1);
    expect(ids(p1)).not.toContain(ids(p2)?.[0]);
    const bad = await search({ page: `${nextPage.slice(0, -4)}!!!!` });
    expect(bad.isError).toBe(true);
  });
});
