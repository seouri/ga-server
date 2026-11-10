import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MedplumClient } from '@medplum/core';
import { defaultConfigPath, GaError } from './config.ts';
import { storeDocument } from './document.ts';

// R1: the archive's identity is the folder's manifest (sorted relative paths, sizes, sha256s), not the tarball, whose
// bytes change with every tar run (timestamps), so a re-import finds it and skips tar and upload.
export async function manifestHash(dir: string): Promise<string> {
  const lines: string[] = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true }).filter((x) => x.isFile())) {
    const p = join(e.parentPath, e.name);
    const h = createHash('sha256');
    await pipeline(createReadStream(p), h); // streamed: an export can hold large media files
    lines.push(`${relative(dir, p).split(sep).join('/')}\t${statSync(p).size}\t${h.digest('hex')}`);
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

// shortcut: the tar.gz is uploaded as one Binary (a ~155 MB real Apple Health archive uploaded fine); upgrade to chunks if exports reach GBs.
export async function archiveFolder(client: MedplumClient, dir: string, patientId: string, system: string): Promise<'stored' | 'already-present'> {
  const id = { system, value: await manifestHash(dir) };
  const query = { identifier: `${id.system}|${id.value}`, subject: `Patient/${patientId}` };
  if (await client.searchOne('DocumentReference', query, { cache: 'no-cache' })) return 'already-present';
  // The tarball holds the whole export: a user-owned dir next to GA's config, not the shared system temp dir.
  const parent = join(dirname(defaultConfigPath()), 'tmp');
  // Named by the manifest and emptied first: a kill or restart skips the finally, and a retry must not add a second tarball.
  const tmp = join(parent, `archive-${id.value}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    const file = join(tmp, `${basename(dir)}.tar.gz`);
    // shortcut: system tar (macOS/Linux); switch to a library only if Windows support is needed.
    // COPYFILE_DISABLE: macOS tar would otherwise add ._ metadata entries that aren't in the folder.
    // Output ignored and only the exit code reported: tar messages name files of the export.
    try {
      execFileSync('tar', ['-czf', file, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'ignore' });
    } catch (e) {
      throw new GaError(`archive failed: tar exit ${(e as { status?: number }).status ?? 'unknown'}`);
    }
    await storeDocument(client, file, patientId, 'application/gzip', [id]);
    return 'stored';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
