import { resolve } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import type { BatchOpts } from '../batches.ts';
import type { GaConfig } from '../config.ts';
import { storeDocument } from '../document.ts';
import { COMPARTMENT, importResources, type ImportReport } from '../engine.ts';
import { DATED } from '../identity.ts';
import { withImportLock } from '../lock.ts';
import { mapForGa } from '../smart/fetch.ts';
import { sourceKey } from '../smart/auth.ts';
import { uploadBinaries } from '../smart/sync.ts';
import type { SourceRec } from '../smart/store.ts';
import { readFhirExport } from './read.ts';

const PATIENT: Resource = { resourceType: 'Patient', id: 'fhir-export-patient' }; // what Patient/fhir-export-patient means in a file with no Patient

// A record without its patient (the personalrecord tool drops subject) points at the file's own Patient, else at PATIENT added to the
// batch, so the engine links it to GA's patient instead of refusing it or storing it outside every compartment.
function withPatient(rs: Resource[]): Resource[] {
  const own = rs.find((r) => r.resourceType === 'Patient');
  const reference = `Patient/${(own ?? PATIENT).id}`;
  let used = false;
  for (const r of rs) {
    const field = COMPARTMENT[r.resourceType];
    const o = r as unknown as Record<string, { reference?: string } | undefined>;
    if (!field || o[field]?.reference) continue;
    o[field] = { ...o[field], reference };
    used = true;
  }
  return used && !own ? [PATIENT, ...rs] : rs;
}

export type FhirExportReport = ImportReport & { skippedTypes: Record<string, number>; attachmentsUnplaced: number };

// An Epic FHIR export file, identified exactly like a portal sync of `fhirBase` so a later `ga connect` + `ga sync` links to these records.
export async function importFhirExport(client: MedplumClient, cfg: GaConfig, path: string, patientId: string, opts: { fhirBase: string } & BatchOpts): Promise<FhirExportReport> {
  void cfg;
  const src: SourceRec = { key: sourceKey(opts.fhirBase), name: new URL(opts.fhirBase).hostname, fhirBase: opts.fhirBase };
  const read = readFhirExport(path);
  const mapped = mapForGa(read.resources, src); // after it: a reference to PATIENT, outside the file, would be dropped
  const resources = withPatient(mapped.resources);
  const binaries = mapped.binaries;
  const lastUpdated = (r: { meta?: { lastUpdated?: string } }) => r.meta?.lastUpdated;
  // A record without lastUpdated (reconstructed, fill-only) takes the file's newest lastUpdated as its source date; in a file with
  // none at all it gets no source date (never invented), so it can raise neither the stored nor the scanned newest Epic import.
  // Medications, problems and allergies are a whole-record list as of the file (one date per file, like C-CDA and EHI): their own
  // older lastUpdated would read "unconfirmed" against the file's newest record.
  const dateOf = (r: Resource) => (read.lastUpdated && DATED.has(r.resourceType) ? read.date : lastUpdated(r) ?? (read.lastUpdated ? read.date : ''));
  const report = await withImportLock(async () => {
    const { fileHash } = await storeDocument(client, path, patientId, 'application/json');
    await uploadBinaries(client, resources, binaries, src, patientId);
    return importResources(client, resources, { kind: 'fhir-export', file: resolve(path), date: read.date, writer: 'importer', dateOf, fillOnly: (r) => !lastUpdated(r) }, patientId, fileHash);
  });
  return { ...report, skippedTypes: read.skippedTypes, attachmentsUnplaced: read.attachmentsUnplaced };
}
