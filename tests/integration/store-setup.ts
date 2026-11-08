// GA_STORE=sqlite: every integration file runs against its own temp SQLite store (a child `serveStore`, so tests that
// block on spawnSync can't deadlock it) with a temp config and self Patient. Never the live install's config or token.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach } from 'vitest';

if (process.env.GA_STORE === 'sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'ga-int-store-'));
  const cfgPath = join(dir, 'config.json');
  let child: ChildProcess;
  const serve = `const { serveStore } = await import(${JSON.stringify(new URL('../../src/store/server.ts', import.meta.url).href)});
    const { GA_STORE_TYPES } = await import(${JSON.stringify(new URL('../../src/store-serve.ts', import.meta.url).href)});
    const s = await serveStore({ file: process.argv[1], port: 0, tokenFile: process.argv[2], types: GA_STORE_TYPES }); console.log(s.address().port);
    process.stdin.on('end', () => process.exit(0)).resume();`; // exits with the test worker, even one that is killed
  beforeAll(async () => {
    child = spawn(process.execPath, ['--input-type=module', '-e', serve, join(dir, 'store', 'ga.db'), join(dir, 'store', 'token')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const port = await new Promise<number>((resolve, reject) => {
      child.once('exit', (c) => reject(new Error(`store exited (${c})`)));
      child.stdout!.once('data', (d) => resolve(Number(String(d).trim())));
    });
    child.unref();
    for (const s of [child.stdin, child.stdout] as unknown as { unref(): void }[]) s.unref();
    const storeUrl = `http://127.0.0.1:${port}/`;
    writeFileSync(cfgPath, JSON.stringify({ store: 'sqlite', storeUrl, converterUrl: process.env.GA_CONVERTER_URL || 'http://localhost:8104/' }), { mode: 0o600 });
    process.env.GA_CONFIG = process.env.GA_INT_STORE_CONFIG = cfgPath;
    process.env.GA_STORE_URL = storeUrl;
    const { setup } = await import('../../src/setup.ts');
    await setup(undefined, process.env.GA_CONVERTER_URL || 'http://localhost:8104/');
  }, 60_000);
  // Some files delete GA_CONFIG after a Medplum test project; on the store there is only this one.
  beforeEach(() => { process.env.GA_CONFIG = cfgPath; });
  afterAll(() => {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  });
}
