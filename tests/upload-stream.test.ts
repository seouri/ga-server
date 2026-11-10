// A 300 MB file uploads in a child with a 64 MB heap (a whole-file read would not fit); the stored bytes match.
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { expect, test } from 'vitest';
import { storeDocument } from '../src/document.ts';
import { peakRss } from './memory.ts';
import { writeRandomFile } from './random-file.ts';
import { onStore, tempStore } from './temp-store.ts';

const script = join(import.meta.dirname, 'upload-stream-child.ts');
const sha = async (s: NodeJS.ReadableStream) => { const h = createHash('sha256'); await pipeline(s, h); return h.digest('hex'); };

test('uploadBinaryFile streams a 300 MB file without its size in memory', async () => {
  const store = await tempStore();
  const dir = mkdtempSync(join(tmpdir(), 'ga-upload-'));
  try {
    const file = join(dir, 'big.bin');
    await writeRandomFile(file, 300);
    const r = await peakRss([process.execPath, '--max-old-space-size=64', script, file], { GA_STORE_URL: store.base, GA_STORE_TOKEN: store.token });
    expect(r.exitCode, r.stderr.slice(0, 500)).toBe(0);
    expect(r.peakMiB).toBeLessThan(200); // ArrayBuffers live off the heap, so the cap alone would not catch a whole read
    const { id, sha256 } = JSON.parse(r.stdout);
    const res = await fetch(`${store.base}fhir/R4/Binary/${id}`, { headers: { authorization: `Bearer ${store.token}`, accept: '*/*' } });
    expect(await sha(res.body as unknown as NodeJS.ReadableStream)).toBe(sha256);
    expect(sha256).toBe(await sha(createReadStream(file)));
  } finally { rmSync(dir, { recursive: true, force: true }); await store.close(); }
}, 300_000);

test('storeDocument of the same file twice creates one Binary and one DocumentReference', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const dir = mkdtempSync(join(tmpdir(), 'ga-upload-'));
    try {
      const file = join(dir, 'a.txt');
      writeFileSync(file, 'synthetic');
      const a = await storeDocument(client, file, pid, 'text/plain');
      const b = await storeDocument(client, file, pid, 'text/plain');
      expect([a.created, b.created]).toEqual([true, false]);
      expect(a.docRef.id).toBe(b.docRef.id);
      expect((await client.search('DocumentReference', {})).entry).toHaveLength(1);
      expect(a.docRef.content[0].attachment.url).toBe(b.docRef.content[0].attachment.url); // the second call uploaded nothing
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
