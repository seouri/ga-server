// scripts/backup.sh on the SQLite store, run for real against temp dirs while another process keeps writing:
// the copy passes integrity_check, the live database and its binaries stay out of the .ga tarball.
import { GA_STORE_TYPES } from '../src/store-serve.ts';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Store } from '../src/store/store.ts';

const script = new URL('../scripts/backup.sh', import.meta.url).pathname;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ga-backup-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (env: Record<string, string>) => execFileSync('sh', [script], { env: { ...process.env, RUN_ONCE: '1', BACKUP_DIR: join(dir, 'backups'), GA_DIR: join(dir, 'ga'), ...env }, encoding: 'utf8' });

test('SQLite store: online snapshot during writes passes integrity_check; binaries and .ga archived', async () => {
  const ga = join(dir, 'ga');
  mkdirSync(join(ga, 'store', 'binary'), { recursive: true });
  mkdirSync(join(dir, 'backups'));
  writeFileSync(join(ga, 'config.json'), JSON.stringify({ patientId: 'p', store: 'sqlite' }, null, 2));
  // GA's real store written by its own process (node:sqlite is synchronous: a writer in this thread could never overlap VACUUM INTO):
  // Observations and Binaries in a loop, as ga-store would.
  const storeTs = new URL('../src/store/store.ts', import.meta.url).href;
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    const { Store } = await import(${JSON.stringify(storeTs)});
    const { GA_STORE_TYPES } = await import(${JSON.stringify(new URL('../src/store-serve.ts', import.meta.url).href)});
    const s = new Store(process.argv[1], { types: GA_STORE_TYPES }); s.db.exec('pragma busy_timeout=5000');
    process.stdout.write('go\\n');
    for (let i = 0; ; i++) {
      s.create({ resourceType: 'Observation', status: 'final', code: { text: 'x'.repeat(300) }, subject: { reference: 'Patient/p' } });
      if (i % 20 === 0) await s.putBinaryStream('text/plain', [Buffer.from('bytes ' + i)]);
    }`, join(ga, 'store', 'ga.db')]);
  await new Promise((ok, fail) => { writer.stdout.once('data', ok); writer.once('exit', (c) => fail(new Error(`writer exited ${c}`))); });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const out = run({});
    expect(out).toMatch(/backup ok/);
  } finally { writer.kill(); }
  const [name] = readdirSync(join(dir, 'backups'));
  const b = join(dir, 'backups', name);
  expect(readdirSync(b).sort()).toEqual(['dot-ga.tgz', 'ga-binary.tgz', 'ga.db']);
  const copy = new DatabaseSync(join(b, 'ga.db'), { readOnly: true });
  expect(copy.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' });
  const binIds = (copy.prepare('select id from binaries').all() as { id: string }[]).map((r) => r.id);
  copy.close();
  // restorable: GA's Store opens the copy (index format kept) and reads it
  const restored = new Store(join(b, 'ga.db'), { types: GA_STORE_TYPES });
  try { expect(restored.search('Observation', [['_count', '1']], 'http://x/').entry).toHaveLength(1); } finally { restored.close(); }
  // every Binary row in the copy has its file in the archive (files are tarred after the snapshot)
  const files = execFileSync('tar', ['tzf', join(b, 'ga-binary.tgz')], { encoding: 'utf8' });
  expect(binIds.length).toBeGreaterThan(0);
  for (const id of binIds) expect(files).toContain(id);
  const dotGa = execFileSync('tar', ['tzf', join(b, 'dot-ga.tgz')], { encoding: 'utf8' });
  expect(dotGa).toContain('config.json');
  expect(dotGa).not.toMatch(/ga\.db|binary/);
});

test('Medplum store: pg_dump, Medplum\'s files and .ga archived; a dry run\'s store (ga.db, Binary copies) left out', () => {
  const ga = join(dir, 'ga'), bin = join(dir, 'fake-bin'), files = join(dir, 'medplum-binary');
  for (const d of [join(ga, 'store', 'binary'), join(dir, 'backups'), bin, files]) mkdirSync(d, { recursive: true });
  writeFileSync(join(ga, 'config.json'), JSON.stringify({ patientId: 'p' }));
  writeFileSync(join(ga, 'store', 'ga.db'), 'x');
  writeFileSync(join(ga, 'store', 'binary', 'copy'), 'x');
  writeFileSync(join(files, 'stored'), 'x');
  writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\necho dump\n', { mode: 0o755 });
  expect(run({ BACKUP_STORE: 'medplum', PATH: `${bin}:${process.env.PATH}`, MEDPLUM_BINARY_DIR: files })).toMatch(/backup ok/);
  const [name] = readdirSync(join(dir, 'backups'));
  const b = join(dir, 'backups', name);
  expect(readdirSync(b).sort()).toEqual(['dot-ga.tgz', 'ga-binary.tgz', 'ga-postgres.dump']);
  expect(execFileSync('tar', ['tzf', join(b, 'ga-binary.tgz')], { encoding: 'utf8' })).toContain('stored');
  const dotGa = execFileSync('tar', ['tzf', join(b, 'dot-ga.tgz')], { encoding: 'utf8' });
  expect(dotGa).toContain('config.json');
  expect(dotGa).not.toMatch(/ga\.db|binary/);
});

test('SQLite store without ga.db yet: skips, writes nothing', () => {
  mkdirSync(join(dir, 'ga'));
  mkdirSync(join(dir, 'backups'));
  writeFileSync(join(dir, 'ga', 'config.json'), JSON.stringify({ store: 'sqlite' }, null, 2));
  expect(run({ BACKUP_STORE: 'sqlite' })).toMatch(/skip: no .*ga\.db yet/);
  expect(readdirSync(join(dir, 'backups'))).toEqual([]);
});

test('each service skips the other store: the pg_dump run does nothing on a SQLite install', () => {
  mkdirSync(join(dir, 'ga'));
  mkdirSync(join(dir, 'backups'));
  writeFileSync(join(dir, 'ga', 'config.json'), JSON.stringify({ store: 'sqlite' }, null, 2));
  expect(run({ BACKUP_STORE: 'medplum' })).toMatch(/skip/);
  expect(readdirSync(join(dir, 'backups'))).toEqual([]);
});
