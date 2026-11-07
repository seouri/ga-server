import { dirname, join } from 'node:path';
import { defaultConfigPath } from '../config.ts';
import { writeAtomic } from '../smart/store.ts';

export { readJson } from '../smart/store.ts';

export const gatewayDir = (cfgPath: string = defaultConfigPath()): string => join(dirname(cfgPath), 'gateway');

export const writeJson = (dir: string, name: string, v: unknown): void => writeAtomic(join(dir, name), JSON.stringify(v), 0o600);
