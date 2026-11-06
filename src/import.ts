import type { MedplumClient } from '@medplum/core';
import { importAppleHealth } from './apple/import.ts';
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

// opts.tz: EHI export zone (already validated by the caller); opts.name is reserved for the gateway upload.
export async function importAny(client: MedplumClient, cfg: GaConfig, path: string, opts: { tz?: string; name?: string } = {}): Promise<unknown> {
  const kind = detectKind(path);
  if (kind === 'pdf') throw new GaError(`PDFs are extracted by your agent: ask it to import ${path}, or pass --llm api`);
  if (kind === 'ehi') return importEhi(client, cfg, path, cfg.patientId, opts.tz);
  if (kind === 'apple') return importAppleHealth(client, cfg, path);
  return importPath(client, cfg, path);
}
