import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MedplumClient } from '@medplum/core';

export class GaError extends Error {}

export type GaConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  patientId: string;
  converterUrl: string;
  adminPassword?: string; // rotated by ga setup; also the Medplum app (http://localhost:3000) login for admin@example.com
};

// Resolved from this module, not cwd: agents spawn `ga` from arbitrary directories.
export const defaultConfigPath = (): string =>
  process.env.GA_CONFIG || join(dirname(fileURLToPath(import.meta.url)), '..', '.ga', 'config.json');

export function loadConfig(path = defaultConfigPath()): GaConfig {
  let cfg: GaConfig;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as GaConfig;
  } catch (e) {
    // EACCES: the ga-sync container runs as a uid that cannot read the host's 0600 config.
    if ((e as NodeJS.ErrnoException).code === 'EACCES') throw new GaError('cannot read .ga/config.json: set UID/GID');
    throw new GaError('run ga setup first');
  }
  // The ga-sync container reaches Medplum by service name, not localhost.
  if (process.env.GA_BASE_URL) cfg.baseUrl = process.env.GA_BASE_URL;
  return cfg;
}

export const notRunning = (e: unknown) =>
  JSON.stringify([e, (e as Error)?.cause]).includes('ECONNREFUSED') || (e as Error)?.message === 'fetch failed';

export async function getClient(cfg: GaConfig): Promise<MedplumClient> {
  const client = new MedplumClient({ baseUrl: cfg.baseUrl });
  try {
    await client.startClientLogin(cfg.clientId, cfg.clientSecret);
  } catch (e) {
    if (notRunning(e)) throw new GaError('GA is not running: run docker compose up');
    throw e;
  }
  return client;
}
