// Apple Health import in batches gives the unbatched result on Medplum (spec: same result), in the ga-test project.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { importAppleHealth } from '../../src/apple/import.ts';
import { getClient } from '../../src/config.ts';
import { ARRIVED, sorted } from '../../src/identity.ts';
import { writeAppleTestExport } from '../fixtures-gen/apple.ts';
import { SQLITE, emptyTestProject, testProject } from './helpers.ts';

// Days are cut in the machine's zone: pin it, as tests/apple-batches.test.ts does.
const oldTz = process.env.TZ;
process.env.TZ = 'America/New_York';
let exp: string;
beforeAll(async () => {
  exp = mkdtempSync(join(tmpdir(), 'ga-apple-int-batches-'));
  await writeAppleTestExport(exp, 30, { twoSources: true });
});
afterAll(() => {
  rmSync(exp, { recursive: true, force: true });
  if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
});

// Everything the import wrote, without server ids, times and arrival stamps; a reference reads as its target's identifier.
async function snapshot(client: MedplumClient, pid: string): Promise<string[]> {
  const all: (Resource & { identifier?: { value?: string; system?: string }[] })[] = [];
  for (const [type, param] of [['Observation', 'subject'], ['DocumentReference', 'subject'], ['AllergyIntolerance', 'patient']] as const) {
    for await (const page of client.searchResourcePages(type, { [param]: `Patient/${pid}`, _count: '1000' }, { cache: 'no-cache' })) all.push(...page);
  }
  const idOf = new Map(all.map((r) => [`${r.resourceType}/${r.id}`, r.identifier?.[0]?.value]));
  return all.filter((r) => !r.identifier?.some((i) => i.system === 'urn:ga-server:id:apple-health-archive')).map((r) => { // the archive: a new tarball each run
    const { id: _i, meta, extension, ...rest } = r as Resource & { extension?: { url: string }[] };
    const ext = extension?.filter((e) => e.url !== ARRIVED);
    const derived = (r as { derivedFrom?: { reference?: string }[] }).derivedFrom;
    return JSON.stringify({ ...rest, tag: meta?.tag, ...(ext?.length && { extension: ext }), ...(derived && { derivedFrom: derived.map((d) => idOf.get(d.reference ?? '')) }) }, sorted);
  }).sort();
}
const report = ({ seconds: _s, ...r }: { seconds: number }) => r;

test.skipIf(SQLITE)('batched import on Medplum writes the unbatched resources; a re-import writes nothing', { timeout: 900_000 }, async () => {
  const { cfg } = await testProject();
  const client = await getClient(cfg);
  const pid = cfg.patientId as string;
  try {
    await emptyTestProject(client);
    const batched = await importAppleHealth(client, cfg, exp, pid, { batchSize: 50 });
    const snapBatched = await snapshot(client, pid);
    // Every batch's identifiers exist now, so each batch's search sends full 40-identifier chunks.
    const again = await importAppleHealth(client, cfg, exp, pid, { batchSize: 50 });
    expect(again).toMatchObject({ created: 0, updated: 0, archived: 'already-present' });
    expect(again.unchanged).toBe(batched.created - 1); // the allergy always goes to the engine, which skips it
    expect(await snapshot(client, pid)).toEqual(snapBatched);

    await emptyTestProject(client);
    const whole = await importAppleHealth(client, cfg, exp, pid, { batchSize: 1_000_000 });
    expect(report(batched)).toEqual(report(whole));
    expect(batched.created).toBeGreaterThan(500);
    expect(snapBatched).toEqual(await snapshot(client, pid));
  } finally { await emptyTestProject(client); }
});
