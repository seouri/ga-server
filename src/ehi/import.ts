import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import type { GaConfig } from '../config.ts';
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
export function manifestHash(dir: string): string {
  const lines = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = join(e.parentPath, e.name);
      const data = readFileSync(p);
      return `${relative(dir, p).split(sep).join('/')}\t${data.length}\t${createHash('sha256').update(data).digest('hex')}`;
    })
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function archive(client: MedplumClient, dir: string, patientId: string): Promise<void> {
  const id = { system: ARCHIVE, value: manifestHash(dir) };
  const query = { identifier: `${id.system}|${id.value}`, subject: `Patient/${patientId}` };
  if (await client.searchOne('DocumentReference', query, { cache: 'no-cache' })) return;
  const tmp = mkdtempSync(join(tmpdir(), 'ga-ehi-'));
  try {
    const file = join(tmp, `${basename(dir)}.tar.gz`);
    // shortcut: system tar (macOS/Linux); switch to a library only if Windows support is needed.
    // COPYFILE_DISABLE: macOS tar would otherwise add ._ metadata entries that aren't in the folder.
    execFileSync('tar', ['-czf', file, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const { docRef } = await storeDocument(client, file, patientId, 'application/gzip');
    await client.updateResource({ ...docRef, identifier: [...(docRef.identifier ?? []), id] });
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
): Promise<ImportReport & { skippedTables: number; archived: boolean; skips: Awaited<ReturnType<typeof prepareEhi>>['skips'] & { tables: EhiTables['skipped'] } }> {
  const ctx = await ehiContext(client, dir, patientId, timeZone);
  const t = new EhiTables(dir);
  const { resources, skips } = await prepareEhi(client, t, ctx, patientId);
  const report = await importResources(client, resources, { kind: 'ehi', file: dir, date: ctx.date, writer: 'importer' }, patientId, '');
  const docs = await importDocuments(client, dir, t, ctx, patientId);
  for (const k of Object.keys(report) as (keyof ImportReport)[]) report[k] += docs[k];
  await archive(client, dir, patientId);
  return { ...report, skippedTables: t.skipped.length, archived: true, skips: { ...skips, tables: t.skipped } };
}
