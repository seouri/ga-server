// Hospital actions shared by the CLI, the chat tools and the gateway's /callback.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// Pending and finished logins, read from the encrypted files in tokens/ (pending-<hash> waiting; result-<hash> finished or failed).
export function listLogins(dir: string, now = new Date()) {
  const t = join(dir, 'tokens');
  const files = existsSync(t) ? readdirSync(t) : [];
  const names = (prefix: string) => files.filter((f) => f.startsWith(prefix) && f.endsWith('.enc')).map((f) => f.slice(0, -4));
  const out: { name: string; id: string; fhirBase: string; status: string; fetched?: Record<string, number>; sourceKey?: string }[] = [];
  for (const name of names('pending-')) {
    const p = loadSecret<{ fhirBase: string; expires: number }>(dir, name);
    if (!p) continue;
    if (p.expires < now.getTime()) deleteSecret(dir, name);
    else out.push({ name, id: name.slice(8), fhirBase: p.fhirBase, status: 'waiting' });
  }
  for (const name of names('result-')) {
    const r = loadSecret<LoginResult>(dir, name);
    if (!r) continue;
    const id = name.slice(7);
    if ('error' in r) out.push({ name, id, fhirBase: r.fhirBase, status: `failed: ${r.error}` });
    else out.push({ name, id, fhirBase: r.source.fhirBase, status: 'finished', fetched: r.result.fetched, sourceKey: r.source.key });
  }
  return out;
}

// One result per hospital: the newest login's dry run is the one hospital_enable previews, and old ones do not pile up.
function dropOlderResults(dir: string, keep: string, fhirBase: string): void {
  for (const l of listLogins(dir)) if (l.name.startsWith('result-') && l.name !== keep && l.fhirBase === fhirBase) deleteSecret(dir, l.name);
}

// The gateway's /callback: finish the login, dry-run the source for counts, leave the outcome for waitForLogin / hospital_status.
export async function completeLogin(client: MedplumClient, dir: string, patientId: string, search: string, sync: typeof syncSource = syncSource): Promise<SyncResult> {
  const state = new URLSearchParams(search).get('state') ?? '';
  const fhirBase = loadSecret<{ fhirBase: string }>(dir, pendingName(state))?.fhirBase;
  const out = resultName(state);
  try {
    const src = await finishLogin(dir, search);
    const result = await sync(client, dir, src, patientId, { dryRun: true });
    saveSecret(dir, out, { source: src, result } satisfies LoginResult);
    dropOlderResults(dir, out, src.fhirBase);
    return result;
  } catch (e) {
    // An unknown state leaves no file: nothing of ours to report, and forged states must not fill the store.
    if (fhirBase) {
      saveSecret(dir, out, { error: e instanceof Error ? e.message : 'login_failed', fhirBase } satisfies LoginResult);
      dropOlderResults(dir, out, fhirBase);
    }
    throw e;
  }
}
