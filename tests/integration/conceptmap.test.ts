import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Condition, Procedure } from '@medplum/fhirtypes';
import { loadMaps, lookup, MAP_URL, type MapEntry, upsertEntry } from '../../src/conceptmap.ts';
import { agentMappings, migrateKeys } from '../../src/concepts-cli.ts';
import { CVX, ICD10CM, LOINC, RXNORM, SNOMED } from '../../src/concepts.ts';
import { getClient } from '../../src/config.ts';
import { emptyTestProject, testProject } from './helpers.ts';

let client: MedplumClient;
let pid: string; // the ga-test project's own patient, never the user's
const source = `test-${randomUUID()}`; // throwaway: never a real source's map

// Runs in the long-lived ga-test project made by ga setup (so the policy under test is the one setup writes), never the user's own.
beforeAll(async () => {
  const t = await testProject();
  pid = t.cfg.patientId;
  client = await getClient(t.cfg);
});
afterAll(async () => {
  delete process.env.GA_CONFIG;
  await emptyTestProject(client);
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

test('a write from a stale read gets 412 and retries on a fresh read: neither writer loses its entry', async () => {
  const stale = await client.searchOne('ConceptMap', { url: MAP_URL + source }, { cache: 'no-cache' });
  await upsertEntry(client, source, entry('sodium|mmol/l', '2951-2')); // the other writer, after our read
  let reads = 0;
  const racing = new Proxy(client, {
    get: (c, k) => (k === 'searchOne' ? async (...a: unknown[]) => (reads++ ? (c.searchOne as (...x: unknown[]) => unknown)(...a) : stale) : Reflect.get(c, k, c)),
  });
  const written = await upsertEntry(racing, source, entry('potassium|mmol/l', '2823-3'));
  expect(reads).toBe(2);
  expect(written?.id).toBe(stale?.id);
  const maps = await loadMaps(client, true);
  expect(lookup(maps, source, 'sodium|mmol/l')?.target?.code).toBe('2951-2');
  expect(lookup(maps, source, 'potassium|mmol/l')?.target?.code).toBe('2823-3');
});

test('migrateKeys types legacy keys by target system, else by the records carrying the term; ambiguous ones drop; idempotent', async () => {
  const src = `smart:mig-${randomUUID()}`;
  const ident = [{ system: `urn:ga-server:id:${src}`, value: `x/${randomUUID()}` }];
  const meta = { tag: [{ system: 'urn:ga-server:tag', code: 'src-smart' }], source: 'https://example.org/fhir' };
  await client.createResource<Procedure>({ resourceType: 'Procedure', status: 'completed', subject: { reference: `Patient/${pid}` }, code: { text: 'Scope' }, identifier: ident, meta });
  await client.createResource<Condition>({ resourceType: 'Condition', subject: { reference: `Patient/${pid}` }, code: { text: 'Weird' }, identifier: ident, meta });
  const e = (key: string, system: string, code: string, by: MapEntry['by'] = 'source'): MapEntry => ({ key, target: { system, code }, equivalence: 'equivalent', confident: true, by });
  // Written as before typed keys: the term alone. Condition|asthma is newer (typed) and wins over the legacy asthma.
  for (const x of [e('influenza', ICD10CM, 'J11.1'), e('flu shot', CVX, '141'), e('asthma', ICD10CM, 'J45.909'), e('Condition|asthma', ICD10CM, 'J45.20', 'agent'),
    e('Lisinopril', RXNORM, '29046'), e('scope', SNOMED, '73761001'), e('ambiguous', SNOMED, '1'), e('glucose|mg/dl', LOINC, '2345-7')]) await upsertEntry(client, src, x);
  await upsertEntry(client, src, { key: 'weird', equivalence: 'unmatched', confident: true, by: 'agent' });

  expect(await migrateKeys(client, pid)).toMatchObject({ entries: 7 });
  const maps = await loadMaps(client, true);
  const code = (k: string) => lookup(maps, src, k)?.target?.code;
  expect([code('Condition|influenza'), code('Immunization|flu shot'), code('Condition|asthma'), code('MedicationStatement|Lisinopril'), code('MedicationRequest|Lisinopril'), code('Procedure|scope'), code('glucose|mg/dl')])
    .toEqual(['J11.1', '141', 'J45.20', '29046', '29046', '73761001', '2345-7']);
  expect(lookup(maps, src, 'Condition|weird')?.equivalence).toBe('unmatched');
  for (const k of ['influenza', 'Immunization|influenza', 'asthma', 'ambiguous', 'Condition|ambiguous', 'Procedure|ambiguous', 'weird']) expect(lookup(maps, src, k), k).toBeUndefined();
  expect(await migrateKeys(client, pid)).toEqual({ maps: 0, entries: 0 });
});

test('agentMappings lists agent entries with their Provenance time; since filters', async () => {
  const src = `smart:agent-${randomUUID()}`;
  const map = await upsertEntry(client, src, { key: 'Condition|synthetic', target: { system: ICD10CM, code: 'E11.9' }, equivalence: 'equivalent', confident: false, by: 'agent' });
  await upsertEntry(client, src, { key: 'learned|x', target: { system: LOINC, code: '2345-7' }, equivalence: 'equivalent', confident: true, by: 'source' });
  await client.createResource({ resourceType: 'Provenance', target: [{ reference: `ConceptMap/${map?.id}` }], recorded: '2026-11-01T10:00:00Z', agent: [{ who: { display: 'test' } }], reason: [{ text: `${src} "Condition|synthetic" (Condition): x` }] });
  const mine = (await agentMappings(client)).filter((m) => m.source === src);
  expect(mine).toEqual([{ source: src, type: 'Condition', term: 'synthetic', system: ICD10CM, code: 'E11.9', equivalence: 'equivalent', confident: false, when: '2026-11-01T10:00:00Z' }]);
  expect((await agentMappings(client, '2026-11-02')).filter((m) => m.source === src)).toEqual([]);
  await expect(agentMappings(client, 'yesterday')).rejects.toThrow(/since/);
});
