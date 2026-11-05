import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(
    new StdioClientTransport({ command: 'node', args: [CLI, 'mcp'], env: { ...process.env, GA_PATIENT_ID: pid } as Record<string, string> }),
  );
});

afterAll(async () => {
  await mcp?.close();
  for (const d of await client.searchResources('DocumentReference', { identifier: `urn:ga-server:id:file|${fileHash}` }, { cache: 'no-cache' })) {
    if (d.subject?.reference !== `Patient/${pid}`) continue;
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

test('ga_import twice is a no-op', async () => {
  const r = await call('ga_import', { resources: [ldl()], sourceFile: PDF, documentDate: '2024-03-02' });
  expect(JSON.parse(r.text)).toMatchObject({ created: 0, updated: 0, skipped: 1 });
  expect(await count()).toBe(1);
});

test('ga_import rejects bad input atomically', async () => {
  const before = await count();
  expect((await call('ga_import', { resources: [ldl()], sourceFile: '/nonexistent.pdf' })).isError).toBe(true);
  expect((await call('ga_import', { resources: [ldl(), { status: 'final' }], sourceFile: PDF })).isError).toBe(true);
  expect(await count()).toBe(before);
});

test('fhir_search returns imported LDL', async () => {
  const r = await call('fhir_search', { resourceType: 'Observation', params: { subject: `Patient/${pid}`, code: 'http://loinc.org|13457-7' } });
  const b = JSON.parse(r.text) as Bundle;
  expect(b.entry).toHaveLength(1);
  const read = await call('fhir_read', { resourceType: 'Observation', id: b.entry?.[0].resource?.id as string });
  expect(JSON.parse(read.text).valueQuantity.value).toBe(111);
});
