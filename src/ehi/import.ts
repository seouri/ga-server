import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { archiveFolder } from '../archive.ts';
import type { GaConfig } from '../config.ts';
import { addReport, importResources, type ImportReport } from '../engine.ts';
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
  const family = { skippedNoRelative: 0, skippedNoCondition: 0 };
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
    familyNoCondition: family.skippedNoCondition,
    vitalsEmpty: vitals.skippedEmpty,
    healthMaintenanceNoDate: hm.skippedNoDate,
    questionnairesEmpty: quest.skippedEmpty,
  };
  return { resources, skips };
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
  // First, so the original is kept even if a later step fails (idempotent: found by its manifest on a re-run).
  const archived = await archiveFolder(client, dir, patientId, ARCHIVE);
  const t = new EhiTables(dir);
  const { resources, skips } = await prepareEhi(client, t, ctx, patientId);
  const report = await importResources(client, resources, { kind: 'ehi', file: dir, date: ctx.date, writer: 'importer' }, patientId, '');
  const files = { mediaUnknownType: 0, rtfNoNote: 0 };
  const docs = await importDocuments(client, dir, t, ctx, patientId, files);
  addReport(report, docs);
  return { ...report, skippedTables: t.skipped.length, archived, skips: { ...skips, ...files, tables: t.skipped } };
}
