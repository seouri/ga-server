import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';

// No lock file, no write path, no terminology calls: only importExtracted's own flow is under test.
const order: string[] = [];
vi.mock('../src/lock.ts', () => ({ withImportLock: async (fn: () => Promise<unknown>) => { order.push('lock'); try { return await fn(); } finally { order.push('unlock'); } } }));
vi.mock('../src/engine.ts', async (orig) => ({ ...(await orig<object>()), importResources: async (_c: unknown, rs: Resource[]) => { order.push('import'); return { created: rs.length, merged: 0 }; } }));
vi.mock('../src/concept-auto.ts', () => ({ afterImport: async (_c: unknown, _cfg: unknown, report: unknown) => report }));
const { importExtracted } = await import('../src/mcp.ts');

const OBS = { resourceType: 'Observation', status: 'final', code: { text: 'Synthetic' }, valueQuantity: { value: 1, unit: 'mg/dL' } } as Resource;
const DOC = { resourceType: 'DocumentReference', id: 'd1', status: 'current', content: [{ attachment: { title: 'report.pdf', url: 'Binary/b1' } }] };

function setup(cited: Resource[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'ga-extract-')), 'report.pdf');
  writeFileSync(file, '%PDF-1.4 synthetic');
  const posted: string[] = [];
  const client = {
    validateResource: async () => ({}),
    searchOne: async (t: string) => { if (t === 'DocumentReference') order.push('doc lookup'); return t === 'DocumentReference' ? DOC : undefined; },
    searchResourcePages: async function* (t: string) { yield cited.filter((r) => r.resourceType === t); },
    post: async (url: string) => { posted.push(url); return { id: 'b2' }; },
    getBaseUrl: () => 'http://store/',
  } as unknown as MedplumClient;
  return { file, client, posted };
}

test('ga_import of a file stored by an import that wrote no records reuses the stored copy, inside the import lock', async () => {
  order.length = 0;
  const { file, client, posted } = setup([]);
  const r = await importExtracted(client, { patientId: 'p' } as never, [OBS], file);
  expect(r).toMatchObject({ created: 1 });
  expect(posted).toEqual([]); // no second Binary
  expect(order).toEqual(['lock', 'doc lookup', 'doc lookup', 'import', 'unlock']);
});

test('ga_import of a file a record already cites is refused, naming the stored DocumentReference', async () => {
  order.length = 0;
  const { file, client } = setup([{ ...OBS, id: 'o1', derivedFrom: [{ reference: 'DocumentReference/d1' }], meta: { tag: [{ system: 'urn:ga-server:tag', code: 'extracted-by-llm' }] } } as Resource]);
  await expect(importExtracted(client, { patientId: 'p' } as never, [OBS], file)).rejects.toThrow(/^already imported: report\.pdf \(DocumentReference\/d1\); .*delete the records that cite DocumentReference\/d1 to import it again$/);
  expect(order).not.toContain('import');
});
