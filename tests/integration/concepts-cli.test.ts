import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { CONCEPT_SRC } from '../../src/concept-apply.ts';
import { applyAll, reviewList } from '../../src/concepts-cli.ts';
import { LOINC } from '../../src/concepts.ts';
import { upsertEntries } from '../../src/conceptmap.ts';
import { getClient, loadConfig } from '../../src/config.ts';
import { cleanupTestMaps, cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let pid: string;
const key = `good-${randomUUID()}`; // a throwaway smart source: its map is removed by cleanupTestMaps
const TAGS = (src: string) => ({ tag: [{ system: 'urn:ga-server:tag', code: `src-${src}` }], source: 'https://example.org/fhir' });
beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
});
afterAll(async () => {
  await cleanupTestMaps(client);
  await cleanupTestPatient(client, pid);
});

const lab = (text: string, day: string, coding?: { system: string; code: string }): Observation => ({
  resourceType: 'Observation',
  status: 'final',
  subject: { reference: `Patient/${pid}` },
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
  code: { text, ...(coding && { coding: [coding] }) },
  valueQuantity: { value: 5, unit: 'mg/dL' },
  effectiveDateTime: day,
  identifier: [{ system: `urn:ga-server:id:smart:${key}`, value: `Observation/${randomUUID()}` }],
  meta: TAGS('smart'),
});
const gaCode = (r: Observation) => r.code?.coding?.find((c) => c.extension?.some((e) => e.url === CONCEPT_SRC));

test('applyAll codes the uncoded same-source term, is idempotent, leaves excluded alone; reviewList lists unmapped; re-apply swaps a stale coding', async () => {
  await client.createResource(lab('Glucose', '2024-01-01', { system: LOINC, code: '2345-7' }));
  const same = await client.createResource(lab('Glucose', '2024-02-01'));
  await client.createResource(lab('Odd analyte', '2024-03-01'));
  await client.createResource(lab('Odd analyte', '2024-03-05'));
  const apple = await client.createResource<Observation>({ ...lab('Heart rate, daily mean', '2024-01-01'), identifier: [], meta: TAGS('apple-health') });

  const first = await applyAll(client, pid);
  expect(first).toMatchObject({ coded: 1, unmapped: 2, changed: 3 });
  expect(gaCode(await client.readResource('Observation', same.id as string))?.code).toBe('2345-7');
  expect(gaCode(await client.readResource('Observation', apple.id as string))).toBeUndefined();
  expect((await applyAll(client, pid)).changed).toBe(0);

  const list = await reviewList(client, pid, 'unmapped');
  expect(list).toEqual([{ source: `smart:${key}`, type: 'Observation', name: 'Odd analyte', unit: 'mg/dL', count: 2, examples: ['2024-03-05', '2024-03-01'] }]);
  expect(await reviewList(client, pid, 'suggested')).toEqual([]);

  await upsertEntries(client, `smart:${key}`, [{ key: 'glucose|mg/dl', target: { system: LOINC, code: '2339-0' }, equivalence: 'equivalent', confident: true, by: 'agent' }]);
  const r = await applyAll(client, pid, { source: `smart:${key}`, key: 'glucose|mg/dl' });
  expect(r.changed).toBe(1);
  expect(gaCode(await client.readResource('Observation', same.id as string))?.code).toBe('2339-0');
  expect((await client.readResource('Observation', same.id as string)).meta?.tag?.some((t) => t.code === 'src-smart')).toBe(true);
});
