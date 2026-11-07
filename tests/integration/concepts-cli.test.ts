import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { CONCEPT_SRC } from '../../src/concept-apply.ts';
import { applyAll, reviewList, scan } from '../../src/concepts-cli.ts';
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
  expect(list).toEqual([{ source: `smart:${key}`, type: 'Observation', key: 'odd analyte|mg/dl', name: 'Odd analyte', unit: 'mg/dL', count: 2, examples: ['2024-03-05', '2024-03-01'] }]);
  expect(await reviewList(client, pid, 'suggested')).toEqual([]);

  await upsertEntries(client, `smart:${key}`, [{ key: 'glucose|mg/dl', target: { system: LOINC, code: '2339-0' }, equivalence: 'equivalent', confident: true, by: 'agent' }]);
  const r = await applyAll(client, pid, { source: `smart:${key}`, key: 'glucose|mg/dl' });
  expect(r.changed).toBe(1);
  expect(gaCode(await client.readResource('Observation', same.id as string))?.code).toBe('2339-0');
  expect((await client.readResource('Observation', same.id as string)).meta?.tag?.some((t) => t.code === 'src-smart')).toBe(true);
});

const ehiKey = () => `synthetic-fill-${randomUUID().slice(0, 8)}`;
const withSrc = (o: Observation, tags: string[], source: string, ids: string[]): Observation => ({
  ...o,
  identifier: ids.map((system) => ({ system, value: `Observation/${randomUUID()}` })),
  meta: { source, tag: tags.map((code) => ({ system: 'urn:ga-server:tag', code: `src-${code}` })) },
});
const agentGlucose = (source: string, code: string) => upsertEntries(client, source, [{ key: 'glucose|mg/dl', target: { system: LOINC, code }, equivalence: 'equivalent', confident: true, by: 'agent' }]);

test('C-CDA records are keyed by the custodian read from the stored source file; an unresolvable one is left untouched', async () => {
  const org = `Synthetic Clinic ${randomUUID()}`;
  const name = `HS-${randomUUID().slice(0, 8)}.xml`;
  const file = `/nowhere/folder-${randomUUID().slice(0, 8)}/${name}`;
  const bin = await client.createBinary({ data: `<ClinicalDocument><custodian><assignedCustodian><representedCustodianOrganization><name>${org}</name></representedCustodianOrganization></assignedCustodian></custodian></ClinicalDocument>`, contentType: 'application/xml', filename: name });
  await client.createResource({
    resourceType: 'DocumentReference', status: 'current', subject: { reference: `Patient/${pid}` },
    identifier: [{ system: 'urn:ga-server:id:file', value: randomUUID() }],
    content: [{ attachment: { contentType: 'application/xml', url: `Binary/${bin.id}`, title: name } }],
  });
  await agentGlucose(`ccda:${org.toLowerCase().replaceAll('-', ' ')}`, '2345-7');
  const a = await client.createResource(withSrc(lab('Glucose', '2024-04-01'), ['ccda'], file, []));
  // A file with no stored copy: its key can't be derived, so nothing is written.
  const lost = await client.createResource(withSrc(lab('Glucose', '2024-04-02'), ['ccda'], '/nowhere/lost/gone.xml', []));
  await applyAll(client, pid);
  expect(gaCode(await client.readResource('Observation', a.id as string))?.code).toBe('2345-7');
  const l = await client.readResource('Observation', lost.id as string);
  expect(gaCode(l)).toBeUndefined();
  expect(l.meta?.tag?.some((t) => t.code?.startsWith('concept-'))).toBe(false);
  await client.deleteResource('Binary', bin.id as string);
});

test('a record last changed by someone else is left alone', async () => {
  const k = `good-${randomUUID()}`;
  await agentGlucose(`smart:${k}`, '2345-7');
  const r = await client.createResource(withSrc(lab('Glucose', '2024-05-01'), ['smart'], 'https://example.org/fhir', [`urn:ga-server:id:smart:${k}`]));
  expect(r.meta?.author?.reference).toBeTruthy();
  const other = new Proxy(client, { get: (t, p) => (p === 'getProfile' ? () => ({ resourceType: 'ClientApplication', id: 'someone-else' }) : Reflect.get(t, p).bind?.(t) ?? Reflect.get(t, p)) });
  expect((await applyAll(other, pid, { source: `smart:${k}`, key: 'glucose|mg/dl' })).changed).toBe(0);
  expect((await applyAll(client, pid, { source: `smart:${k}`, key: 'glucose|mg/dl' })).changed).toBe(1);
});

test('a record with several source tags takes the one whose key has a map, else is skipped', async () => {
  const k = `good-${randomUUID()}`;
  await agentGlucose(`smart:${k}`, '2345-7');
  const ids = (s: string, h: string) => [`urn:ga-server:id:smart:${s}`, `urn:ga-server:id:ehi:${h}`];
  const hit = await client.createResource(withSrc(lab('Glucose', '2024-06-01'), ['smart', 'ehi'], 'x', ids(k, ehiKey())));
  const none = await client.createResource(withSrc(lab('Glucose', '2024-06-02'), ['smart', 'ehi'], 'x', ids(`good-${randomUUID()}`, ehiKey())));
  await applyAll(client, pid);
  expect(gaCode(await client.readResource('Observation', hit.id as string))?.code).toBe('2345-7');
  expect((await client.readResource('Observation', none.id as string)).meta?.tag?.some((t) => t.code?.startsWith('concept-'))).toBe(false);
});

test('reviewList rejects an unknown type', async () => {
  await expect(reviewList(client, pid, 'unmapped', 'Patient')).rejects.toThrow(/type must be/);
});

test('scan pages by cursor, never _offset, over more than one page', async () => {
  const k = `good-${randomUUID()}`;
  for (let i = 0; i < 25; i++) await client.createResource(withSrc(lab(`Paged ${i}`, '2024-07-01'), ['smart'], 'x', [`urn:ga-server:id:smart:${k}`]));
  const queries: string[] = [];
  const spy = new Proxy(client, {
    get: (t, p) => (p === 'searchResourcePages' || p === 'searchResources'
      ? (type: string, q: Record<string, string>, o: object) => { queries.push(JSON.stringify(q)); return (t as never as Record<string, (...a: unknown[]) => unknown>)[p as string](type, q, o); }
      : Reflect.get(t, p).bind?.(t) ?? Reflect.get(t, p)),
  });
  let seen = 0;
  let pages = 0;
  for await (const page of scan(spy, pid, ['Observation'], {}, 20)) {
    pages++;
    seen += page.filter((r) => (r as Observation).code?.text?.startsWith('Paged')).length;
  }
  expect(seen).toBe(25);
  expect(pages).toBeGreaterThan(1);
  expect(queries.length).toBeGreaterThan(2);
  expect(queries.some((q) => q.includes('_offset'))).toBe(false);
});

test('a stale backfill write gets 412: re-read and re-coded once (the other change kept), else left without error', async () => {
  const k = `good-${randomUUID()}`;
  await agentGlucose(`smart:${k}`, '2345-7');
  const mk = () => client.createResource(withSrc(lab('Glucose', '2024-08-01'), ['smart'], 'x', [`urn:ga-server:id:smart:${k}`]));
  let bumps = 0;
  const queries: string[] = [];
  let downloads = 0;
  // Another writer changes the record between our read and each of our next `bumps` writes.
  const racing = new Proxy(client, {
    get: (t, p) => {
      if (p === 'updateResource') {
        return async (res: Observation, opts: object) => {
          if (bumps-- > 0) await t.updateResource({ ...(await t.readResource('Observation', res.id as string, { cache: 'no-cache' })), note: [{ text: `meanwhile ${randomUUID()}` }] }); // new content each time: an unchanged write makes no version
          return t.updateResource(res, opts);
        };
      }
      if (p === 'searchResourcePages') return (type: string, q: Record<string, string>, o: object) => (queries.push(JSON.stringify(q)), t.searchResourcePages(type as 'Observation', q, o));
      if (p === 'download') return (...a: unknown[]) => (downloads++, (t.download as (...x: unknown[]) => unknown)(...a));
      return Reflect.get(t, p).bind?.(t) ?? Reflect.get(t, p);
    },
  });
  const r = await mk();
  bumps = 1;
  expect((await applyAll(racing, pid, { source: `smart:${k}`, key: 'glucose|mg/dl', type: 'Observation' })).changed).toBe(1);
  const got = await client.readResource('Observation', r.id as string);
  expect(got.note?.[0].text).toMatch(/^meanwhile/);
  expect(gaCode(got)?.code).toBe('2345-7');
  // map_concept's scan asks only for its source kind and reads no source file
  expect(queries.every((q) => q.includes('"_tag":"urn:ga-server:tag|src-smart"'))).toBe(true);
  expect(downloads).toBe(0);

  const r2 = await mk();
  bumps = 2;
  expect((await applyAll(racing, pid, { source: `smart:${k}`, key: 'glucose|mg/dl', type: 'Observation' })).changed).toBe(0);
  expect(gaCode(await client.readResource('Observation', r2.id as string))).toBeUndefined();
});
