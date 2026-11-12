import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { UploadTooLarge, acceptUpload, cleanUploads, newUpload, unzipSafe, uploadPath } from '../src/gateway/uploads.ts';
import { listJobs, recordJob } from '../src/import-jobs.ts';

const PUBLIC = 'https://ga.example.ts.net';
const ZIPS = join(import.meta.dirname, 'fixtures', 'zips');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ga-up-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const body = (s: string) => Readable.from([Buffer.from(s)]);

test('a token works once and the file lands under uploads/<fileId>/', async () => {
  const u = newUpload(dir, PUBLIC);
  expect(u.url).toBe(`${PUBLIC}/upload/${u.token}`);
  const { fileId } = await acceptUpload(dir, u.token, '../lab report.pdf', body('%PDF-1.4 synthetic'));
  expect(fileId).toBe(u.fileId);
  const p = uploadPath(dir, fileId);
  expect(p).toBe(join(dir, 'uploads', fileId, 'lab_report.pdf'));
  expect(readFileSync(p, 'utf8')).toBe('%PDF-1.4 synthetic');
  await expect(acceptUpload(dir, u.token, 'x.pdf', body('again'))).rejects.toThrow('upload link');
  expect(readdirSync(join(dir, 'uploads'))).toEqual([fileId]);
});

test('a file still streaming is not visible to an import', async () => {
  const u = newUpload(dir, PUBLIC);
  const s = new PassThrough();
  const done = acceptUpload(dir, u.token, 'r.pdf', s);
  s.write('%PDF-1.4 ');
  await new Promise((ok) => setTimeout(ok, 20));
  expect(existsSync(join(dir, 'uploads', u.fileId))).toBe(true);
  expect(() => uploadPath(dir, u.fileId)).toThrow('unknown fileId');
  s.end('synthetic');
  await done;
  expect(readFileSync(uploadPath(dir, u.fileId), 'utf8')).toBe('%PDF-1.4 synthetic');
  expect(readdirSync(join(dir, 'uploads', u.fileId))).toEqual(['r.pdf']);
});

test('a token is refused after 15 minutes', async () => {
  const t0 = Date.now();
  const u = newUpload(dir, PUBLIC, t0);
  await expect(acceptUpload(dir, u.token, 'x.pdf', body('x'), t0 + 15 * 60_000 + 1)).rejects.toThrow('upload link');
  expect(existsSync(join(dir, 'uploads', u.fileId))).toBe(false);
});

test('over the cap: UploadTooLarge and the partial file is removed', async () => {
  const u = newUpload(dir, PUBLIC);
  await expect(acceptUpload(dir, u.token, 'big.pdf', Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), Date.now(), 10)).rejects.toBeInstanceOf(UploadTooLarge);
  expect(existsSync(join(dir, 'uploads', u.fileId))).toBe(false);
});

test('uploadPath refuses unknown and malformed ids', () => {
  expect(() => uploadPath(dir, 'A'.repeat(22))).toThrow('unknown fileId');
  expect(() => uploadPath(dir, '../../etc')).toThrow('unknown fileId');
});

test('uploads older than 24 hours are swept', async () => {
  const old = newUpload(dir, PUBLIC);
  const fresh = newUpload(dir, PUBLIC);
  await acceptUpload(dir, old.token, 'a.pdf', body('a'));
  await acceptUpload(dir, fresh.token, 'b.pdf', body('b'));
  const t = new Date(Date.now() - 25 * 3600_000);
  utimesSync(join(dir, 'uploads', old.fileId), t, t);
  cleanUploads(dir);
  expect(readdirSync(join(dir, 'uploads'))).toEqual([fresh.fileId]);
});

// Audit 15: a job queued or resumed after the gateway was down over 24 hours still has its export (recordJob moved it out of uploads/).
test('the upload sweep never removes a recorded import job\'s export', async () => {
  const u = newUpload(dir, PUBLIC);
  await acceptUpload(dir, u.token, 'export.zip', body('PK synthetic'));
  const job = recordJob(dir, uploadPath(dir, u.fileId));
  cleanUploads(dir, Date.now() + 48 * 3600_000);
  expect(readFileSync(job.upload, 'utf8')).toBe('PK synthetic');
  expect(job.upload.startsWith(join(dir, 'imports', job.id))).toBe(true);
});

// recordJob moves the upload before writing job.json: a record never points at an export that is not in its folder.
test('recordJob of an upload that cannot be moved leaves no job record', () => {
  expect(() => recordJob(dir, join(dir, 'uploads', 'missing.zip'))).toThrow();
  expect(listJobs(dir)).toEqual([]);
});

test('unzipSafe: a normal zip with one top folder returns that folder', async () => {
  const into = join(dir, 'out');
  const root = await unzipSafe(join(ZIPS, 'ok.zip'), into);
  expect(root).toBe(join(into, 'export'));
  expect(readFileSync(join(root, 'sub', 'b.txt'), 'utf8')).toBe('synthetic b\n');
});

test('unzipSafe rejects traversal, absolute paths, symlinks and over-limit archives, writing nothing outside into', async () => {
  const box = join(dir, 'box');
  mkdirSync(box);
  const into = join(box, 'out');
  for (const z of ['traversal.zip', 'absolute.zip', 'symlink.zip']) {
    await expect(unzipSafe(join(ZIPS, z), into), z).rejects.toThrow();
    expect(existsSync(into), z).toBe(false);
  }
  await expect(unzipSafe(join(ZIPS, 'ok.zip'), into, { entries: 1, bytes: 1e6 })).rejects.toThrow('too many');
  await expect(unzipSafe(join(ZIPS, 'ok.zip'), into, { entries: 10, bytes: 13 })).rejects.toThrow('too large');
  expect(readdirSync(box)).toEqual([]);
  expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
  expect(existsSync('/abs.txt')).toBe(false);
});

test('unzipSafe counts inflated bytes, not only declared sizes', async () => {
  // liar.zip declares 10 bytes for an entry that inflates to 100,000.
  const into = join(dir, 'out');
  await expect(unzipSafe(join(ZIPS, 'liar.zip'), into, { entries: 10, bytes: 1000 })).rejects.toThrow();
  expect(existsSync(into)).toBe(false);
  writeFileSync(join(dir, 'not.zip'), 'not a zip');
  await expect(unzipSafe(join(dir, 'not.zip'), into)).rejects.toThrow();
  expect(existsSync(into)).toBe(false);
});
