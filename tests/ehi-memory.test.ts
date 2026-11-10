// Memory of an Epic EHI (and a C-CDA) import_file job: a synthetic export through the import worker in a gateway stand-in
// (tests/import-memory-host.ts), on a temp store. The real-sized runs (about 100 MB and 500 MB, hours): GA_BIG_IMPORT=1.
// The budget is Linux's (node:26 alpine, docs/superpowers/spikes/2026-11-09-import-memory.md): there the import's anonymous memory
// over the idle gateway stays within IMPORT_WORKER_RSS_MB. Elsewhere (macOS counts memory differently) the figures are printed only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { IMPORT_WORKER_RSS_MB } from '../src/limits.ts';
import { writeEhiExport } from './fixtures-gen/ehi.ts';
import { peakRss } from './memory.ts';
import { tempStore } from './temp-store.ts';

// factor: a synthetic EHI export of that factor; a path: that upload.
async function run(upload: number | string) {
  const store = await tempStore();
  const exp = mkdtempSync(join(tmpdir(), 'ga-ehi-mem-'));
  try {
    const pid = (await store.client.createResource({ resourceType: 'Patient' })).id as string;
    const config = join(store.dir, 'config.json');
    writeFileSync(config, JSON.stringify({ store: 'sqlite', storeUrl: store.base, patientId: pid }));
    const what = typeof upload === 'string' ? upload : JSON.stringify(await writeEhiExport(exp, upload));
    const r = await peakRss(['node', join(import.meta.dirname, 'import-memory-host.ts'), typeof upload === 'string' ? upload : exp, 'America/New_York'], { GA_CONFIG: config });
    const job = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}');
    console.log(`import job ${what}: ${JSON.stringify(job)}`);
    return { ...r, job };
  } finally { rmSync(exp, { recursive: true, force: true }); await store.close(); }
}

async function within(upload: number | string) {
  const { exitCode, stderr, job } = await run(upload);
  expect(exitCode, stderr.slice(-500)).toBe(0);
  expect(job, stderr.slice(-500)).toMatchObject({ status: 'done', invalid: 0 });
  if (process.platform === 'linux') expect(job.peakAnon - job.idleAnon).toBeLessThanOrEqual(IMPORT_WORKER_RSS_MB);
}

test('a synthetic EHI export imports as a job within the import worker\'s memory', () => within(20), 600_000);

// The largest C-CDA fixture. A single C-CDA document is converted whole: about 4 MB is the most that fits (the spike note).
test('the largest C-CDA fixture imports as a job within the import worker\'s memory', () => within(join(import.meta.dirname, 'fixtures', 'ccda-epic-style.xml')), 600_000);

// About 100 MB and 500 MB of tables and notes (writeEhiExport's default note and message sizes).
test.skipIf(!process.env.GA_BIG_IMPORT).each([900, 4500])('a real-sized synthetic EHI export (factor %i) imports within the import worker\'s memory', within, 12 * 3_600_000);
