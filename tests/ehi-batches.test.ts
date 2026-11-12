// The Epic EHI import in batches gives today's single-batch result (spec: same result), on a temp SQLite store.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { importPath } from '../src/ccda.ts';
import type { GaConfig } from '../src/config.ts';
import { importEhi } from '../src/ehi/import.ts';
import { writeEhiExport } from './fixtures-gen/ehi.ts';
import { snapshot } from './import-jobs-helpers.ts';
import { type TempStore, tempStore } from './temp-store.ts';

const CCDA = join(import.meta.dirname, 'fixtures', 'ccda-synthetic.xml'); // shares order 9000001 (Epic org 99) with the EHI fixture
const TZ = 'America/New_York';
const oldConfig = process.env.GA_CONFIG;
let exp: string;
beforeAll(async () => {
  exp = mkdtempSync(join(tmpdir(), 'ga-ehi-batches-'));
  await writeEhiExport(exp, 12, { noteKB: 3, plainKB: 2, messageKB: 2 });
});
afterAll(() => rmSync(exp, { recursive: true, force: true }));
const stores: TempStore[] = [];
afterEach(async () => {
  process.env.GA_CONFIG = oldConfig;
  for (const s of stores.splice(0)) await s.close();
});

// A temp store with a patient and the C-CDA the EHI links to; GA_CONFIG points into it, so the import lock lives there.
async function store() {
  const s = await tempStore();
  stores.push(s);
  process.env.GA_CONFIG = join(s.dir, 'config.json');
  const pid = (await s.client.createResource({ resourceType: 'Patient' })).id as string;
  const cfg = { patientId: pid } as GaConfig;
  await importPath(s.client, cfg, CCDA, pid);
  return { client: s.client, pid, cfg };
}

// Today's importer (80207ab, one batch) on this export after the C-CDA: its report and a digest of the patient's records.
const UNMAPPED = [
  { source: 'ehi:synthetic-health', type: 'Condition', key: 'Condition|test problem', name: 'Test problem', count: 24 },
  { source: 'ehi:synthetic-health', type: 'Condition', key: 'Condition|test resolved problem', name: 'Test resolved problem', count: 12 },
  { source: 'ehi:synthetic-health', type: 'Observation', key: 'hdl|mg/dl', name: 'HDL', unit: 'mg/dL', count: 12 },
  { source: 'ehi:synthetic-health', type: 'MedicationRequest', key: 'MedicationRequest|TESTDRUG 10 MG TABLET', name: 'TESTDRUG 10 MG TABLET', count: 12 },
  { source: 'ehi:synthetic-health', type: 'Immunization', key: 'Immunization|test vaccine', name: 'TEST VACCINE', count: 12 },
  { source: 'ehi:synthetic-health', type: 'Immunization', key: 'Immunization|old vaccine', name: 'OLD VACCINE', count: 12 },
  { source: 'ehi:synthetic-health', type: 'Immunization', key: 'Immunization|outside vaccine', name: 'Outside Vaccine', count: 12 },
  { source: 'ehi:synthetic-health', type: 'Procedure', key: 'Procedure|health maintenance completion immunization', name: 'Health maintenance completion: Immunization', count: 12 },
];
const SKIPS = {
  conditionNoName: 12, labResultNoName: 0, labResultsLinked: 1, labResultsUnidentified: 1, immunizationNoName: 0, immAdminSameDose: 0,
  immAdminPossibleDuplicate: 0, immunizationsEpicLinked: 0, immAdminMatched: 0, immAdminUnmatched: 12, familyNoRelative: 0, familyNoCondition: 0,
  vitalsEmpty: 0, healthMaintenanceNoDate: 12, questionnairesEmpty: 12, mediaUnknownType: 0, rtfNoNote: 0, tables: [],
};
const TODAY = { created: 374, updated: 1, skipped: 23, merged: 1, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: UNMAPPED, skippedTables: 0, archived: 'stored', skips: SKIPS };
const digest = (snap: string[]) => createHash('sha256').update(JSON.stringify(snap)).digest('hex');

test("batched import writes the same records as one batch, and as today's importer", async () => {
  const a = await store();
  const batches: number[] = [];
  const ra = await importEhi(a.client, a.cfg, exp, a.pid, TZ, { batchSize: 7, onBatch: (i) => void batches.push(i) });
  expect(batches.length).toBeGreaterThan(40);
  expect(batches).toEqual(batches.map((_, i) => i));
  const b = await store();
  const rb = await importEhi(b.client, b.cfg, exp, b.pid, TZ, { batchSize: 1_000_000 });
  expect(ra).toEqual(rb);
  expect(rb).toEqual(TODAY);
  const snap = await snapshot(b.client, b.pid);
  expect(await snapshot(a.client, a.pid)).toEqual(snap);
  expect(snap).toHaveLength(383);
  expect(digest(snap)).toBe('084792404dd7e0077133790836f46e6af33b927e9ec3e3536817790088c875fc');
}, 300_000);

test('re-import of the same export writes nothing and reports as today', async () => {
  const a = await store();
  await importEhi(a.client, a.cfg, exp, a.pid, TZ, { batchSize: 7 });
  const snap = await snapshot(a.client, a.pid);
  const again = await importEhi(a.client, a.cfg, exp, a.pid, TZ, { batchSize: 7 });
  // Today's second run: every record skipped; the linking passes now find the first run's records.
  expect(again).toEqual({
    ...TODAY, created: 0, updated: 0, skipped: 399, merged: 0, archived: 'already-present',
    skips: { ...SKIPS, labResultsLinked: 24, labResultsUnidentified: 0, immunizationsEpicLinked: 24 },
  });
  expect(await snapshot(a.client, a.pid)).toEqual(snap);
}, 300_000);

// Audit 17: a batch's linking passes read the store under the import lock, so a sync cannot write the same lab between the
// read and the write (an extra possible duplicate).
test("each batch's linking passes run under the import lock", async () => {
  const a = await store();
  const lock = join(dirname(process.env.GA_CONFIG!), 'import.lock');
  const LINKING = /linkResultsToExisting|linkImmunizationsToExisting|resolveUnlinked|resolveRefs/;
  const seen: boolean[] = [];
  const real = a.client.searchResources.bind(a.client);
  a.client.searchResources = ((...args: Parameters<typeof real>) => {
    const stack = new Error().stack ?? '';
    if (LINKING.test(stack) && !/learnAll/.test(stack)) seen.push(existsSync(lock)); // learnAll only reads, before any batch
    return real(...args);
  }) as typeof real;
  await importEhi(a.client, a.cfg, exp, a.pid, TZ, { batchSize: 50 });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(Boolean)).toBe(true);
}, 300_000);
