// Memory of an Apple Health import: `ga import` in a child process (60 days), and the 2 GB export as an import_file job through
// the import worker in a gateway stand-in (tests/import-memory-host.ts). The 2 GB run: GA_BIG_IMPORT=1 (hours, ~4.5 GB of temp disk).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeAppleExport } from './fixtures-gen/apple.ts';
import { peakRss } from './memory.ts';
import { tempStore } from './temp-store.ts';

// job: through the import worker (the host prints the job's outcome and its peak); else `ga import` in a child.
async function run(days: number, job = false) {
  const store = await tempStore();
  const exp = mkdtempSync(join(tmpdir(), 'ga-apple-mem-'));
  try {
    const pid = (await store.client.createResource({ resourceType: 'Patient' })).id as string;
    const config = join(store.dir, 'config.json');
    writeFileSync(config, JSON.stringify({ store: 'sqlite', storeUrl: store.base, patientId: pid }));
    const gen = await writeAppleExport(exp, days);
    const r = await peakRss(['node', ...(job ? [join(import.meta.dirname, 'import-memory-host.ts')] : ['src/cli.ts', 'import']), exp], { GA_CONFIG: config });
    console.log(`apple import ${days} days: ${gen.records} records, ${Math.round(gen.bytes / 1024 ** 2)} MiB, peak RSS ${r.peakMiB} MiB, exit ${r.exitCode}${job ? `, job ${r.stdout.trim().split('\n').at(-1)}` : ''}`);
    return r;
  } finally { rmSync(exp, { recursive: true, force: true }); await store.close(); }
}

test('a 60-day synthetic export imports and reports its peak memory', async () => {
  const r = await run(60);
  expect(r.exitCode, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout).created).toBeGreaterThan(0);
  expect(r.peakMiB).toBeGreaterThan(0);
}, 300_000);

// The peak is recorded, not asserted: the whole-server run under 512 MB is the gate (the spike note, Task 7).
test.skipIf(!process.env.GA_BIG_IMPORT)('a 2 GB export imports to the end as a job in the import worker; its peak is recorded', async () => {
  const r = await run(3650, true);
  expect(r.exitCode, r.stderr.slice(-500)).toBe(0);
  expect(JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}'), r.stderr.slice(-500)).toMatchObject({ status: 'done', invalid: 0 });
}, 12 * 3_600_000);
