import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.ts';

describe('Store binaries', () => {
  let dir: string, store: Store;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-bin-')); store = new Store(join(dir, 'store.db'), { terminology: [] }); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const put = (contentType: string, data: Uint8Array) => store.putBinaryStream(contentType, [data]);

  it('put then get returns the same bytes and content type; file 0600 in a 0700 dir', async () => {
    const data = randomBytes(1000);
    const { id } = await put('application/pdf', data);
    const got = store.openBinary(id)!;
    expect(got.contentType).toBe('application/pdf');
    expect(Buffer.from(await new Response(got.stream()).arrayBuffer()).equals(data)).toBe(true);
    expect(statSync(join(dir, 'binary', id)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'binary')).mode & 0o777).toBe(0o700);
  });

  it('unknown id is undefined', () => {
    expect(store.openBinary('nope')).toBeUndefined();
  });

  it('a 20 MB payload streams in and out with the same hash', async () => {
    const hash = createHash('sha256');
    async function* chunks() { for (let i = 0; i < 20; i++) { const c = randomBytes(1 << 20); hash.update(c); yield c; } }
    const { id } = await store.putBinaryStream('application/octet-stream', chunks());
    const b = store.openBinary(id)!;
    expect(b.size).toBe(20 << 20);
    const back = createHash('sha256');
    for await (const c of b.stream()) back.update(c);
    expect(back.digest('hex')).toBe(hash.digest('hex'));
    expect(readdirSync(join(dir, 'binary'))).toEqual([id]); // no temp file left
  });

  it('a failed stream leaves no file and no row', async () => {
    async function* bad() { yield new Uint8Array(10); throw new Error('boom'); }
    await expect(store.putBinaryStream('x/y', bad())).rejects.toThrow('boom');
    expect(readdirSync(join(dir, 'binary'))).toEqual([]);
    expect(store.db.prepare('select count(*) n from binaries').get()).toEqual({ n: 0 });
  });

  it('an insert failure leaves no file and no row', async () => {
    await put('a/b', new Uint8Array(1)); // creates the dir
    const before = readdirSync(join(dir, 'binary')).sort();
    store.db.exec('alter table binaries rename to binaries_x');
    await expect(store.putBinaryStream('a/b', (async function* () { yield new Uint8Array(5); })())).rejects.toThrow();
    expect(readdirSync(join(dir, 'binary')).sort()).toEqual(before);
    expect(store.db.prepare('select count(*) n from binaries_x').get()).toEqual({ n: 1 });
  });

  it('path-like ids are unknown; stale temp files are swept at construction', async () => {
    await put('a/b', new Uint8Array(1));
    writeFileSync(join(dir, 'binary', '.abc.tmp'), 'x');
    expect(store.openBinary('../x')).toBeUndefined();
    expect(store.openBinary('.abc.tmp')).toBeUndefined();
    store.close();
    store = new Store(join(dir, 'store.db'), { terminology: [] });
    expect(readdirSync(join(dir, 'binary')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
