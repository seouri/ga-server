import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Procedure } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { CONCEPT_SRC, type Unmapped } from '../../src/concept-apply.ts';
import { autoMap } from '../../src/concept-auto.ts';
import { mapTerm } from '../../src/concept-map-term.ts';
import { SNOMED } from '../../src/concepts.ts';
import { getClient, loadConfig } from '../../src/config.ts';
import { DUP_OF } from '../../src/engine.ts';
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

// Synthetic terminology answers: SNOMED search by filter, SNOMED $lookup by code. Records every searched term.
const NAMES: Record<string, string> = { '73761001': 'Colonoscopy', '446521004': 'Colonoscopy with biopsy', '263135001': 'Pinning of fracture' };
const fake = () => {
  const searched: string[] = [];
  const f = (async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith('/ValueSet/$expand')) {
      const term = u.searchParams.get('filter') ?? '';
      searched.push(term);
      const hits = Object.entries(NAMES).filter(([, d]) => d.toLowerCase().split(' ').some((w) => term.toLowerCase().includes(w)));
      return new Response(JSON.stringify({ expansion: { contains: hits.map(([code, display]) => ({ code, display })) } }));
    }
    const code = u.searchParams.get('code') ?? '';
    return new Response(JSON.stringify({ parameter: [{ name: 'display', valueString: NAMES[code] ?? 'Synthetic' }] }));
  }) as typeof fetch;
  return { f, searched };
};

const smart = () => `good-${randomUUID()}`; // a throwaway source: cleanupTestMaps removes its map
const proc = (text: string, source: string, extra: Partial<Procedure> = {}): Procedure => ({
  resourceType: 'Procedure', status: 'completed', subject: { reference: `Patient/${pid}` }, code: { text }, performedDateTime: '2024-01-01',
  identifier: [{ system: `urn:ga-server:id:smart:${source}`, value: `Procedure/${randomUUID()}` }],
  meta: { source: 'https://example.org/fhir', tag: [{ system: 'urn:ga-server:tag', code: 'src-smart' }, { system: 'urn:ga-server:tag', code: 'concept-unmapped' }] },
  ...extra,
});
const row = (source: string, name: string, count = 1): Unmapped => ({ source, type: 'Procedure', key: `Procedure|${name.toLowerCase()}`, name, count });
const gaCode = (r: Procedure) => r.code?.coding?.find((c) => c.extension?.some((e) => e.url === CONCEPT_SRC));

test('maps an exact match and returns the rest with candidates', async () => {
  const key = smart();
  const colo = await client.createResource(proc('Colonoscopy', key));
  await client.createResource(proc('Pinning of finger fracture', key));
  const { f } = fake();
  const r = await autoMap(client, pid, [row(`smart:${key}`, 'Colonoscopy'), row(`smart:${key}`, 'Pinning of finger fracture')], { fetch: f });
  expect(r.autoMapped).toBe(1);
  const coded = await client.readResource('Procedure', colo.id as string);
  expect(gaCode(coded)).toMatchObject({ system: SNOMED, code: '73761001' });
  expect(coded.meta?.tag?.some((t) => t.code === 'concept-unmapped' || t.code === 'concept-suggested')).toBe(false);
  expect(r.terms.map((t) => t.name)).toEqual(['Pinning of finger fracture']);
  expect(r.terms[0].candidates).toEqual([{ system: SNOMED, code: '263135001', display: 'Pinning of fracture' }]);
});

test('never replaces an existing mapping', async () => {
  const key = smart();
  const colo = await client.createResource(proc('Colonoscopy', key));
  const { f } = fake();
  await mapTerm(client, pid, { source: `smart:${key}`, name: 'Colonoscopy', type: 'Procedure', system: SNOMED, code: '446521004', display: 'Colonoscopy with biopsy', equivalence: 'equivalent', confident: true }, 'test agent', { fetch: f });
  const r = await autoMap(client, pid, [row(`smart:${key}`, 'Colonoscopy')], { fetch: f });
  expect(r.autoMapped).toBe(0);
  expect(gaCode(await client.readResource('Procedure', colo.id as string))?.code).toBe('446521004');
});

test('a service failure leaves terms unmapped', async () => {
  const key = smart();
  await client.createResource(proc('Colonoscopy', key));
  const f = (async () => { throw new Error('offline'); }) as typeof fetch;
  const r = await autoMap(client, pid, [row(`smart:${key}`, 'Colonoscopy'), row(`smart:${key}`, 'Pinning of finger fracture')], { fetch: f });
  expect(r.autoMapped).toBe(0);
  expect(r.terms.map((t) => t.candidates)).toEqual([[], []]);
});

test('searches only the 50 most frequent terms', async () => {
  const key = smart();
  const rows = Array.from({ length: 60 }, (_, i) => row(`smart:${key}`, `Synthetic term ${i}`, 100 - i));
  const { f, searched } = fake();
  const r = await autoMap(client, pid, rows, { fetch: f });
  expect(new Set(searched).size).toBe(50);
  expect(searched.some((s) => /Synthetic term 5\d/.test(s))).toBe(false);
  expect(r.terms.slice(50).every((t) => t.candidates.length === 0)).toBe(true);
});

test('lookup off: no request, every term without candidates', async () => {
  const key = smart();
  const { f, searched } = fake();
  const r = await autoMap(client, pid, [row(`smart:${key}`, 'Colonoscopy')], { fetch: f, lookup: false });
  expect(searched).toEqual([]);
  expect(r).toEqual({ autoMapped: 0, terms: [{ ...row(`smart:${key}`, 'Colonoscopy'), candidates: [] }] });
});

test('offers the code of a linked duplicate first', async () => {
  const portalKey = smart();
  const portal = await client.createResource<Procedure>({ ...proc('Colonoscopy', portalKey), code: { text: 'Colonoscopy', coding: [{ system: SNOMED, code: '73761001' }] }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-smart' }] } });
  const name = `Colonoscopy ${randomUUID().slice(0, 8)}`; // the install-wide pdf map never gets this term: nothing is mapped
  await client.createResource<Procedure>({
    resourceType: 'Procedure', status: 'completed', subject: { reference: `Patient/${pid}` }, code: { text: name }, performedDateTime: '2024-01-01',
    extension: [{ url: DUP_OF, valueReference: { reference: `Procedure/${portal.id}` } }],
    meta: { tag: ['src-pdf', 'concept-unmapped', 'possible-duplicate'].map((code) => ({ system: 'urn:ga-server:tag', code })) },
  });
  const { f } = fake();
  const r = await autoMap(client, pid, [{ source: 'pdf', type: 'Procedure', key: `Procedure|${name.toLowerCase()}`, name, count: 1 }], { fetch: f });
  expect(r.autoMapped).toBe(0);
  expect(r.terms[0].candidates[0]).toMatchObject({ system: SNOMED, code: '73761001', from: 'linked record' });
});
