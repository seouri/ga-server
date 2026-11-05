import { expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { setup } from '../../src/setup.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

test('setup is idempotent and getClient works', async () => {
  const a = await setup();
  const b = await setup();
  expect(b.patientId).toBe(a.patientId);
  expect(b.clientId).toBe(a.clientId);
  const client = await getClient(loadConfig());
  expect((await client.readResource('Patient', a.patientId)).id).toBe(a.patientId);
});

test('test patient helpers round-trip', async () => {
  const client = await getClient(loadConfig());
  const id = await createTestPatient(client);
  await client.createResource({
    resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${id}` },
  });
  await cleanupTestPatient(client, id);
  await expect(client.readResource('Patient', id)).rejects.toThrow();
  expect(await client.searchResources('Observation', { subject: `Patient/${id}` })).toHaveLength(0);
});
