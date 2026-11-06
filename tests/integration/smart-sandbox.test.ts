// Live check against the public SMART sandbox (synthetic data only). Gated: GA_SMART_SANDBOX=1 npx vitest run tests/integration/smart-sandbox.test.ts
// Skipped when unset, or when the sandbox stops advertising asymmetric client auth (private_key_jwt), which GA requires.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, DocumentReference, Resource } from '@medplum/fhirtypes';
import { afterAll, describe, expect, it } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { connect } from '../../src/smart/auth.ts';
import type { Tokens } from '../../src/smart/auth.ts';
import { ensureKeys, loadSecret, saveSecret, writeApp, writeSources } from '../../src/smart/store.ts';
import { syncSource } from '../../src/smart/sync.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const LAUNCHER = 'https://launch.smarthealthit.org/v/r4';
const PATIENT = '87a339d0-8cae-418e-89c7-8651e6aab3c6'; // a synthetic sandbox patient
const clientId = 'ga-sandbox-test';

describe.skipIf(!process.env.GA_SMART_SANDBOX)('SMART sandbox (launch.smarthealthit.org)', () => {
  let client: MedplumClient;
  let dir: string;
  let pid: string;
  let key: string;

  afterAll(async () => {
    if (!client) return;
    if (pid) {
      const bundle = await client.get<Bundle>(`fhir/R4/Patient/${pid}/$everything?_count=1000`, { cache: 'no-cache' });
      for (const e of bundle.entry ?? []) {
        if (e.search?.mode !== 'match') continue;
        for (const c of (e.resource as DocumentReference).content ?? []) {
          const id = /(?:Binary|storage)\/([0-9a-f-]{36})/.exec(c.attachment?.url ?? '')?.[1];
          if (id) await client.deleteResource('Binary', id).catch(() => undefined);
        }
      }
      await cleanupTestPatient(client, pid);
    }
    for (const t of ['Endpoint', 'Medication'] as const) {
      const sys = t === 'Endpoint' ? `urn:ga-server:id:smart-source|${key}` : `urn:ga-server:id:smart:${key}|`;
      for (const r of await client.searchResources(t, { identifier: sys, _count: '1000' }, { cache: 'no-cache' })) {
        if (t === 'Medication' || r.extension?.some((x) => x.valueReference?.reference === `Patient/${pid}`)) await client.deleteResource(t, r.id as string);
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('connects, syncs twice (second is a no-op), and a revoked refresh token turns the source off', { timeout: 600_000 }, async (ctx) => {
    const conf = (await (await fetch(`${LAUNCHER}/fhir/.well-known/smart-configuration`)).json()) as { token_endpoint_auth_methods_supported?: string[] };
    if (!conf.token_endpoint_auth_methods_supported?.includes('private_key_jwt')) ctx.skip('sandbox does not offer private_key_jwt');

    client = await getClient(loadConfig());
    pid = await createTestPatient(client);
    dir = mkdtempSync(join(tmpdir(), 'ga-smart-sandbox-'));
    const { publicJwks } = await ensureKeys(dir);
    writeApp(dir, { clientId });
    // Launcher sim params (smart-launcher-v2 codec): patient-standalone, skip login and approval, confidential-asymmetric with our JWKS.
    const sim = [3, PATIENT, '', 'AUTO', 1, 1, 0, '', '', clientId, '', '', '', JSON.stringify(publicJwks), 2, 1, ''];
    const fhirBase = `${LAUNCHER}/sim/${Buffer.from(JSON.stringify(sim)).toString('base64url')}/fhir`;
    const src = await connect(dir, fhirBase, clientId, async (url) => void (await fetch(url)), { name: 'SMART sandbox', port: 0 });
    key = src.key;
    // No Condition: the sandbox's Conditions carry no category, and GA searches Condition by category only (as Epic requires).
    src.enabledTypes = ['Observation', 'MedicationRequest', 'Immunization', 'AllergyIntolerance'];
    writeSources(dir, [src]);

    const first = await syncSource(client, dir, src, pid);
    expect(first.error).toBeUndefined();
    expect(first.status).toBe('active');
    expect(first.report?.created).toBeGreaterThan(0);

    // Second sync on the same access token. Not after a real refresh: the sandbox's refresh response carries an id_token
    // without an `aud` claim, which openid-client rejects (token_error). Refresh rotation is covered against the mock.
    const second = await syncSource(client, dir, src, pid);
    expect(second.status).toBe('active');
    expect(second.report).toMatchObject({ created: 0, updated: 0 });

    // Forced expiry with a revoked refresh token: the source turns off.
    saveSecret(dir, key, { ...loadSecret<Tokens>(dir, key)!, expires_at: Date.now() - 1000, refresh_token: 'revoked' });
    const third = await syncSource(client, dir, src, pid);
    expect(third).toMatchObject({ status: 'off', error: 'invalid_grant' });
    const mine = (await client.get<Bundle>(`fhir/R4/Patient/${pid}/$everything?_count=1`, { cache: 'no-cache' })).entry as { resource?: Resource }[];
    expect(mine.length).toBeGreaterThan(0);
  });
});
