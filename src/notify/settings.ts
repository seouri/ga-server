import { dirname, join } from 'node:path';
import { defaultConfigPath } from '../config.ts';
import { readJson, writeJson } from '../gateway/store.ts';

export type Settings = { to: string; digestAt: string; sleep: [string, string]; setupAt: string; off?: true };
export type State = { sentResults: Record<string, string>; sentTopics: Record<string, string>; lastDigestDay?: string; lastDigestAt?: string; lastSend?: string; lastError?: string; checkedAt?: string };

export const notifyDir = (cfgPath: string = defaultConfigPath()): string => join(dirname(cfgPath), 'notify');
export const readSettings = (dir: string): Settings | undefined => readJson<Settings | undefined>(dir, 'settings.json', undefined);
export const readState = (dir: string): State => ({ sentResults: {}, sentTopics: {}, ...readJson<Partial<State>>(dir, 'state.json', {}) });
export const writeState = (dir: string, s: State): void => writeJson(dir, 'state.json', s);
