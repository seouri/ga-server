// Hospital actions shared by the CLI, the chat tools and the gateway's /callback.
import type { MedplumClient } from '@medplum/core';
import { GaError } from '../config.ts';
import { COMPARTMENT } from '../engine.ts';
import { finishLogin, pendingName, resultName } from './auth.ts';
import type { LoginResult } from './auth.ts';
import { deleteSecret, loadSecret, readSources, saveSecret, writeSources } from './store.ts';
import type { SourceRec } from './store.ts';
import { syncSource, writeEndpoint } from './sync.ts';
import type { SyncResult } from './sync.ts';

const source = (dir: string, key: string): SourceRec => {
  const s = readSources(dir).find((x) => x.key === key);
  if (!s) throw new GaError(`unknown source: ${key} (see ga status)`);
  return s;
};

// Validates a type list ('all' = every type GA knows) and returns it.
export function checkTypes(types: string[] | 'all'): string[] {
  const all = Object.keys(COMPARTMENT);
  if (types === 'all') return all;
  const list = types.map((t) => t.trim()).filter(Boolean);
  const bad = list.filter((t) => !all.includes(t));
  if (bad.length || !list.length) throw new GaError(`unknown type: ${bad.join(',') || '(none)'}; known: ${all.join(',')}`);
  return list;
}

export function enableTypes(dir: string, sourceKey: string, types: string[] | 'all'): SourceRec {
  const enabledTypes = checkTypes(types);
  const rec = { ...source(dir, sourceKey), enabledTypes };
  writeSources(dir, readSources(dir).map((s) => (s.key === sourceKey ? rec : s)));
  return rec;
}

// Status first: if this write fails the tokens remain and the source still works. The source stays listed
// (enabled types kept for a reconnect); with no tokens, sync skips it.
export async function disconnectSource(client: MedplumClient, dir: string, sourceKey: string, patientId: string): Promise<void> {
  const src = source(dir, sourceKey);
  await writeEndpoint(client, dir, src, patientId, 'off', new Date().toISOString(), 'disconnected');
  deleteSecret(dir, src.key);
}

// The gateway's /callback: finish the login, dry-run the source for counts, leave the outcome for waitForLogin / hospital_status.
export async function completeLogin(client: MedplumClient, dir: string, patientId: string, search: string): Promise<SyncResult> {
  const state = new URLSearchParams(search).get('state') ?? '';
  const fhirBase = loadSecret<{ fhirBase: string }>(dir, pendingName(state))?.fhirBase;
  const out = resultName(state);
  try {
    const src = await finishLogin(dir, search);
    const result = await syncSource(client, dir, src, patientId, { dryRun: true });
    saveSecret(dir, out, { source: src, result } satisfies LoginResult);
    return result;
  } catch (e) {
    // An unknown state leaves no file: nothing of ours to report, and forged states must not fill the store.
    if (fhirBase) saveSecret(dir, out, { error: e instanceof Error ? e.message : 'login_failed', fhirBase } satisfies LoginResult);
    throw e;
  }
}
