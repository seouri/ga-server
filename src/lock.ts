// File locks: per-source portal sync (src/smart/sync.ts) and the one import lock every importResources caller takes.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { defaultConfigPath, GaError } from './config.ts';

const LOCK_STALE_MS = 2 * 3_600_000;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Exclusive file lock (O_EXCL); returns its path, or undefined after waitMs. Shared .ga/ with the ga-sync and ga-gateway
// containers: a pid is only checked on the host that wrote it; elsewhere only the 2 h age frees the lock.
export async function takeLock(f: string, waitMs: number): Promise<string | undefined> {
  for (const end = Date.now() + waitMs; ; ) {
    try {
      const fd = openSync(f, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, thread: threadId, host: hostname(), started: Date.now() }));
      closeSync(fd);
      return f;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let held: { pid?: number; host?: string; started?: number } = {};
    let started = Date.now();
    try {
      started = statSync(f).mtimeMs;
      held = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      // vanished or mid-write: held, aged by its mtime
    }
    const stale =
      (held.host === hostname() && typeof held.pid === 'number' && !alive(held.pid)) ||
      // our own pid but written before we started: a restarted container that reused the pid (SIGTERM skips finally)
      (held.host === hostname() && held.pid === process.pid && (held.started ?? started) < Date.now() - process.uptime() * 1000) ||
      Date.now() - (held.started ?? started) > LOCK_STALE_MS;
    if (stale) rmSync(f, { force: true });
    else if (Date.now() >= end) return undefined;
    else await new Promise((r) => setTimeout(r, 250));
  }
}

// One import or sync writes at a time, so two never both create the same record (an EHI import and the daily sync).
// shortcut: another host's lock is freed after 2 h, which a very large Apple Health import can outlast; upgrade to a heartbeat if seen.
// A worker thread that died (out of memory, terminated) skips its finally and leaves a lock with this live pid: free it.
export function freeThreadLock(thread: number, dir = dirname(defaultConfigPath())): void {
  const f = join(dir, 'import.lock');
  try {
    const held = JSON.parse(readFileSync(f, 'utf8')) as { pid?: number; thread?: number; host?: string };
    if (held.host === hostname() && held.pid === process.pid && held.thread === thread) rmSync(f, { force: true });
  } catch {} // no lock, or mid-write by its holder: not ours
}

export const IMPORT_WAIT_MS = 10 * 60_000;
export const IMPORT_BUSY = 'another import or sync is running: try again later';
export async function withImportLock<T>(fn: () => Promise<T>, opts: { dir?: string; waitMs?: number } = {}): Promise<T> {
  const dir = opts.dir ?? dirname(defaultConfigPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await takeLock(join(dir, 'import.lock'), opts.waitMs ?? IMPORT_WAIT_MS);
  if (!lock) throw new GaError(IMPORT_BUSY);
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
