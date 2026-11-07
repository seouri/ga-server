import type { MedplumClient } from '@medplum/core';
import type { Basic, Observation, Procedure } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { REMINDER, healthMaintenance } from '../../src/maintenance.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let pid: string;
beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
});
afterAll(() => cleanupTestPatient(client, pid));

test('healthMaintenance joins guideline, Epic plan and reminder from the record', async () => {
  const subject = { reference: `Patient/${pid}` };
  await client.updateResource({ ...(await client.readResource('Patient', pid)), birthDate: '1970-05-05', gender: 'female' });
  await client.createResource<Procedure>({ resourceType: 'Procedure', status: 'completed', subject, performedDateTime: '2019-01-10', code: { text: 'Colonoscopy' } });
  await client.createResource<Observation>({
    resourceType: 'Observation', status: 'final', subject, code: { text: 'Health maintenance: COLORECTAL CANCER SCREENING' }, valueString: 'Due soon',
    component: [{ code: { text: 'Next due date' }, valueDateTime: '2029-01-10' }],
    extension: [{ url: 'urn:ga-server:ext:source-date', valueDate: '2026-10-01' }],
  });
  await client.createResource<Basic>({
    resourceType: 'Basic', subject, created: '2026-11-01', code: { coding: [{ system: REMINDER, code: 'not-now' }] },
    extension: [{ url: 'urn:ga-server:ext:topic', valueString: 'colorectal' }],
  });
  // An exam-category Observation must stay out of the read.
  await client.createResource<Observation>({ resourceType: 'Observation', status: 'final', subject, category: [{ coding: [{ code: 'exam' }] }], code: { text: 'Step count' }, effectiveDateTime: '2026-10-01' });
  const r = await healthMaintenance(client, pid, '2026-11-03');
  const c = r.items.find((i) => i.topic === 'colorectal');
  expect(c?.status).toBe('done');
  expect(c?.evidence[0].date).toBe('2019-01-10');
  expect(c?.doctorsPlan?.from).toBe('epic');
  expect(c?.nextMention).toBe('2026-11-15'); // not-now 2026-11-01 + 14 days (grade A)
  expect(r.note).toMatch(/^Guideline items cite/);
});
