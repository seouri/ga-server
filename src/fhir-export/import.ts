import type { MedplumClient } from '@medplum/core';
import type { BatchOpts } from '../batches.ts';
import { GaError, type GaConfig } from '../config.ts';
import type { ImportReport } from '../engine.ts';

export type FhirExportReport = ImportReport & { skippedTypes: Record<string, number>; attachmentsUnplaced: number };

// Stub: filled in by the fhir-export task.
export async function importFhirExport(client: MedplumClient, cfg: GaConfig, path: string, patientId: string, opts: { fhirBase: string } & BatchOpts): Promise<FhirExportReport> {
  void client, cfg, path, patientId, opts;
  throw new GaError('fhir-export import not implemented yet');
}
