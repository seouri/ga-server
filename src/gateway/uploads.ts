// Uploads from chat apps: one-time upload links (15 minutes, single use) and the stored files under <gateway dir>/uploads/<fileId>/<name>,
// kept 24 hours. unzipSafe extracts an uploaded export zip, which is untrusted input.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { GaError } from '../config.ts';
import { safeName } from '../share/server.ts';
import { readJson, writeJson } from './store.ts';

export const MAX_UPLOAD = 2 * 1024 ** 3;
const LINK_MS = 15 * 60_000;
const KEEP_MS = 24 * 3600_000;
const ID = /^[A-Za-z0-9_-]{22}$/;
type Links = Record<string, { exp: number; fileId: string }>;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const uploadsDir = (dir: string): string => join(dir, 'uploads');
const links = (dir: string): Links => readJson<Links>(dir, 'uploads.json', {});

export class UploadTooLarge extends Error {
  constructor() {
    super('the file is over the 2 GB limit');
  }
}

export const newFileId = (): string => randomBytes(16).toString('base64url');

// Only the token's hash is stored. The fileId is fixed now, so the chat app knows it before the user uploads.
export function newUpload(dir: string, publicUrl: string, now = Date.now()): { token: string; url: string; expiresAt: string; fileId: string } {
  const token = randomBytes(32).toString('base64url');
  const fileId = newFileId();
  const live = links(dir); // shortcut: read-modify-write, safe within the one gateway process (sync, no await in between)
  for (const h of Object.keys(live)) if (live[h].exp <= now) delete live[h];
  live[hash(token)] = { exp: now + LINK_MS, fileId };
  writeJson(dir, 'uploads.json', live);
  return { token, url: `${publicUrl}/upload/${token}`, expiresAt: new Date(now + LINK_MS).toISOString(), fileId };
}

// Non-consuming, so a link-preview bot opening the URL does not burn the link.
export const uploadLinkValid = (dir: string, token: string, now = Date.now()): boolean => (links(dir)[hash(token)]?.exp ?? 0) > now;

function takeLink(dir: string, token: string, now: number): string | undefined {
  const live = links(dir);
  const l = live[hash(token)];
  if (!l) return undefined;
  delete live[hash(token)];
  writeJson(dir, 'uploads.json', live);
  return l.exp > now ? l.fileId : undefined;
}

// Streams body to uploads/<fileId>/.part, renamed to <safe name> once complete (safeName never starts with a dot), so an import
// never sees a half-written file; over max bytes or on failure the partial upload is removed.
export async function storeUpload(dir: string, fileId: string, fileName: string, body: Readable, max = MAX_UPLOAD): Promise<void> {
  const d = join(uploadsDir(dir), fileId);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  let n = 0;
  const cap = new Transform({
    transform(c: Buffer, _e, cb) {
      n += c.length;
      cb(n > max ? new UploadTooLarge() : null, c);
    },
  });
  try {
    await pipeline(body, cap, createWriteStream(join(d, '.part'), { flags: 'wx', mode: 0o600 }));
    renameSync(join(d, '.part'), join(d, safeName(fileName, 'upload')));
  } catch (e) {
    rmSync(d, { recursive: true, force: true });
    throw e;
  }
}

// The link is consumed before anything is stored.
export async function acceptUpload(dir: string, token: string, fileName: string, body: Readable, now = Date.now(), max = MAX_UPLOAD): Promise<{ fileId: string }> {
  const fileId = takeLink(dir, token, now);
  if (!fileId) throw new GaError('upload link not valid: ask for a new one');
  await storeUpload(dir, fileId, fileName, body, max);
  return { fileId };
}

// fileId comes from the chat app: checked against GA's own format before it touches a path.
export function uploadPath(dir: string, fileId: string): string {
  const d = join(uploadsDir(dir), fileId);
  const f = ID.test(fileId) && existsSync(d) ? readdirSync(d, { withFileTypes: true }).find((e) => e.isFile() && !e.name.startsWith('.')) : undefined;
  if (!f) throw new GaError('unknown fileId: upload the file with upload_link first (uploads are kept 24 hours)');
  return join(d, f.name);
}

export function cleanUploads(dir: string, now = Date.now()): void {
  const root = uploadsDir(dir);
  if (!existsSync(root)) return;
  for (const e of readdirSync(root)) {
    const p = join(root, e);
    if (statSync(p).mtimeMs < now - KEEP_MS) rmSync(p, { recursive: true, force: true });
  }
}

const S_IFMT = 0o170000;
const reject = (why: string): GaError => new GaError(`zip rejected: ${why}`);

// Extracts zip into `into` (created, removed again on any rejection). Returns the single top folder if there is one, else `into`.
export async function unzipSafe(zip: string, into: string, limits = { entries: 200_000, bytes: 8 * 1024 ** 3 }): Promise<string> {
  const base = resolve(into);
  const tops = new Set<string>();
  let z: yauzl.ZipFile | undefined;
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    // yauzl itself refuses absolute paths, ".." and backslashes (decodeStrings) and entries whose data differs from their declared size (validateEntrySizes),
    // so the declared total below bounds the bytes written.
    z = await yauzl.openPromise(zip, { lazyEntries: true });
    if (z.entryCount > limits.entries) throw reject(`too many entries (over ${limits.entries})`);
    let declared = 0;
    const zf = z;
    await new Promise<void>((ok, fail) => {
      const entry = async (e: yauzl.Entry): Promise<void> => {
        const name = e.fileName;
        if (name.startsWith('__MACOSX/')) return; // Finder's resource forks
        const type = (e.externalFileAttributes >>> 16) & S_IFMT;
        if (type === 0o120000) throw reject('symbolic link');
        if (type && type !== 0o100000 && type !== 0o040000) throw reject('not a regular file');
        const dest = resolve(base, name);
        if (!dest.startsWith(base + sep)) throw reject('entry outside the folder');
        tops.add(name.split('/')[0]);
        if (name.endsWith('/')) return void mkdirSync(dest, { recursive: true, mode: 0o700 });
        declared += e.uncompressedSize;
        if (declared > limits.bytes) throw reject('too large uncompressed');
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        await pipeline(await zf.openReadStreamPromise(e), createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
      };
      zf.on('error', fail);
      zf.on('end', ok);
      zf.on('entry', (e: yauzl.Entry) => entry(e).then(() => zf.readEntry(), fail));
      zf.readEntry();
    });
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e instanceof GaError ? e : reject(e instanceof Error ? e.message : String(e));
  } finally {
    z?.close();
  }
  const [top] = tops;
  return tops.size === 1 && statSync(join(base, top)).isDirectory() ? join(base, top) : base;
}
