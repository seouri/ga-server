// The Apple Health import in batches gives today's single-batch result (spec: same result), on a temp SQLite store.
import { createHash } from 'node:crypto';
import { mkdtempSync, type ReadStream, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { appleBatches } from '../src/apple/batches.ts';
import { importAppleHealth } from '../src/apple/import.ts';
import type { GaConfig } from '../src/config.ts';
import { ARRIVED, sorted } from '../src/identity.ts';
import { withImportLock } from '../src/lock.ts';
import { writeAppleTestExport } from './fixtures-gen/apple.ts';
import { type TempStore, tempStore } from './temp-store.ts';

// Every file stream the importer opens, to check export.xml is closed after a failed import.
const streams = vi.hoisted(() => [] as { path: string; s: ReadStream }[]);
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const createReadStream = ((path: string, o?: never) => { const s = fs.createReadStream(path, o); streams.push({ path: String(path), s }); return s; }) as typeof fs.createReadStream;
  return { ...fs, default: { ...fs, createReadStream }, createReadStream };
});

// Days are cut in the machine's zone: pin it, so the pinned result below holds on every machine.
const oldTz = process.env.TZ;
process.env.TZ = 'America/New_York';
const oldConfig = process.env.GA_CONFIG;
let exp: string;
beforeAll(async () => {
  exp = mkdtempSync(join(tmpdir(), 'ga-apple-batches-'));
  await writeAppleTestExport(exp, 30, { twoSources: true });
});
afterAll(() => {
  rmSync(exp, { recursive: true, force: true });
  if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
});
const stores: TempStore[] = [];
afterEach(async () => {
  process.env.GA_CONFIG = oldConfig;
  for (const s of stores.splice(0)) await s.close();
});

// A temp store with a patient; GA_CONFIG points into it, so the import lock lives there.
async function store() {
  const s = await tempStore();
  stores.push(s);
  process.env.GA_CONFIG = join(s.dir, 'config.json');
  const pid = (await s.client.createResource({ resourceType: 'Patient' })).id as string;
  return { client: s.client, pid, cfg: { patientId: pid } as GaConfig };
}

// Everything the import wrote, without server ids, times and arrival stamps; a reference reads as its target's identifier.
async function snapshot(client: MedplumClient, pid: string): Promise<string[]> {
  const all: (Resource & { identifier?: { value?: string }[] })[] = [];
  for (const [type, param] of [['Observation', 'subject'], ['DocumentReference', 'subject'], ['AllergyIntolerance', 'patient']] as const) {
    for await (const page of client.searchResourcePages(type, { [param]: `Patient/${pid}`, _count: '1000' }, { cache: 'no-cache' })) all.push(...page);
  }
  const idOf = new Map(all.map((r) => [`${r.resourceType}/${r.id}`, r.identifier?.[0]?.value]));
  const rows = all.filter((r) => !(r.identifier as { system?: string }[] | undefined)?.some((i) => i.system === 'urn:ga-server:id:apple-health-archive')).map((r) => { // the archive: a new tarball each run
    const { id: _i, meta, extension, ...rest } = r as Resource & { extension?: { url: string }[]; derivedFrom?: { reference?: string }[] };
    const ext = extension?.filter((e) => e.url !== ARRIVED);
    const derived = (r as { derivedFrom?: { reference?: string }[] }).derivedFrom;
    return JSON.stringify({ ...rest, tag: meta?.tag, ...(ext?.length && { extension: ext }), ...(derived && { derivedFrom: derived.map((d) => idOf.get(d.reference ?? '')) }) }, sorted);
  });
  const p = await client.readResource('Patient', pid);
  // The patient id differs per store, and so does the content hash the engine appends to a shared identifier (it includes the id).
  return [...rows.map((x) => x.replaceAll(pid, 'PATIENT').replace(/\|[0-9a-f]{64}"/g, '|HASH"')).sort(), JSON.stringify(p.identifier ?? [], sorted)];
}
const report = ({ seconds: _s, ...r }: { seconds: number }) => r;

test("batched import writes the same resources as one batch, and as today's importer", async () => {
  const a = await store();
  const ra = await importAppleHealth(a.client, a.cfg, exp, a.pid, { batchSize: 7 });
  const b = await store();
  const rb = await importAppleHealth(b.client, b.cfg, exp, b.pid, { batchSize: 1_000_000 });
  expect(report(ra)).toEqual(report(rb));
  const snap = await snapshot(b.client, b.pid);
  expect(await snapshot(a.client, a.pid)).toEqual(snap);
  // Today's importer (3f5f829, before batching) on this export: its report, skips, and a digest of what it stored.
  expect(report(rb)).toEqual({
    created: 613, updated: 0, skipped: 1, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0,
    unmapped: [{ source: 'apple-health', type: 'Observation', key: 'walking heart rate average|/min', name: 'Walking heart rate average', unit: '/min', count: 30 }],
    archived: 'stored', unchanged: 0,
    skips: {
      nested: 3, archiveOnly: { ActiveEnergyBurned: 15000 }, sameReadingTwoSources: 1, bpUnpaired: 0, unexpectedUnit: 0,
      activityEmptyDays: 1, badValue: 0, clinicalVersionUnsupported: 1, clinicalUnreadable: 0, ecgUnparsed: 0,
    },
  });
  expect(snap).toHaveLength(614);
  expect(createHash('sha256').update(JSON.stringify(snap)).digest('hex')).toBe('fa3b64e854169183155c02a1f35c43f9e73743ea78658827783c4acad36d88a6');
}, 300_000);

test('shuffled records give the same resources as sorted ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-apple-shuffled-'));
  try {
    await writeAppleTestExport(dir, 10);
    const sortedDir = mkdtempSync(join(tmpdir(), 'ga-apple-sorted-'));
    await writeAppleTestExport(sortedDir, 10);
    // Top-level elements (with their children) in a seeded random order; the header stays.
    const xml = readFileSync(join(dir, 'export.xml'), 'utf8');
    const start = xml.indexOf('\n', xml.indexOf('<Me ')) + 1, end = xml.indexOf('</HealthData>');
    const units: string[] = [];
    let depth = 0;
    for (const line of xml.slice(start, end).split('\n').filter(Boolean)) {
      if (depth === 0) units.push('');
      units[units.length - 1] += `${line}\n`;
      if (/^\s*<\//.test(line)) depth--; else if (!/\/>\s*$/.test(line)) depth++;
    }
    expect(depth).toBe(0);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = units.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [units[i], units[j]] = [units[j], units[i]]; }
    writeFileSync(join(dir, 'export.xml'), xml.slice(0, start) + units.join('') + xml.slice(end));
    const a = await store();
    const ra = await importAppleHealth(a.client, a.cfg, dir, a.pid, { batchSize: 11 });
    const b = await store();
    const rb = await importAppleHealth(b.client, b.cfg, sortedDir, b.pid, { batchSize: 11 });
    rmSync(sortedDir, { recursive: true, force: true });
    expect(report(ra)).toEqual(report(rb));
    expect(await snapshot(a.client, a.pid)).toEqual(await snapshot(b.client, b.pid));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);

test('re-import of the same export writes nothing; a newer export updates only its changed day', async () => {
  const a = await store();
  const first = await importAppleHealth(a.client, a.cfg, exp, a.pid, { batchSize: 50 });
  const again = await importAppleHealth(a.client, a.cfg, exp, a.pid, { batchSize: 50 });
  expect(again).toMatchObject({ created: 0, updated: 0, archived: 'already-present' });
  expect(again.unchanged).toBe(first.created - 1); // the allergy always goes to the engine, which skips it
  const dir = mkdtempSync(join(tmpdir(), 'ga-apple-newer-'));
  try {
    await writeAppleTestExport(dir, 30, { twoSources: true });
    const xml = readFileSync(join(dir, 'export.xml'), 'utf8');
    const hr = '<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Synthetic Watch" unit="count/min" startDate="2016-01-30 12:00:30 -0500" endDate="2016-01-30 12:00:30 -0500" value="190"/>\n';
    writeFileSync(join(dir, 'export.xml'), xml.replace('</HealthData>', `${hr}</HealthData>`).replace('<ExportDate value="2016-01-31', '<ExportDate value="2016-02-01'));
    const newer = await importAppleHealth(a.client, a.cfg, dir, a.pid, { batchSize: 50 });
    expect(newer).toMatchObject({ created: 0, updated: 2 }); // that day's heart-rate mean, and the allergy (a clinical copy takes the export date) under the newer date
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);

test('skipThrough 2 writes only batches 3 onward and onBatch sees each committed index', async () => {
  const all: number[] = [];
  for await (const b of appleBatches(exp, { size: 50, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })) all.push(b.index);
  const a = await store();
  const seen: number[] = [];
  const r = await importAppleHealth(a.client, a.cfg, exp, a.pid, { batchSize: 50, skipThrough: 2, onBatch: async (i) => { seen.push(i); } });
  expect(seen).toEqual(all.slice(3));
  const full = await store();
  const whole = await importAppleHealth(full.client, full.cfg, exp, full.pid, { batchSize: 50 });
  expect(r.created).toBe(whole.created - 150);
}, 300_000);

test("an import interleaved with another writer's lock between batches keeps both results", async () => {
  const a = await store();
  const subject = { reference: `Patient/${a.pid}` };
  const r = await importAppleHealth(a.client, a.cfg, exp, a.pid, {
    batchSize: 200,
    onBatch: async (i) => {
      await withImportLock(() => a.client.createResource({ resourceType: 'Observation', status: 'final', code: { text: `other writer ${i}` }, subject }), { waitMs: 0 });
    },
  });
  const others = await a.client.searchResources('Observation', { subject: `Patient/${a.pid}`, 'code:text': 'other writer' }, { cache: 'no-cache' });
  expect(others.length).toBeGreaterThan(2);
  expect(r.created).toBeGreaterThan(500);
}, 300_000);

test('a truncated export.xml fails with its error and no partial batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-apple-cut-'));
  try {
    await writeAppleTestExport(dir, 3);
    const xml = readFileSync(join(dir, 'export.xml'), 'utf8');
    // Day 0 has 14 readings (1,570 records); cut inside a startDate on day 1: batches 0 and 1 (5 each) are written,
    // the 4 readings of the batch the cut interrupts are not.
    let at = 0;
    for (let i = 0; i < 1600; i++) at = xml.indexOf('<Record ', at + 1);
    writeFileSync(join(dir, 'export.xml'), xml.slice(0, xml.indexOf('startDate="', at) + 15));
    const a = await store();
    const seen: number[] = [];
    await expect(importAppleHealth(a.client, a.cfg, dir, a.pid, { batchSize: 5, onBatch: async (i) => { seen.push(i); } })).rejects.toThrow(/date/);
    expect(seen).toEqual([0, 1]);
    expect(await a.client.searchResources('Observation', { subject: `Patient/${a.pid}` }, { cache: 'no-cache' })).toHaveLength(10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 300_000);

test('a failed batch closes export.xml', async () => {
  const a = await store();
  streams.length = 0;
  await expect(importAppleHealth(a.client, a.cfg, exp, a.pid, { batchSize: 50, onBatch: async () => { throw new Error('write failed'); } })).rejects.toThrow('write failed');
  const xml = streams.filter((x) => x.path.endsWith('export.xml'));
  expect(xml.length).toBeGreaterThan(0);
  expect(xml.every((x) => x.s.destroyed)).toBe(true);
}, 300_000);
