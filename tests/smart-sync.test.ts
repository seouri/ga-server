// syncSource's error paths against the synthetic mock portal and a fake client that records Endpoint writes (no Medplum).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Endpoint, Resource } from '@medplum/fhirtypes';
import { takeLock } from '../src/lock.ts';
import { disconnectSource } from '../src/smart/actions.ts';
import { loadSecret, saveSecret, writeApp, writeSources } from '../src/smart/store.ts';
import type { SourceRec } from '../src/smart/store.ts';
import { ENABLED_TYPES, LAST_SUCCESS, SOURCE_ID, syncSource } from '../src/smart/sync.ts';
import { serveFixtures, startMock } from './smart/mock-server.ts';
import type { MockSmart } from './smart/mock-server.ts';

const P = 'synthetic-patient-1';
const T0 = '2026-01-01T09:00:00.000Z';
let m: MockSmart;
beforeAll(async () => {
  m = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
  serveFixtures(m);
  m.route('/fhir/MedicationRequest', (_q, res) => void res.writeHead(403).end()); // not selected at login
});
afterAll(() => m.close());

// The Endpoint a previous sync left: last success T0 with Observation enabled.
const setup = (app = { clientId: 'synthetic-client' }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-sync-'));
  writeApp(dir, app);
  const src: SourceRec = { key: 'mock', name: 'Mock', fhirBase: m.fhirBase, patient: P, enabledTypes: ['Observation', 'MedicationRequest'] };
  saveSecret(dir, src.key, { access_token: m.grant(), expires_at: Date.now() + 3_600_000, patient: P });
  const prev: Endpoint = {
    resourceType: 'Endpoint', id: 'ep1', status: 'active', identifier: [{ system: SOURCE_ID, value: src.key }], address: m.fhirBase,
    connectionType: { code: 'hl7-fhir-rest' }, payloadType: [{ text: 'FHIR R4' }],
    extension: [
      { url: 'urn:ga-server:ext:smart-patient', valueReference: { reference: 'Patient/p' } },
      { url: LAST_SUCCESS, valueDateTime: T0 },
      { url: ENABLED_TYPES, valueString: 'Observation' },
    ],
  };
  const writes: Resource[] = [];
  const write = async (r: Resource) => (writes.push(r), r);
  const client = { searchResources: async (t: string) => (t === 'Endpoint' ? [prev] : []), searchOne: async () => undefined, readResource: async (t: string, id: string) => ({ resourceType: t, id }), createResource: write, updateResource: write } as unknown as MedplumClient;
  return { dir, src, client, writes };
};
const ext = (r: Resource, url: string) => (r as Endpoint).extension?.find((x) => x.url === url);

describe('syncSource', () => {
  it('a refused medication list fails the sync naming the type; nothing is imported and last success stays', async () => {
    const { dir, src, client, writes } = setup();
    const r = await syncSource(client, dir, src, 'p');
    expect(r).toMatchObject({ status: 'error', error: 'refused:MedicationRequest' });
    expect(writes.map((w) => w.resourceType)).toEqual(['Endpoint']);
    expect(writes[0]).toMatchObject({ status: 'error' });
    expect(ext(writes[0], LAST_SUCCESS)?.valueDateTime).toBe(T0);
    expect(ext(writes[0], 'urn:ga-server:ext:smart-last-error')?.valueCode).toBe('refused:MedicationRequest');
  });

  it('a dry run still reports the refused list as skipped', async () => {
    const { dir, src, client, writes } = setup();
    const r = await syncSource(client, dir, { ...src, enabledTypes: ['MedicationRequest'] }, 'p', { dryRun: true });
    expect(r.error).toBeUndefined();
    expect(r.skipped).toMatchObject({ MedicationRequest: 'HTTP 403' });
    expect(writes).toEqual([]);
  });

  it('a failed sync keeps the enabled types of the last success', async () => {
    const { dir, src, client, writes } = setup({} as { clientId: string }); // no client id: fails before any fetch
    expect(await syncSource(client, dir, src, 'p')).toMatchObject({ status: 'error', error: 'no_client_id' });
    expect(ext(writes[0], ENABLED_TYPES)?.valueString).toBe('Observation');
  });
});

describe('disconnectSource', () => {
  it('fails fast while a sync of the source holds its lock, changing nothing; works once it is free', async () => {
    const { dir, src, client, writes } = setup();
    writeSources(dir, [src]);
    const lock = (await takeLock(join(dir, `${src.key}.sync.lock`), 0))!;
    await expect(disconnectSource(client, dir, src.key, 'p')).rejects.toThrow('sync running, try again');
    expect(writes).toEqual([]);
    expect(loadSecret(dir, src.key)).toBeTruthy();
    rmSync(lock);
    await disconnectSource(client, dir, src.key, 'p');
    expect(writes[0]).toMatchObject({ status: 'off' });
    expect(loadSecret(dir, src.key)).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
  });
});
