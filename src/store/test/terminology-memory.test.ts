// The built-in terminology seed must fit ga-store's memory budget: serve.ts with every type, in a child process as it runs in
// production, seeds a fresh file; the child prints its own peak RSS (process.resourceUsage().maxRSS, KiB on Linux and macOS)
// on exit. A second start on the seeded file (no reseed) gives the floor without the seed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const SERVE = new URL('../serve.ts', import.meta.url).pathname;
const HOOK = `data:text/javascript,process.on('exit',()=>console.log('maxRSS '+process.resourceUsage().maxRSS))`;
const BUDGET_MIB = 220; // ga-store's share of the measured 512 MB configuration

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

// Starts serve.ts on `file`, waits for /healthz (the database is open, so the seed is done), stops it; peak RSS and time to healthy.
async function run(file: string): Promise<{ peakMiB: number; healthyMs: number }> {
  const port = await freePort(), t0 = Date.now();
  const c = spawn(process.execPath, ['--max-old-space-size=192', '--import', HOOK, SERVE, '--file', file, '--token-file', join(file, '..', 'token'), '--port', String(port)]);
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => c.on('close', r));
  let healthyMs = -1;
  while (Date.now() - t0 < 120_000 && c.exitCode === null) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.status === 200) { healthyMs = Date.now() - t0; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  c.kill('SIGTERM');
  const code = await exited;
  const kib = Number(/maxRSS (\d+)/.exec(out)?.[1]);
  if (healthyMs < 0 || code !== 0 || !kib) throw new Error(`serve.ts did not start and stop cleanly (exit ${code}): ${out}`);
  return { peakMiB: Math.round(kib / 1024), healthyMs };
}

test('seeding the built-in terminology stays under ga-store\'s memory budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-term-mem-'));
  try {
    const file = join(dir, 'store.db');
    const seeded = await run(file);
    const reopened = await run(file);
    console.log(`terminology seed: peak RSS ${seeded.peakMiB} MiB (reopen without seed ${reopened.peakMiB} MiB), healthy after ${seeded.healthyMs} ms`
      + ` (reopen ${reopened.healthyMs} ms), file ${(statSync(file).size / 2 ** 20).toFixed(1)} MiB, ${process.platform}`);
    expect(seeded.peakMiB).toBeLessThan(BUDGET_MIB);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);
