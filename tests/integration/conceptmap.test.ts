import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { loadMaps, lookup, MAP_URL, type MapEntry, upsertEntry } from '../../src/conceptmap.ts';
import { getClient, loadConfig } from '../../src/config.ts';
import { setup } from '../../src/setup.ts';
import { expungeProject, throwawayConfig } from './helpers.ts';
import { LOINC } from '../../src/concepts.ts';

let client: MedplumClient;
let session: MedplumClient;
let projectId: string;
const source = `test-${randomUUID()}`; // throwaway: never a real source's map

// Runs against a throwaway project made by ga setup (so the policy under test is the one setup writes), never the user's own.
beforeAll(async () => {
  const t = await throwawayConfig();
  session = t.session;
  projectId = (await setup(t.baseUrl, undefined, { projectName: `ga-test-${randomUUID().slice(0, 8)}` })).projectId as string;
  client = await getClient(loadConfig());
});
afterAll(async () => {
  for (const m of await client.searchResources('ConceptMap', { url: MAP_URL + source })) await client.deleteResource('ConceptMap', m.id as string);
  delete process.env.GA_CONFIG;
  // The sandbox admin may lack expunge rights (tests/integration/stack.test.ts fails the same way); don't hide the assertions behind it.
  await expungeProject(session, projectId).catch((e) => console.warn(`throwaway project ${projectId} not expunged: ${e.message}`));
});

const entry = (key: string, code: string, extra: Partial<MapEntry> = {}): MapEntry => ({ key, target: { system: LOINC, code }, equivalence: 'equivalent', confident: true, by: 'agent', ...extra });

test('upsertEntry then lookup round-trips; a second upsert replaces; the serum entry is not returned for the urine key', async () => {
  await upsertEntry(client, source, entry('glucose|mg/dl|serum', '2345-7'));
  await upsertEntry(client, source, entry('glucose|mg/dl|urine', '2350-7', { by: 'source', confident: false, equivalence: 'wider' }));
  for (const equivalence of ['narrower', 'inexact'] as const) await upsertEntry(client, source, entry(`bun|${equivalence}`, '1234-5', { equivalence })); // cmd-1: Medplum rejects these without a comment
  await upsertEntry(client, source, { key: 'weird term|x', equivalence: 'unmatched', confident: true, by: 'agent' });

  let maps = await loadMaps(client);
  expect(lookup(maps, source, 'glucose|mg/dl|serum')).toEqual(entry('glucose|mg/dl|serum', '2345-7'));
  expect(lookup(maps, source, 'glucose|mg/dl|urine')).toEqual(entry('glucose|mg/dl|urine', '2350-7', { by: 'source', confident: false, equivalence: 'wider' }));
  expect(lookup(maps, source, 'weird term|x')).toEqual({ key: 'weird term|x', equivalence: 'unmatched', confident: true, by: 'agent' });
  expect(lookup(maps, source, 'bun|inexact')?.equivalence).toBe('inexact');
  expect(lookup(maps, source, 'bun|narrower')?.equivalence).toBe('narrower');
  expect(lookup(maps, source, 'glucose|mg/dl')).toBeUndefined();
  expect(lookup(maps, 'other-source', 'glucose|mg/dl|serum')).toBeUndefined();

  await upsertEntry(client, source, entry('glucose|mg/dl|serum', '2339-0'));
  maps = await loadMaps(client);
  expect(lookup(maps, source, 'glucose|mg/dl|serum')?.target?.code).toBe('2339-0');
  expect(lookup(maps, source, 'glucose|mg/dl|urine')?.target?.code).toBe('2350-7');
  const groups = maps.get(source)?.group ?? [];
  expect(groups.flatMap((g) => g.element ?? []).filter((e) => e.code === 'glucose|mg/dl|serum')).toHaveLength(1);
});
