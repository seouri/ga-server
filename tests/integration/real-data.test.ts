import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResourceType } from '@medplum/fhirtypes';
import { expect, test, vi } from 'vitest';
import { ccdaFiles, convertCcda, importPath } from '../../src/ccda.ts';
import { getClient, loadConfig } from '../../src/config.ts';

// Writes to the REAL patient. Prints counts only: never values, names, dates or resource bodies.
const root = process.env.GA_REAL_DATA;

// Server/converter messages can echo field values; keep only issue codes and element paths.
const safe = (e: unknown): string =>
  JSON.stringify(
    (e as { outcome?: { issue?: { code?: string; expression?: string[] }[] } }).outcome?.issue?.map((i) => [i.code, i.expression]) ??
      (e as Error)?.constructor?.name,
  );

test.skipIf(!root)('real ccda imports twice without duplicates', async () => {
  // Glob, not a literal path: the export folder is named after the patient.
  const dirs = globSync('HealthSummary_*/IHE_XDM/*/', { cwd: root as string });
  expect(dirs).toHaveLength(1);
  const dir = join(root as string, dirs[0]);
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const files = ccdaFiles(dir);

  const docsPerId = new Map<string, number>();
  const types = new Set<string>();
  for (const f of files) {
    const rs = await convertCcda(readFileSync(f, 'utf8'), cfg.converterUrl).catch((e) => {
      throw new Error(`convert failed: ${safe(e)}`);
    });
    for (const k of new Set(rs.map((r) => `${r.resourceType}/${r.id}`))) docsPerId.set(k, (docsPerId.get(k) ?? 0) + 1);
    for (const r of rs) types.add(r.resourceType);
  }
  const repeated = [...docsPerId].filter(([, n]) => n > 1);
  const repeatedByType: Record<string, number> = {};
  for (const [k] of repeated) repeatedByType[k.split('/')[0]] = (repeatedByType[k.split('/')[0]] ?? 0) + 1;

  const count = async (type: string, q: Record<string, string>) =>
    (await client.search(type as ResourceType, { ...q, _summary: 'count' }, { cache: 'no-cache' })).total ?? -1;
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of [...types].sort()) if (t !== 'Patient') out[t] = await count(t, { _tag: 'urn:ga-server:tag|src-ccda' });
    out['DocumentReference(file)'] = await count('DocumentReference', { identifier: 'urn:ga-server:id:file|' });
    return out;
  };
  const run = () =>
    importPath(client, cfg, dir).catch((e) => {
      throw new Error(`import failed: ${safe(e)}`);
    });

  // Engine logs `invalid <Type>/<element path>` (no values); tally them per path.
  const invalidPaths = async (fn: () => Promise<unknown>) => {
    const tally: Record<string, number> = {};
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      for (const p of String(m).match(/^invalid (.*)$/)?.[1].split(' ') ?? []) tally[p] = (tally[p] ?? 0) + 1;
    });
    try {
      return [await fn(), tally] as const;
    } finally {
      spy.mockRestore();
    }
  };
  const tagged = async (code: string) => {
    const out: Record<string, number> = {};
    for (const t of [...types].sort()) {
      const n = await count(t, { _tag: `urn:ga-server:tag|${code}` });
      if (n) out[t] = n;
    }
    return out;
  };

  const before = await counts();
  const [first, invalid1] = await invalidPaths(run);
  const after1 = await counts();
  const createdByType = Object.fromEntries(Object.entries(after1).map(([t, n]) => [t, n - (before[t] ?? 0)]));
  const [second, invalid2] = await invalidPaths(run);
  const after2 = await counts();
  const possibleDuplicateByType = await tagged('possible-duplicate');
  const conflictByType = await tagged('source-conflict');
  const patients = (await client.searchResources('Patient', { _count: 1000 }, { cache: 'no-cache' })).filter(
    (p) => !p.meta?.tag?.some((t) => t.system === 'urn:ga-server:tag' && t.code === 'ga-test'),
  ).length;

  console.log(
    JSON.stringify({
      docs: files.length,
      convertedIds: docsPerId.size,
      repeatedIds: repeated.length,
      repeatedByType,
      first,
      second,
      createdByType,
      invalid1,
      invalid2,
      possibleDuplicateByType,
      conflictByType,
      after2,
      patients,
    }),
  );
  expect(second).toMatchObject({ created: 0, updated: 0, merged: 0, possibleDuplicates: 0 });
  expect(patients).toBe(1);
  expect(after2).toEqual(after1);
}, 3_600_000);
