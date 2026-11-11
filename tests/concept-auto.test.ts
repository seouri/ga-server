import { describe, expect, it, vi } from 'vitest';
import { CVX, SNOMED } from '../src/concepts.ts';
import type { MedplumClient } from '@medplum/core';
import { autoMap, pickAuto } from '../src/concept-auto.ts';

const c = (code: string, display: string, from?: 'linked record') => ({ system: SNOMED, code, display, ...(from && { from }) });

describe('pickAuto', () => {
  it('maps a single exact name', () => {
    expect(pickAuto('Colonoscopy', [c('73761001', 'Colonoscopy'), c('12350003', 'Colonoscopy with biopsy')])?.code).toBe('73761001');
  });
  it('ignores case and punctuation', () => {
    expect(pickAuto('colonoscopy.', [c('73761001', 'Colonoscopy')])?.code).toBe('73761001');
  });
  it('two exact names map nothing', () => {
    expect(pickAuto('Colonoscopy', [c('73761001', 'Colonoscopy'), c('446521004', 'Colonoscopy')])).toBeUndefined();
  });
  it('a linked-record candidate is never auto-mapped', () => {
    expect(pickAuto('Colonoscopy', [c('73761001', 'Colonoscopy', 'linked record'), c('12350003', 'Colonoscopy with biopsy')])).toBeUndefined();
  });
});

describe('autoMap', () => {
  it('never throws when the server fails', async () => {
    const down = () => Promise.reject(new Error('server down'));
    const client = { searchResources: down, readResource: down, createResource: down } as unknown as MedplumClient;
    const term = { source: 'pdf', type: 'Procedure', key: 'Procedure|colonoscopy', name: 'Colonoscopy', count: 1 };
    await expect(autoMap(client, 'p', [term], { fetch: down as typeof fetch })).resolves.toEqual({ autoMapped: 0, terms: [{ ...term, candidates: [] }] });
  });
  // A client with no maps and no possible duplicates; every write is recorded.
  const empty = () => ({
    searchResources: vi.fn(async () => []), searchOne: vi.fn(async () => undefined), readResource: vi.fn(), createResource: vi.fn(async (r: object) => ({ ...r, id: 'x' })),
    createResourceIfNoneExist: vi.fn(async (r: object) => ({ ...r, id: 'm' })), updateResource: vi.fn(),
  });
  const colo = { source: 'pdf', type: 'Procedure', key: 'Procedure|colonoscopy', name: 'Colonoscopy', count: 1 };
  it('maps nothing when the picked code cannot be validated', async () => {
    const client = empty();
    const f = (async (input: string | URL) => String(input).includes('ValueSet/$expand')
      ? new Response(JSON.stringify({ expansion: { contains: [{ code: '73761001', display: 'Colonoscopy' }] } }))
      : new Response('busy', { status: 503 })) as typeof fetch;
    const r = await autoMap(client as unknown as MedplumClient, 'p', [colo], { fetch: f });
    expect(r).toEqual({ autoMapped: 0, terms: [{ ...colo, candidates: [c('73761001', 'Colonoscopy')] }] });
    expect(client.createResourceIfNoneExist).not.toHaveBeenCalled(); // no map entry
    expect(client.createResource).not.toHaveBeenCalled();
  });
  it('gives up at the deadline: unsearched terms come back without candidates', async () => {
    const hang = (() => new Promise(() => {})) as typeof fetch;
    const terms = Array.from({ length: 8 }, (_, i) => ({ ...colo, key: `Procedure|t${i}`, name: `Synthetic ${i}` }));
    const t0 = Date.now();
    const r = await autoMap(empty() as unknown as MedplumClient, 'p', terms, { fetch: hang, deadline: 100 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r).toEqual({ autoMapped: 0, terms: terms.map((t) => ({ ...t, candidates: [] })) });
  });
  it('offers the closest CVX table names for a vaccine, never maps them, and sends nothing', async () => {
    const client = empty();
    const f = vi.fn();
    const term = { source: 'pdf', type: 'Immunization', key: 'Immunization|dt pediatric', name: 'DT pediatric', count: 1 };
    const r = await autoMap(client as unknown as MedplumClient, 'p', [term], { fetch: f as unknown as typeof fetch });
    expect(r.autoMapped).toBe(0);
    expect(r.terms[0].candidates[0]).toEqual({ system: CVX, code: '28', display: 'DT (pediatric)' });
    expect(f).not.toHaveBeenCalled();
    expect(client.createResourceIfNoneExist).not.toHaveBeenCalled();
  });
});
