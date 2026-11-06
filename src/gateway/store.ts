import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfigPath } from '../config.ts';
import { writeAtomic } from '../smart/store.ts';

export const gatewayDir = (cfgPath: string = defaultConfigPath()): string => join(dirname(cfgPath), 'gateway');

export function readJson<T>(dir: string, name: string, fallback: T): T {
  const f = join(dir, name);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : fallback;
}

export const writeJson = (dir: string, name: string, v: unknown): void => writeAtomic(join(dir, name), JSON.stringify(v), 0o600);

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
