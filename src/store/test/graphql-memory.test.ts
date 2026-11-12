// $graphql's memory on a store with every R4 type: the schema is built on the first request, so a child process serving a fresh
// file (no seeded terminology) answers one search, and its RSS before and after that request (each after a full GC) is compared.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const SERVER = new URL('../server.ts', import.meta.url).href;
const CHILD = `const { serveStore } = await import(process.argv[1]);
const s = await serveStore({ file: process.argv[2], tokenFile: process.argv[3], port: 0, terminology: [] });
console.log('port ' + s.address().port);`;
const GROWTH_MIB = 128;

const HOOK = `data:text/javascript,process.on('SIGUSR2',()=>{globalThis.gc();const m=process.memoryUsage();console.log('mem '+m.rss+' '+m.heapUsed)})`;
// The child's RSS and V8 heap after a full GC (SIGUSR2 to the hook above), in MiB: steady state, without start-up garbage.
async function memory(c: ChildProcess, out: () => string): Promise<{ rss: number; heap: number }> {
  const n = out().split('mem ').length;
  c.kill('SIGUSR2');
  for (let t0 = Date.now(); out().split('mem ').length === n; await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t0 > 10_000) throw new Error(`no memory line: ${out()}`);
  const [rss, heap] = out().split('mem ').at(-1)!.split('\n')[0].split(' ').map((x) => Math.round(Number(x) / 2 ** 20));
  return { rss, heap };
}

test('the first $graphql request on an all-types store adds at most 128 MiB of RSS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-graphql-mem-'));
  const c = spawn(process.execPath, ['--expose-gc', '--import', HOOK, '--input-type=module', '-e', CHILD, SERVER, join(dir, 'x.db'), join(dir, 'token')]);
  let out = '';
  try {
    c.stderr.on('data', (d) => (out += d));
    const port = await new Promise<number>((resolve, reject) => {
      c.stdout.on('data', (d) => { out += d; const m = /port (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      c.on('close', (code) => reject(new Error(`child exited ${code}: ${out}`)));
    });
    const before = await memory(c, () => out);
    const r = await fetch(`http://127.0.0.1:${port}/fhir/R4/$graphql`, {
      method: 'POST', headers: { authorization: `Bearer ${readFileSync(join(dir, 'token'), 'utf8').trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ PatientList(_count: 1) { id } }' }),
    });
    expect(await r.json()).toEqual({ data: { PatientList: [] } });
    const after = await memory(c, () => out);
    console.log(`$graphql schema (all types): RSS ${before.rss} -> ${after.rss} MiB (+${after.rss - before.rss}), heap ${before.heap} -> ${after.heap} MiB, ${process.platform}`);
    expect(after.rss - before.rss).toBeLessThanOrEqual(GROWTH_MIB);
  } finally {
    c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
