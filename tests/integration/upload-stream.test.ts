// Streamed Binary upload on Medplum (ga-test project): a 50 MB file stores byte for byte.
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MedplumClient } from '@medplum/core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { storeDocument } from '../../src/document.ts';
import { writeRandomFile } from '../random-file.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let pid: string;
let dir: string;
beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
  dir = mkdtempSync(join(tmpdir(), 'ga-upload-'));
});
afterAll(async () => { await cleanupTestPatient(client, pid); rmSync(dir, { recursive: true, force: true }); });

test('a 50 MB file streams to Medplum and reads back identical', async () => {
  const file = join(dir, 'big.bin');
  await writeRandomFile(file, Number(process.env.GA_UPLOAD_MIB ?? 50)) // 300 MB also passed on Medplum (GA_UPLOAD_MIB=300); no limit hit;
  const { docRef, fileHash } = await storeDocument(client, file, pid, 'application/octet-stream');
  const bin = await client.download(docRef.content[0].attachment.url!) // Medplum answers a signed storage URL;
  const h = createHash('sha256');
  const buf = Buffer.from(await bin.arrayBuffer());
  h.update(buf);
  expect(h.digest('hex')).toBe(fileHash);
  const want = createHash('sha256');
  await pipeline(createReadStream(file), want);
  expect(want.digest('hex')).toBe(fileHash);
}, 300_000);
