import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { pipeline } from 'node:stream/promises';
import { GaError, type GaConfig } from '../config.ts';
import { storeDocument } from '../document.ts';
import { importResources, type ImportReport } from '../engine.ts';
import { mapConditions } from './conditions.ts';
import { importDocuments } from './documents.ts';
import { mapEncounters } from './encounters.ts';
import { linkImmunizationsToExisting, mapFamilyHistory, mapHealthMaintenance, mapImmunizations, mapQuestionnaires, mapSocial, mapVitals } from './history.ts';
import { type EhiCtx, epicOrgNumber, PATIENT_REF, resolveUnlinked } from './ids.ts';
import { linkResultsToExisting, mapLabs } from './labs.ts';
import { mapMeds } from './meds.ts';
import { EhiTables, exportInfo } from './read.ts';

const ARCHIVE = 'urn:ga-server:id:ehi-archive';

export async function ehiContext(client: MedplumClient, dir: string, patientId: string, timeZone?: string): Promise<EhiCtx> {
  return { ...exportInfo(dir, timeZone), epicOrgNumber: await epicOrgNumber(client, patientId) };
}

// Every mapper into one batch, then the read-only pre-passes. No writes: the real-data dry pass uses it as is.
export async function prepareEhi(client: MedplumClient, t: EhiTables, ctx: EhiCtx, patientId: string) {
  const labs = { skippedNoName: 0 };
  const imm = { skippedNoName: 0, immAdminSameDose: 0, immAdminPossibleDuplicate: 0 };
  const family = { skippedNoRelative: 0 };
  const vitals = { skippedEmpty: 0 };
  const hm = { skippedNoDate: 0 };
  const quest = { skippedEmpty: 0 };
  const batch: Resource[] = [
    { resourceType: 'Patient', id: PATIENT_REF.reference.split('/')[1] }, // no PATIENT mapper: collapses onto the GA patient
    ...mapEncounters(t, ctx), ...mapConditions(t, ctx), ...mapLabs(t, ctx, labs), ...mapMeds(t, ctx), ...mapImmunizations(t, ctx, imm),
    ...mapFamilyHistory(t, ctx, family), ...mapVitals(t, ctx, vitals), ...mapSocial(t, ctx), ...mapHealthMaintenance(t, ctx, hm),
    ...mapQuestionnaires(t, ctx, quest),
  ];
  const results = await linkResultsToExisting(client, batch, patientId);
  const imms = await linkImmunizationsToExisting(client, results.resources, patientId);
  const { resources, skippedNoName } = await resolveUnlinked(client, imms.resources, patientId);
  // Counts only, each with its reason. Unidentified/unmatched records are still created (separately), not dropped.
  const skips = {
    conditionNoName: skippedNoName,
    labResultNoName: labs.skippedNoName,
    labResultsLinked: results.identified,
    labResultsUnidentified: results.unidentified,
    immunizationNoName: imm.skippedNoName,
    immAdminSameDose: imm.immAdminSameDose,
    immAdminPossibleDuplicate: imm.immAdminPossibleDuplicate,
    immunizationsEpicLinked: imms.epicLinked,
    immAdminMatched: imms.matched,
    immAdminUnmatched: imms.unmatched,
    familyNoRelative: family.skippedNoRelative,
    vitalsEmpty: vitals.skippedEmpty,
    healthMaintenanceNoDate: hm.skippedNoDate,
    questionnairesEmpty: quest.skippedEmpty,
  };
  return { resources, skips };
}

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

// shortcut: the tar.gz is uploaded as one Binary (10 MB for the real export); upgrade to chunks if exports reach GBs.
async function archive(client: MedplumClient, dir: string, patientId: string): Promise<'stored' | 'already-present'> {
  const id = { system: ARCHIVE, value: await manifestHash(dir) };
  const query = { identifier: `${id.system}|${id.value}`, subject: `Patient/${patientId}` };
  if (await client.searchOne('DocumentReference', query, { cache: 'no-cache' })) return 'already-present';
  const tmp = mkdtempSync(join(tmpdir(), 'ga-ehi-'));
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

export async function importEhi(
  client: MedplumClient,
  cfg: GaConfig,
  dir: string,
  patientId = cfg.patientId,
  timeZone?: string,
): Promise<
  ImportReport & {
    skippedTables: number;
    archived: 'stored' | 'already-present';
    skips: Awaited<ReturnType<typeof prepareEhi>>['skips'] & { mediaUnknownType: number; rtfNoNote: number; tables: EhiTables['skipped'] };
  }
> {
  const ctx = await ehiContext(client, dir, patientId, timeZone);
  const t = new EhiTables(dir);
  const { resources, skips } = await prepareEhi(client, t, ctx, patientId);
  const report = await importResources(client, resources, { kind: 'ehi', file: dir, date: ctx.date, writer: 'importer' }, patientId, '');
  const files = { mediaUnknownType: 0, rtfNoNote: 0 };
  const docs = await importDocuments(client, dir, t, ctx, patientId, files);
  for (const k of Object.keys(report) as (keyof ImportReport)[]) report[k] += docs[k];
  const archived = await archive(client, dir, patientId);
  return { ...report, skippedTables: t.skipped.length, archived, skips: { ...skips, ...files, tables: t.skipped } };
}
