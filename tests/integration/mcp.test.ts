import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const PDF = join(import.meta.dirname, '..', 'fixtures', 'labs-synthetic.pdf');
const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const fileHash = createHash('sha256').update(readFileSync(PDF)).digest('hex');
// A second, never-imported PDF (distinct bytes), outside the repo.
const PDF2 = join(tmpdir(), `ga-test-${randomUUID()}.pdf`);
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
  mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(
    new StdioClientTransport({ command: 'node', args: [CLI, 'mcp'], env: { ...process.env, GA_PATIENT_ID: pid } as Record<string, string> }),
  );
});

afterAll(async () => {
  await mcp?.close();
  rmSync(PDF2, { force: true });
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
});

test('risk_score returns PREVENT and PCE', async () => {
  const r = await call('risk_score', { age: 50, sex: 'male', sbp: 120, bpTx: false, totalC: 200, hdlC: 50, statin: false, diabetes: false, smoker: false, egfr: 90 });
  expect(JSON.parse(r.text)).toMatchObject({ preventAscvd: expect.closeTo(0.019, 3), pce: expect.closeTo(0.0309, 3) });
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
