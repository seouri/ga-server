import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Procedure, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { CONCEPT_SRC, type Unmapped } from '../../src/concept-apply.ts';
import { autoMap, type Reviewed } from '../../src/concept-auto.ts';
import { mapTerm } from '../../src/concept-map-term.ts';
import { CPT, SNOMED } from '../../src/concepts.ts';
import { getClient, loadConfig } from '../../src/config.ts';
import { DUP_OF } from '../../src/engine.ts';
import { importExtracted } from '../../src/mcp.ts';
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

// A smart-source record of `name` tagged possible-duplicate, linked (DUP_OF) to a portal record carrying `codings`.
const linkedPair = async (name: string, codings: { system: string; code: string }[]) => {
  const key = smart();
  const portal = await client.createResource<Procedure>({ ...proc(name, smart()), code: { text: name, coding: codings }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-smart' }] } });
  const base = proc(name, key);
  const dup = await client.createResource<Procedure>({
    ...base, extension: [{ url: DUP_OF, valueReference: { reference: `Procedure/${portal.id}` } }],
    meta: { ...base.meta, tag: [...(base.meta?.tag ?? []), { system: 'urn:ga-server:tag', code: 'possible-duplicate' }] },
  });
  return { dup, row: row(`smart:${key}`, name) };
};

test('the linked candidate is the SNOMED code, never CPT', async () => {
  const both = await linkedPair('Colonoscopy screening', [{ system: CPT, code: '45378' }, { system: SNOMED, code: '73761001' }]);
  const cptOnly = await linkedPair('Colonoscopy screening', [{ system: CPT, code: '45378' }]);
  const { f } = fake();
  const a = await autoMap(client, pid, [both.row], { fetch: f });
  expect(a.terms[0].candidates[0]).toMatchObject({ system: SNOMED, code: '73761001', from: 'linked record' });
  const b = await autoMap(client, pid, [cptOnly.row], { fetch: f });
  expect(b.terms[0].candidates.some((c) => c.from || c.system === CPT)).toBe(false);
});

test('a linked code that differs from the exact match is left for the agent', async () => {
  const { dup, row: r } = await linkedPair('Colonoscopy', [{ system: SNOMED, code: '446521004' }]);
  const { f } = fake();
  const res = await autoMap(client, pid, [r], { fetch: f });
  expect(res.autoMapped).toBe(0);
  expect(res.terms[0].candidates.map((c) => c.code)).toEqual(['446521004', '73761001']);
  expect(res.terms[0].candidates[0].from).toBe('linked record');
  expect(gaCode(await client.readResource('Procedure', dup.id as string))).toBeUndefined();
});

test('a linked code equal to the exact match is auto-mapped', async () => {
  const { dup, row: r } = await linkedPair('Colonoscopy', [{ system: SNOMED, code: '73761001' }]);
  const { f } = fake();
  const res = await autoMap(client, pid, [r], { fetch: f });
  expect(res.autoMapped).toBe(1);
  expect(gaCode(await client.readResource('Procedure', dup.id as string))?.code).toBe('73761001');
});

// A throwaway PDF (unique bytes: a file is imported once) and a Procedure whose name never equals a candidate, so the
// install-wide pdf map gets no entry.
const pdf = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-auto-'));
  const file = join(dir, 'report.pdf');
  writeFileSync(file, `%PDF-1.4 synthetic ${randomUUID()}`);
  return file;
};
const extracted = () => [{ resourceType: 'Procedure', status: 'completed', code: { text: `Colonoscopy ${randomUUID().slice(0, 8)}` }, performedDateTime: '2024-01-01' }] as Resource[];

test('ga_import returns candidates and autoMapped', async () => {
  const { f } = fake();
  const r = await importExtracted(client, { ...loadConfig(), terminologyLookup: true }, extracted(), pdf(), undefined, pid, { fetch: f }) as unknown as { autoMapped: number; unmapped: Reviewed[] };
  expect(r.autoMapped).toBe(0);
  expect(r.unmapped).toHaveLength(1);
  expect(r.unmapped[0].candidates[0]).toEqual({ system: SNOMED, code: '73761001', display: 'Colonoscopy' });
});

test('terminologyLookup false makes no request', async () => {
  const spy = vi.fn(fake().f);
  const r = await importExtracted(client, { ...loadConfig(), terminologyLookup: false }, extracted(), pdf(), undefined, pid, { fetch: spy }) as unknown as { unmapped: Reviewed[] };
  expect(spy).not.toHaveBeenCalled();
  expect(r.unmapped.map((t) => t.candidates)).toEqual([[]]);
});
