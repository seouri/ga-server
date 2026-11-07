import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { IMPORT_BUSY, withImportLock } from '../src/lock.ts';

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
