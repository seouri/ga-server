import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { importResources } from '../../src/engine.ts';
import type { SourceInfo } from '../../src/identity.ts';
import { arrivedSince } from '../../src/whats-new.ts';
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
