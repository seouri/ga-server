import type { MedplumClient } from '@medplum/core';
import { importAppleHealth } from './apple/import.ts';
import type { BatchOpts } from './batches.ts';
import { isAppleHealthExport } from './apple/read.ts';
import { importPath } from './ccda.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GaError, type GaConfig } from './config.ts';
import { importDicom } from './dicom/import.ts';
import { importEhi } from './ehi/import.ts';
import { isEhiExport } from './ehi/read.ts';
import { importFhirExport } from './fhir-export/import.ts';

export type ImportKind = 'pdf' | 'ehi' | 'apple' | 'ccda' | 'fhir-export' | 'dicom';

export const DOCUMENT_EXT = /\.(pdf|png|jpe?g|tiff?)$/i;

export function detectKind(path: string): ImportKind {
  if (DOCUMENT_EXT.test(path)) return 'pdf';
  if (isEhiExport(path)) return 'ehi';
  if (isAppleHealthExport(path)) return 'apple';
  if (/\.zip$/i.test(path)) throw new GaError('unzip export.zip first, then: ga import <folder>');
  if (existsSync(join(path, 'DICOMDIR'))) return 'dicom';
  if (/\.json$/i.test(path)) return 'fhir-export';
  return 'ccda';
}

// opts.tz: EHI export zone (already validated by the caller). The batch options resume an import (src/import-jobs.ts).
export async function importAny(client: MedplumClient, cfg: GaConfig, path: string, opts: { tz?: string; fhirBase?: string } & BatchOpts = {}): Promise<unknown> {
  const kind = detectKind(path);
  if (kind === 'pdf') throw new GaError(`PDFs are extracted by your agent: ask it to import ${path}, or pass --llm api`);
  if (kind === 'apple') return importAppleHealth(client, cfg, path, cfg.patientId, opts);
  if (kind === 'ehi') return importEhi(client, cfg, path, cfg.patientId, opts.tz, opts);
  if (kind === 'dicom') return importDicom(client, cfg, path, cfg.patientId);
  if (kind === 'fhir-export') {
    if (!opts.fhirBase) throw new GaError('usage: ga import <fhir-export.json> --fhir-base <FHIR base URL>');
    return importFhirExport(client, cfg, path, cfg.patientId, { ...opts, fhirBase: opts.fhirBase });
  }
  return importPath(client, cfg, path, cfg.patientId, opts);
}
