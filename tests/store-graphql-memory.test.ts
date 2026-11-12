// $graphql on GA's store stays inside ga-store's memory budget: src/store-serve.ts as compose runs it (--max-old-space-size=192,
// GA's types) answers one search (any request builds the schema, introspection or not); its total RSS after that request (after a
// full GC: the steady state, not start-up garbage) is at most 220 MiB.
// The budget is Linux's (ga-store's container, node:26 alpine; docs/superpowers/spikes/2026-11-11-store-graphql-memory.md), as
// tests/ehi-memory.test.ts: elsewhere (macOS keeps freed pages in RSS) the figures are printed only.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const STORE_SERVE = new URL('../src/store-serve.ts', import.meta.url).pathname;
const BUDGET_MIB = 220;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const HOOK = `data:text/javascript,process.on('SIGUSR2',()=>{globalThis.gc();const m=process.memoryUsage();console.log('mem '+m.rss+' '+m.heapUsed)})`;
// The child's RSS and V8 heap after a full GC (SIGUSR2 to the hook above), in MiB: steady state, without start-up garbage.
async function memory(c: ChildProcess, out: () => string): Promise<{ rss: number; heap: number }> {
  const n = out().split('mem ').length;
  c.kill('SIGUSR2');
  for (let t0 = Date.now(); out().split('mem ').length === n; await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t0 > 10_000) throw new Error(`no memory line: ${out()}`);
  const [rss, heap] = out().split('mem ').at(-1)!.split('\n')[0].split(' ').map((x) => Math.round(Number(x) / 2 ** 20));
  return { rss, heap };
}

test('$graphql on GA\'s store keeps ga-store within 220 MiB of RSS (Linux)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-graphql-mem-'));
  const port = await freePort();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ storeUrl: `http://127.0.0.1:${port}` }));
  const start = () => {
    const c = spawn(process.execPath, ['--max-old-space-size=192', '--expose-gc', '--import', HOOK, STORE_SERVE], { env: { ...process.env, GA_CONFIG: join(dir, 'config.json'), GA_STORE_HOST: '127.0.0.1' } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    return { c, out: () => out };
  };
  const healthy = async ({ c, out }: ReturnType<typeof start>) => {
    const t0 = Date.now();
    while ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.status !== 200) {
      if (Date.now() - t0 > 120_000 || c.exitCode !== null) throw new Error(`ga-store did not start: ${out()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const s = start(), c = s.c;
  try {
    await healthy(s);
    const before = await memory(c, s.out);
    const r = await fetch(`http://127.0.0.1:${port}/fhir/R4/$graphql`, {
      method: 'POST', headers: { authorization: `Bearer ${readFileSync(join(dir, 'store', 'token'), 'utf8').trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ PatientList(_count: 1) { id } }' }),
    });
    expect(await r.json()).toEqual({ data: { PatientList: [] } });
    const after = await memory(c, s.out);
    console.log(`$graphql schema (GA's types): RSS ${before.rss} -> ${after.rss} MiB, heap ${before.heap} -> ${after.heap} MiB, ${process.platform}`);
    if (process.platform === 'linux') expect(after.rss).toBeLessThanOrEqual(BUDGET_MIB);
  } finally {
    c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
