import type { MedplumClient } from '@medplum/core';
import { type AppleBatchOpts, importAppleHealth } from './apple/import.ts';
import { isAppleHealthExport } from './apple/read.ts';
import { importPath } from './ccda.ts';
import { GaError, type GaConfig } from './config.ts';
import { importEhi } from './ehi/import.ts';
import { isEhiExport } from './ehi/read.ts';

export type ImportKind = 'pdf' | 'ehi' | 'apple' | 'ccda';

export function detectKind(path: string): ImportKind {
  if (/\.(pdf|png|jpe?g)$/i.test(path)) return 'pdf';
  if (isEhiExport(path)) return 'ehi';
  if (isAppleHealthExport(path)) return 'apple';
  if (/\.zip$/i.test(path)) throw new GaError('unzip export.zip first, then: ga import <folder>');
  return 'ccda';
}

// opts.tz: EHI export zone (already validated by the caller). The batch options resume an import (src/import-jobs.ts): EHI and
// C-CDA write as one batch, index 0.
export async function importAny(client: MedplumClient, cfg: GaConfig, path: string, opts: { tz?: string } & AppleBatchOpts = {}): Promise<unknown> {
  const kind = detectKind(path);
  if (kind === 'pdf') throw new GaError(`PDFs are extracted by your agent: ask it to import ${path}, or pass --llm api`);
  if (kind === 'apple') return importAppleHealth(client, cfg, path, cfg.patientId, opts);
  if ((opts.skipThrough ?? -1) >= 0) return undefined;
  const r = kind === 'ehi' ? await importEhi(client, cfg, path, cfg.patientId, opts.tz) : await importPath(client, cfg, path);
  await opts.onBatch?.(0, r);
  return r;
}
