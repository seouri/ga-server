import { resolve } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { BatchOpts } from '../batches.ts';
import type { GaConfig } from '../config.ts';
import { storeDocument } from '../document.ts';
import { importResources, type ImportReport } from '../engine.ts';
import { withImportLock } from '../lock.ts';
import { mapForGa } from '../smart/fetch.ts';
import { sourceKey } from '../smart/auth.ts';
import { uploadBinaries } from '../smart/sync.ts';
import type { SourceRec } from '../smart/store.ts';
import { readFhirExport } from './read.ts';

export type FhirExportReport = ImportReport & { skippedTypes: Record<string, number>; attachmentsUnplaced: number };

// An Epic FHIR export file, identified exactly like a portal sync of `fhirBase` so a later `ga connect` + `ga sync` links to these records.
export async function importFhirExport(client: MedplumClient, cfg: GaConfig, path: string, patientId: string, opts: { fhirBase: string } & BatchOpts): Promise<FhirExportReport> {
  void cfg;
  const src: SourceRec = { key: sourceKey(opts.fhirBase), name: new URL(opts.fhirBase).hostname, fhirBase: opts.fhirBase };
  const read = readFhirExport(path);
  const { resources, binaries } = mapForGa(read.resources, src);
  const lastUpdated = (r: { meta?: { lastUpdated?: string } }) => r.meta?.lastUpdated;
  const report = await withImportLock(async () => {
    const { fileHash } = await storeDocument(client, path, patientId, 'application/json');
    await uploadBinaries(client, resources, binaries, src, patientId);
    return importResources(client, resources, { kind: 'fhir-export', file: resolve(path), date: read.date, writer: 'importer', dateOf: lastUpdated, fillOnly: (r) => !lastUpdated(r) }, patientId, fileHash);
  });
  return { ...report, skippedTypes: read.skippedTypes, attachmentsUnplaced: read.attachmentsUnplaced };
}
