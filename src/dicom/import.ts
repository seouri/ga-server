import type { MedplumClient } from '@medplum/core';
import { GaError, type GaConfig } from '../config.ts';
import type { ImportReport } from '../engine.ts';

export type DicomReport = ImportReport & { studies: number; series: number; instances: number; documents: number; skipped: number; unsupported: number; archive: 'stored' | 'already-present' };

// Stub: filled in by the dicom task.
export async function importDicom(client: MedplumClient, cfg: GaConfig, dir: string, patientId: string): Promise<DicomReport> {
  void client, cfg, dir, patientId;
  throw new GaError('dicom import not implemented yet');
}
