import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { MedicationStatement, Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { importResources } from '../../src/engine.ts';
import type { SourceInfo } from '../../src/identity.ts';
import { newestEpicImport } from '../../src/share/scope.ts';
import { arrivedSince, statusItems } from '../../src/whats-new.ts';
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

const obs = (id: string, day = '2024-02-03'): Observation => ({
  resourceType: 'Observation', id, identifier: [{ system: 'urn:test:src', value: id }], status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '2093-3' }] }, effectiveDateTime: day,
  valueQuantity: { value: 200, unit: 'mg/dL' }, subject: { reference: `Patient/${pid}` },
});

test('arrivedSince returns created records, not old or unmarked ones', async () => {
  const since = new Date().toISOString();
  const unmarked = await client.createResource<Observation>({ ...obs(randomUUID(), '2023-01-02'), id: undefined });
  const source: SourceInfo = { kind: 'ccda', file: '/synthetic-clinic/synthetic.xml', date: '2024-02-03', writer: 'importer' };
  const id = randomUUID();
  await importResources(client, [obs(id)], source, pid, 'hash');
  const got = await arrivedSince(client, pid, since);
  expect(got.length).toBe(1);
  expect(got[0].id).not.toBe(unmarked.id);
  expect(await arrivedSince(client, pid, new Date(Date.now() + 60000).toISOString())).toEqual([]);
});

test('statusItems sees a medication stopped since', async () => {
  const ms = await client.createResource<MedicationStatement>({
    resourceType: 'MedicationStatement', status: 'active', subject: { reference: `Patient/${pid}` }, medicationCodeableConcept: { text: 'Synthetic drug' },
  });
  await new Promise((r) => setTimeout(r, 1100));
  const since = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));
  await client.updateResource({ ...ms, status: 'stopped' });
  const items = await statusItems(client, pid, since);
  expect(items.filter((i) => i.id === ms.id).map((i) => i.detail)).toEqual([{ from: 'active', to: 'stopped' }]);
});

test('statusItems finds the pre-since version past many later no-op versions', async () => {
  let ms = await client.createResource<MedicationStatement>({
    resourceType: 'MedicationStatement', status: 'active', subject: { reference: `Patient/${pid}` }, medicationCodeableConcept: { text: 'Synthetic drug 2' },
  });
  await new Promise((r) => setTimeout(r, 1100));
  const since = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));
  for (let n = 0; n < 25; n++) ms = await client.updateResource({ ...ms, extension: [{ url: 'urn:test:n', valueInteger: n }] });
  await client.updateResource({ ...ms, status: 'stopped' });
  expect((await statusItems(client, pid, since)).filter((i) => i.id === ms.id).map((i) => i.detail)).toEqual([{ from: 'active', to: 'stopped' }]);
}, 60_000);

test('a C-CDA import stores the newest Epic import date, and an older one does not lower it', async () => {
  const ccda = (date: string): SourceInfo => ({ kind: 'ccda', file: '/synthetic-clinic/synthetic.xml', date, writer: 'importer' });
  await importResources(client, [obs(randomUUID(), '2024-01-01')], ccda('2024-05-01'), pid, 'h1');
  await importResources(client, [obs(randomUUID(), '2024-01-02')], ccda('2023-05-01'), pid, 'h2');
  expect(await newestEpicImport(client, pid)).toBe(Date.parse('2024-05-01'));
});
