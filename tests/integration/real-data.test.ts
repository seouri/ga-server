import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationOutcomeError } from '@medplum/core';
import type { OperationOutcomeIssue, Resource, ResourceType } from '@medplum/fhirtypes';
import { expect, test, vi } from 'vitest';
import { ccdaFiles, convertCcdaLocal, importPath } from '../../src/ccda.ts';
import { getClient, loadConfig } from '../../src/config.ts';
import { mapMessages, mapNotes } from '../../src/ehi/documents.ts';
import { ehiContext, importEhi, prepareEhi } from '../../src/ehi/import.ts';
import { EhiTables, isEhiExport } from '../../src/ehi/read.ts';
import { importAppleHealth } from '../../src/apple/import.ts';
import { collapsePatients } from '../../src/patient.ts';
import { createTestPatient } from './helpers.ts';

// Imports the owner's REAL files (into the run's ga-test project, never the live one). Prints counts only: never values, names,
// dates or resource bodies.
const root = process.env.GA_REAL_DATA;

// Server/converter messages can echo field values; keep only issue codes and element paths.
const safe = (e: unknown): string =>
  JSON.stringify(
    (e as { outcome?: { issue?: { code?: string; expression?: string[] }[] } }).outcome?.issue?.map((i) => [i.code, i.expression]) ??
      (e as Error)?.constructor?.name,
  );

test.skipIf(!root)('real ccda imports twice without duplicates', async () => {
  // Glob, not a literal path: the export folder is named after the patient.
  const dirs = globSync('HealthSummary_*/IHE_XDM/*/', { cwd: root as string });
  expect(dirs).toHaveLength(1);
  const dir = join(root as string, dirs[0]);
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const files = ccdaFiles(dir);

  const docsPerId = new Map<string, number>();
  const types = new Set<string>();
  for (const f of files) {
    let rs: Resource[];
    try {
      rs = convertCcdaLocal(readFileSync(f, 'utf8')).resources;
    } catch (e) {
      throw new Error(`convert failed: ${safe(e)}`);
    }
    for (const k of new Set(rs.map((r) => `${r.resourceType}/${r.id}`))) docsPerId.set(k, (docsPerId.get(k) ?? 0) + 1);
    for (const r of rs) types.add(r.resourceType);
  }
  const repeated = [...docsPerId].filter(([, n]) => n > 1);
  const repeatedByType: Record<string, number> = {};
  for (const [k] of repeated) repeatedByType[k.split('/')[0]] = (repeatedByType[k.split('/')[0]] ?? 0) + 1;

  const count = async (type: string, q: Record<string, string>) =>
    (await client.search(type as ResourceType, { ...q, _summary: 'count' }, { cache: 'no-cache' })).total ?? -1;
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of [...types].sort()) if (t !== 'Patient') out[t] = await count(t, { _tag: 'urn:ga-server:tag|src-ccda' });
    out['DocumentReference(file)'] = await count('DocumentReference', { identifier: 'urn:ga-server:id:file|' });
    return out;
  };
  const run = () =>
    importPath(client, cfg, dir).catch((e) => {
      throw new Error(`import failed: ${safe(e)}`);
    });

  // Engine logs `invalid <Type>/<element path>` (no values); tally them per path.
  const invalidPaths = async (fn: () => Promise<unknown>) => {
    const tally: Record<string, number> = {};
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      for (const p of String(m).match(/^invalid (.*)$/)?.[1].split(' ') ?? []) tally[p] = (tally[p] ?? 0) + 1;
    });
    try {
      return [await fn(), tally] as const;
    } finally {
      spy.mockRestore();
    }
  };
  const tagged = async (code: string) => {
    const out: Record<string, number> = {};
    for (const t of [...types].sort()) {
      const n = await count(t, { _tag: `urn:ga-server:tag|${code}` });
      if (n) out[t] = n;
    }
    return out;
  };

  const before = await counts();
  const [first, invalid1] = await invalidPaths(run);
  const after1 = await counts();
  const createdByType = Object.fromEntries(Object.entries(after1).map(([t, n]) => [t, n - (before[t] ?? 0)]));
  const [second, invalid2] = await invalidPaths(run);
  const after2 = await counts();
  const possibleDuplicateByType = await tagged('possible-duplicate');
  const conflictByType = await tagged('source-conflict');
  const patients = (await client.searchResources('Patient', { _count: 1000 }, { cache: 'no-cache' })).filter(
    (p) => !p.meta?.tag?.some((t) => t.system === 'urn:ga-server:tag' && t.code === 'ga-test'),
  ).length;

  console.log(
    JSON.stringify({
      docs: files.length,
      convertedIds: docsPerId.size,
      repeatedIds: repeated.length,
      repeatedByType,
      first,
      second,
      createdByType,
      invalid1,
      invalid2,
      possibleDuplicateByType,
      conflictByType,
      after2,
      patients,
    }),
  );
  expect(second).toMatchObject({ created: 0, updated: 0, merged: 0, possibleDuplicates: 0 });
  expect(patients).toBe(1);
  expect(after2).toEqual(after1);
}, 3_600_000);

const L = (c: string) => c.split(',').map((x) => `http://loinc.org|${x}`).join(',');
const inputs: [string, string, Record<string, string>][] = [
  ['total cholesterol', 'Observation', { code: L('2093-3') }],
  ['HDL', 'Observation', { code: L('2085-9') }],
  ['LDL', 'Observation', { code: L('13457-7,18262-6') }],
  ['systolic BP', 'Observation', { code: L('8480-6') }],
  ['A1c', 'Observation', { code: L('4548-4') }],
  ['smoking', 'Observation', { code: L('72166-2') }],
  ['eGFR', 'Observation', { code: L('33914-3,62238-1,98979-8') }],
  ['BMI', 'Observation', { code: L('39156-5') }],
];

// Acceptance 10.4: presence/count only (never values), written to a gitignored file.
test.skipIf(!root)('milestone-1 input presence on the real patient', async () => {
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const pid = cfg.patientId;
  const table: Record<string, { present: boolean; count: number; allHaveSource: boolean }> = {};
  const add = (name: string, items: { meta?: { source?: string } }[]) => {
    table[name] = { present: items.length > 0, count: items.length, allHaveSource: items.every((i) => !!i.meta?.source) };
  };

  const p = await client.readResource('Patient', pid);
  table['age (birthDate)'] = { present: !!p.birthDate, count: p.birthDate ? 1 : 0, allHaveSource: !!p.meta?.source };
  table['sex (gender)'] = { present: !!p.gender, count: p.gender ? 1 : 0, allHaveSource: !!p.meta?.source };
  for (const [name, type, q] of inputs) {
    add(name, await client.searchResources(type as ResourceType, { ...q, patient: pid, _count: 1000 }, { cache: 'no-cache' }));
  }
  // BP-med status: active medication list (query must run; count may be 0).
  const meds = [
    ...(await client.searchResources('MedicationStatement', { patient: pid, status: 'active', _count: 1000 }, { cache: 'no-cache' })),
    ...(await client.searchResources('MedicationRequest', { patient: pid, status: 'active', _count: 1000 }, { cache: 'no-cache' })),
  ];
  add('BP-med status (active meds)', meds);

  writeFileSync(
    '.superpowers/sdd/2026-11-05-ga-server-milestone-1/task-7-presence.json',
    JSON.stringify(table, null, 1),
  );
  console.log(JSON.stringify(table));
  // Patient demographics are the GA Patient itself (no importer provenance), so only report them.
  expect(Object.entries(table).filter(([k, v]) => !k.startsWith('age') && !k.startsWith('sex') && v.present && !v.allHaveSource)).toEqual([]);
}, 600_000);

// Milestone 2a, Step 5: the Epic EHI export. Counts only (never values, names or dates), written to the gitignored workspace.
// Dry pass first (mappers + read-only link pre-passes + $validate, no writes); the import runs only with 0 invalid.
test.skipIf(!root)('real EHI export: dry pass valid, imports twice without duplicates, archived', async () => {
  const dirs = globSync('*/', { cwd: root as string }).map((d) => join(root as string, d)).filter(isEhiExport);
  expect(dirs).toHaveLength(1);
  const dir = dirs[0];
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const pid = cfg.patientId;
  const out: Record<string, unknown> = {};
  const save = () => writeFileSync('.superpowers/sdd/2026-11-06-ehi-import/task-5-real.json', JSON.stringify(out, null, 1));

  // Issues as type/path only: diagnostics can echo values.
  const issuesOf = async (r: Resource): Promise<OperationOutcomeIssue[]> => {
    try {
      return ((await client.validateResource(r)).issue ?? []).filter((i) => i.severity === 'error' || i.severity === 'fatal');
    } catch (e) {
      if (e instanceof OperationOutcomeError) return e.outcome.issue ?? [];
      throw e;
    }
  };
  expect((await issuesOf({ resourceType: 'Observation', code: { text: 'x' } } as Resource)).length).toBeGreaterThan(0); // $validate does reject
  const ctx = await ehiContext(client, dir, pid);
  const t = new EhiTables(dir);
  const prepared = await prepareEhi(client, t, ctx, pid);
  const dry = [...prepared.resources, ...Array.from(mapNotes(t, ctx, dir), (n) => n.doc), ...[...mapMessages(t, ctx)].flat()];
  const { resources: collapsed } = collapsePatients(dry, pid);
  const dryInvalid: Record<string, number> = {};
  const mapped: Record<string, number> = {};
  let linkedEncountersClassFromExisting = 0;
  for (const r of collapsed) {
    if (r.resourceType === 'Patient') continue;
    mapped[r.resourceType] = (mapped[r.resourceType] ?? 0) + 1;
    // resolveUnlinked leaves class off a linked Encounter: the engine fills it from the existing record (R11).
    const classless = r.resourceType === 'Encounter' && !r.class;
    if (classless) linkedEncountersClassFromExisting++;
    for (const i of await issuesOf({ ...r, id: undefined, ...(classless ? { class: { code: 'UNK' } } : {}) } as Resource)) {
      const k = `${r.resourceType}/${i.expression?.join(',') ?? i.code}`;
      dryInvalid[k] = (dryInvalid[k] ?? 0) + 1;
    }
  }
  const tables = ['PAT_ENC', 'PAT_ENC_DX', 'PROBLEM_LIST', 'ORDER_PROC', 'ORDER_RESULTS', 'ORDER_MED', 'IMMUNE', 'IMM_ADMIN', 'FAMILY_HX',
    'IP_FLWSHT_MEAS', 'IP_FLWSHT_REC', 'V_EHI_FLO_MEAS_VALUE', 'SOCIAL_HX', 'HM_HISTORICAL_STATUS', 'HM_HISTORY', 'V_EHI_HQA_QUEST_ANSWER',
    'HNO_INFO', 'MYC_MESG'];
  Object.assign(out, {
    epicOrgNumberFound: !!ctx.epicOrgNumber,
    sourceRows: Object.fromEntries(tables.map((x) => [x, [...t.rows(x)].length])),
    dry: { mapped, skips: prepared.skips, skippedTables: t.skipped, linkedEncountersClassFromExisting, invalid: dryInvalid },
  });
  save();
  expect(dryInvalid).toEqual({}); // STOP before any write

  const types = Object.keys(mapped).sort();
  const ehiSys = `urn:ga-server:id:ehi:${ctx.org}`;
  // Per type, records carrying this export's identifier; of those, also a C-CDA identifier (merged/linked), and flagged.
  const byType = async () => {
    const res: Record<string, { ehi: number; alsoCcda: number; possibleDuplicate: number; sourceConflict: number }> = {};
    for (const type of types) {
      const c = { ehi: 0, alsoCcda: 0, possibleDuplicate: 0, sourceConflict: 0 };
      const q = { identifier: `${ehiSys}|`, _count: '1000' };
      for await (const page of client.searchResourcePages(type as ResourceType, q, { cache: 'no-cache' })) {
        for (const r of page as (Resource & { identifier?: { system?: string }[] })[]) {
          c.ehi++;
          if ([r.identifier ?? []].flat().some((i) => i.system === 'urn:ga-server:id:ccda')) c.alsoCcda++;
          if (r.meta?.tag?.some((g) => g.code === 'possible-duplicate')) c.possibleDuplicate++;
          if (r.meta?.tag?.some((g) => g.code === 'source-conflict')) c.sourceConflict++;
        }
      }
      res[type] = c;
    }
    return res;
  };
  const flagTotals = async () => {
    const res: Record<string, number> = {};
    for (const code of ['possible-duplicate', 'source-conflict']) {
      res[code] = 0;
      for (const type of types) res[code] += (await client.search(type as ResourceType, { _tag: `urn:ga-server:tag|${code}`, _summary: 'count' }, { cache: 'no-cache' })).total ?? 0;
    }
    return res;
  };
  const run = () =>
    importEhi(client, cfg, dir).catch((e) => {
      throw new Error(`import failed: ${safe(e)}`);
    });

  out.flagsBefore = await flagTotals();
  const first = await run();
  out.first = first;
  save();
  expect(first.invalid).toBe(0); // STOP before a second write pass
  out.after1 = await byType();
  const second = await run();
  out.second = second;
  out.after2 = await byType();
  out.flagsAfter = await flagTotals();
  // R21: linked MedicationRequests keep the C-CDA's coded medication.
  const linkedMeds = (await client.searchResources('MedicationRequest', { subject: `Patient/${pid}`, identifier: `${ehiSys}|`, _count: '1000' }, { cache: 'no-cache' })).filter(
    (m) => m.identifier?.some((i) => i.system === 'urn:ga-server:id:ccda'),
  );
  out.linkedMedicationRequests = { total: linkedMeds.length, withMedicationReference: linkedMeds.filter((m) => m.medicationReference).length };
  out.patients = (await client.searchResources('Patient', { _count: 1000 }, { cache: 'no-cache' })).filter(
    (p) => !p.meta?.tag?.some((g) => g.system === 'urn:ga-server:tag' && g.code === 'ga-test'),
  ).length;

  // Archive: unpack and compare file count and total size with the folder.
  const files = (d: string) => {
    const fs = readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    return { files: fs.length, bytes: fs.reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0) };
  };
  const archives = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: 'urn:ga-server:id:ehi-archive|' }, { cache: 'no-cache' });
  const tmp = mkdtempSync(join(tmpdir(), 'ga-ehi-real-'));
  try {
    const blob = await client.download(archives[0]?.content[0].attachment.url as string);
    writeFileSync(join(tmp, 'a.tar.gz'), Buffer.from(await blob.arrayBuffer()));
    mkdirSync(join(tmp, 'x'));
    execFileSync('tar', ['-xzf', join(tmp, 'a.tar.gz'), '-C', join(tmp, 'x')]);
    out.archive = { documents: archives.length, unpacked: files(join(tmp, 'x')), folder: files(dir) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  save();
  console.log(JSON.stringify(out));
  expect(second).toMatchObject({ created: 0, updated: 0 });
  expect(out.patients).toBe(1);
  expect(out.after2).toEqual(out.after1);
  expect((out.archive as { unpacked: unknown }).unpacked).toEqual((out.archive as { folder: unknown }).folder);
}, 3_600_000);

// Milestone 2b, Task 7: Apple Health export on a TEST patient. Counts, timings and step totals only (never names).
const apple = process.env.GA_REAL_DATA_APPLE;
const APPLE_TAG = 'urn:ga-server:tag|src-apple-health';

test.skipIf(!apple)('real Apple Health export: test patient, imports twice, archived', async () => {
  const dir = apple as string;
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const pid = await createTestPatient(client);
  const types = ['Observation', 'DocumentReference', 'AllergyIntolerance', 'DiagnosticReport', 'Condition', 'Immunization', 'MedicationStatement', 'Procedure'] as const;
  const out: Record<string, unknown> = {};
  const run = () =>
    importAppleHealth(client, cfg, dir, pid).catch((e) => {
      throw new Error(`import failed: ${safe(e)}`);
    });
  let bodyOk = false, left = 0, binariesLeft = 0, binaryIds: string[] = [], cleanupError: string | undefined;
  try {
    const first = await run();
    out.first = first;
    writeFileSync('.superpowers/sdd/2026-11-05-apple-health-import/task-7-real.json', JSON.stringify(out, null, 1));
    const perType: Record<string, number> = {};
    for (const t of types) perType[t] = (await client.search(t, { patient: `Patient/${pid}`, _tag: APPLE_TAG, _summary: 'count' }, { cache: 'no-cache' })).total ?? 0;
    out.perType = perType;
    // Observations per code (text or LOINC) and daily steps (code text only: no source names).
    const perCode: Record<string, number> = {};
    const steps = new Map<string, number>();
    // Medplum caps offsets at 10000: walk _lastUpdated windows, halving until each holds <= 5000.
    const walk = async (lo: number, hi: number): Promise<void> => {
      const q = (x: Record<string, string>) => new URLSearchParams({ patient: `Patient/${pid}`, _tag: APPLE_TAG, ...x, _lastUpdated: `ge${new Date(lo).toISOString()}` }).toString() + `&_lastUpdated=lt${new Date(hi).toISOString()}`;
      const total = (await client.search('Observation', q({ _summary: 'count' }), { cache: 'no-cache' })).total ?? 0;
      if (total === 0) return;
      if (total > 5000 && hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        await walk(lo, mid);
        await walk(mid, hi);
        return;
      }
      for await (const page of client.searchResourcePages('Observation', q({ _count: '1000', _elements: 'code,valueQuantity,effectiveDateTime,effectivePeriod' }), { cache: 'no-cache' })) {
        for (const o of page) {
          const k = o.code?.text ?? o.code?.coding?.[0]?.display ?? o.code?.coding?.[0]?.code ?? '?';
          perCode[k] = (perCode[k] ?? 0) + 1;
          if (k === 'Steps, daily total (Apple Health)') steps.set((o.effectiveDateTime ?? o.effectivePeriod?.start ?? '').slice(0, 10), o.valueQuantity?.value ?? NaN);
        }
      }
    };
    await walk(0, Date.now() + 86400e3);
    out.perCode = perCode;
    out.lastSteps = [...steps].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 5);
    const second = await run();
    out.second = second;

    // Archive: Binary size and unpacked file count/bytes vs folder.
    const files = (d: string) => {
      const fs = readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
      return { files: fs.length, bytes: fs.reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0) };
    };
    const archives = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: 'urn:ga-server:id:apple-health-archive|' }, { cache: 'no-cache' });
    const tmp = mkdtempSync(join(tmpdir(), 'ga-apple-real-'));
    try {
      const blob = await client.download(archives[0]?.content[0].attachment.url as string);
      writeFileSync(join(tmp, 'a.tar.gz'), Buffer.from(await blob.arrayBuffer()));
      mkdirSync(join(tmp, 'x'));
      execFileSync('tar', ['-xzf', join(tmp, 'a.tar.gz'), '-C', join(tmp, 'x')]);
      out.archive = { documents: archives.length, binaryBytes: blob.size, unpacked: files(join(tmp, 'x')), folder: files(dir) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(JSON.stringify(out));
    writeFileSync('.superpowers/sdd/2026-11-05-apple-health-import/task-7-real.json', JSON.stringify(out, null, 1));
    expect((out.archive as { documents: number }).documents).toBe(1);
    expect(first.possibleDuplicates).toBe(0);
    expect(first.seconds).toBeLessThan(1800);
    expect(second).toMatchObject({ created: 0, updated: 0 });
    expect(second.seconds).toBeLessThan(180);
    const a = out.archive as { binaryBytes: number; unpacked: unknown; folder: unknown };
    expect(a.binaryBytes).toBeGreaterThan(100e6);
    expect(a.unpacked).toEqual(a.folder);
    bodyOk = true;
  } finally {
    // Cleanup errors are logged, not thrown, so they cannot mask a body failure; a clean body asserts cleanup below.
    try {
      // Binaries first (the DocumentReferences hold their urls), then the resources in pages ($everything is capped per call).
      const docs = await client.searchResources('DocumentReference', { patient: `Patient/${pid}`, _count: '1000' }, { cache: 'no-cache' });
      binaryIds = docs.flatMap((d) => d.content.map((c) => c.attachment.url?.match(/(?:Binary|storage)\/([0-9a-f-]{36})/)?.[1] ?? '')).filter(Boolean);
      for (const t of types) {
        for (;;) {
          const rs = await client.searchResources(t, { patient: `Patient/${pid}`, _count: '1000' }, { cache: 'no-cache' });
          if (!rs.length) break;
          for (const r of rs) await client.deleteResource(t, r.id as string);
        }
      }
      for (const b of binaryIds) await client.deleteResource('Binary', b);
      for (const t of types) left += (await client.search(t, { patient: `Patient/${pid}`, _summary: 'count' }, { cache: 'no-cache' })).total ?? 0;
      await client.deleteResource('Patient', pid);
      for (const b of binaryIds) if (await client.readResource('Binary', b).then(() => true, () => false)) binariesLeft++;
    } catch (e) {
      cleanupError = safe(e);
      console.error(`cleanup failed: ${cleanupError}`);
    }
    console.log(JSON.stringify({ remainingForTestPatient: left, binariesDeleted: binaryIds.length - binariesLeft, binariesLeft, cleanupError }));
  }
  if (bodyOk) {
    expect(cleanupError).toBeUndefined();
    expect(left).toBe(0);
    expect(binaryIds).toHaveLength(1);
    expect(binariesLeft).toBe(0);
  }
}, 3_600_000);
