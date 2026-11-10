// Child-process memory of `ga import` on a synthetic Apple Health export. The big run: GA_BIG_IMPORT=1 (2 GB, minutes, ~2.2 GB of temp disk).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { IMPORT_CHILD_HEAP_MB, IMPORT_CHILD_RSS_MB } from '../src/limits.ts';
import { writeAppleExport } from './fixtures-gen/apple.ts';
import { peakRss } from './memory.ts';
import { tempStore } from './temp-store.ts';

async function run(days: number, heapMb?: number) {
  const store = await tempStore();
  const exp = mkdtempSync(join(tmpdir(), 'ga-apple-mem-'));
  try {
    const pid = (await store.client.createResource({ resourceType: 'Patient' })).id as string;
    const config = join(store.dir, 'config.json');
    writeFileSync(config, JSON.stringify({ store: 'sqlite', storeUrl: store.base, patientId: pid }));
    const gen = await writeAppleExport(exp, days);
    const r = await peakRss(['node', ...(heapMb ? [`--max-old-space-size=${heapMb}`] : []), 'src/cli.ts', 'import', exp], { GA_CONFIG: config });
    console.log(`apple import ${days} days: ${gen.records} records, ${Math.round(gen.bytes / 1024 ** 2)} MiB, peak RSS ${r.peakMiB} MiB, exit ${r.exitCode}`);
    return r;
  } finally { rmSync(exp, { recursive: true, force: true }); await store.close(); }
}

test('a 60-day synthetic export imports and reports its peak memory', async () => {
  const r = await run(60);
  expect(r.exitCode, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout).created).toBeGreaterThan(0);
  expect(r.peakMiB).toBeGreaterThan(0);
}, 300_000);

test.skipIf(!process.env.GA_BIG_IMPORT)('a 2 GB export imports within the child cap', async () => {
  const r = await run(3650, IMPORT_CHILD_HEAP_MB);
  expect(r.exitCode, r.stderr.slice(0, 500)).toBe(0);
  expect(r.peakMiB).toBeLessThanOrEqual(IMPORT_CHILD_RSS_MB);
}, 3_600_000);
