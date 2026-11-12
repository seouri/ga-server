import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, expect, test } from 'vitest';
import { IMPORT_BUSY, freeThreadLock, withImportLock } from '../src/lock.ts';

const dir = mkdtempSync(join(tmpdir(), 'ga-lock-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('imports and syncs hold the import lock one at a time; a holder past the wait makes the next one busy', async () => {
  let inside = 0, max = 0;
  const work = () => withImportLock(async () => {
    max = Math.max(max, ++inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
  }, { dir, waitMs: 5_000 });
  await Promise.all([work(), work(), work()]);
  expect(max).toBe(1);
  let release = () => {};
  const held = withImportLock(() => new Promise<void>((r) => { release = r; }), { dir });
  await expect(withImportLock(async () => 1, { dir, waitMs: 0 })).rejects.toThrow(IMPORT_BUSY);
  release();
  await held;
  expect(await withImportLock(async () => 2, { dir, waitMs: 0 })).toBe(2);
});

test('a worker thread that dies holding the import lock: freeThreadLock frees it, and only that thread\'s lock', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ga-lock-thread-'));
  try {
    const code = `(async () => { const { withImportLock } = await import(${JSON.stringify(new URL('../src/lock.ts', import.meta.url).href)}); await withImportLock(() => process.exit(3), { dir: ${JSON.stringify(d)} }); })()`;
    const w = new Worker(code, { eval: true, execArgv: [] });
    const thread = w.threadId;
    expect(await new Promise((ok) => w.on('exit', ok))).toBe(3);
    expect(existsSync(join(d, 'import.lock'))).toBe(true); // its finally never ran
    freeThreadLock(thread + 1, d);
    expect(existsSync(join(d, 'import.lock'))).toBe(true);
    freeThreadLock(thread, d);
    expect(existsSync(join(d, 'import.lock'))).toBe(false);
    await withImportLock(async () => freeThreadLock(thread, d), { dir: d, waitMs: 0 }); // this thread's own lock stays held
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a recreated container (same hostname, same pid) frees the lock its previous instance left, never one written since it started', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ga-lock-prev-'));
  try {
    const f = join(d, 'import.lock');
    const old = { pid: process.pid, thread: 0, host: hostname(), started: Date.now() - process.uptime() * 1000 - 60_000 };
    writeFileSync(f, JSON.stringify(old));
    expect(await withImportLock(async () => 'got it', { dir: d, waitMs: 0 })).toBe('got it');
    writeFileSync(f, JSON.stringify({ ...old, started: Date.now() })); // this process's own (a worker's): held
    await expect(withImportLock(async () => 'no', { dir: d, waitMs: 0 })).rejects.toThrow(IMPORT_BUSY);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Ctrl-C (or a stop) during `ga import`: the lock goes with the process, which still ends by that signal; a process with its
// own handler first (the gateway's exitOnStop) keeps its own shutdown.
test('SIGINT or SIGTERM while holding the import lock releases it', async () => {
  const lock = JSON.stringify(new URL('../src/lock.ts', import.meta.url).href);
  const run = async (sig: NodeJS.Signals, ownHandler = false) => {
    const d = mkdtempSync(join(tmpdir(), 'ga-lock-sig-'));
    const own = `process.once('${sig}', () => { writeFileSync(${JSON.stringify(join(d, 'marker'))}, ''); process.exit(0); });`;
    const code = `import { writeFileSync } from 'node:fs'; ${ownHandler ? own : ''}
      const { withImportLock } = await import(${lock});
      await withImportLock(() => { console.log('held'); return new Promise(() => setInterval(() => {}, 1000)); }, { dir: ${JSON.stringify(d)} });`;
    try {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((ok) => c.stdout.once('data', ok));
      expect(existsSync(join(d, 'import.lock'))).toBe(true);
      c.kill(sig);
      const [exit, signal] = await new Promise<[number | null, string | null]>((ok) => c.on('exit', (a, b) => ok([a, b])));
      return { exit, signal, left: existsSync(join(d, 'import.lock')), marker: existsSync(join(d, 'marker')) };
    } finally { rmSync(d, { recursive: true, force: true }); }
  };
  expect(await run('SIGINT')).toEqual({ exit: null, signal: 'SIGINT', left: false, marker: false });
  expect(await run('SIGTERM')).toEqual({ exit: null, signal: 'SIGTERM', left: false, marker: false });
  expect(await run('SIGTERM', true)).toEqual({ exit: 0, signal: null, left: false, marker: true });
});
