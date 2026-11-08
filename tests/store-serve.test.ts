// GA's wiring of the store (src/store-serve.ts, config.ts): the store's own tests (src/store/test) import nothing from GA.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSearchParameters } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type GaConfig, getClient, storeServeOptions } from '../src/config.ts';
import { MAX_UPLOAD } from '../src/limits.ts';
import { PATIENT_COMPARTMENT } from '../src/share/scope.ts';
import { ACCESS_POLICY } from '../src/setup.ts';
import { GA_STORE_TYPES, gaStoreError, gaStoreOptions } from '../src/store-serve.ts';
import { IndexFormatError } from '../src/store/store.ts';
import { loadDefinitions } from '../src/store/definitions.ts';
import { serveStore } from '../src/store/server.ts';
import { onStore } from './temp-store.ts';

afterEach(() => vi.unstubAllEnvs());

describe('ga store serve options', () => {
  it('Review Focus 3: binds 127.0.0.1 by default; GA_STORE_HOST picks the interface (0.0.0.0 inside the ga-store container)', () => {
    expect(storeServeOptions({}, '/x/.ga/config.json')).toEqual({ file: '/x/.ga/store/ga.db', host: '127.0.0.1', port: 8120, tokenFile: '/x/.ga/store/token' });
    expect(storeServeOptions({ GA_STORE_HOST: '0.0.0.0', GA_STORE_URL: 'http://ga-store:9000/' }, '/x/.ga/config.json')).toMatchObject({ host: '0.0.0.0', port: 9000 });
  });

  it('ga store serve passes GA\'s upload limit and GA\'s resource types to the store', () => {
    expect(gaStoreOptions()).toMatchObject({ maxBinaryBytes: MAX_UPLOAD, types: GA_STORE_TYPES });
    expect(GA_STORE_TYPES).toEqual(expect.arrayContaining([...PATIENT_COMPARTMENT, 'Patient', 'Binary', 'Endpoint', 'Basic', 'ConceptMap']));
    // What GA may touch on Medplum (ga setup's access policy) is what its store keeps: a migration copies every type.
    expect(new Set(ACCESS_POLICY.resource!.map((r) => r.resourceType))).toEqual(new Set(GA_STORE_TYPES));
    expect(GA_STORE_TYPES).not.toContain('ResearchStudy');
  });

  it('an index-format refusal tells the owner to run ga migrate-store; other errors pass through', () => {
    const e = gaStoreError(new IndexFormatError('FHIR store x has search index format 1, this version needs 2: rebuild the file from its source'));
    expect((e as Error).message).toMatch(/rebuild the file from its source: move it aside and run ga migrate-store$/);
    const other = new Error('x');
    expect(gaStoreError(other)).toBe(other);
  });

  it('storeUrl in config.json with another port: the server listens there and getClient reaches it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ga-url-'));
    const probe = createServer().listen(0, '127.0.0.1'); // a free port
    await new Promise((r) => probe.once('listening', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const cfgPath = join(dir, 'config.json'), cfg = { store: 'sqlite', storeUrl: `http://127.0.0.1:${port}/`, patientId: 'p', converterUrl: 'x' } as GaConfig;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    vi.stubEnv('GA_CONFIG', cfgPath);
    vi.stubEnv('GA_STORE_URL', '');
    const opts = gaStoreOptions();
    expect(opts.port).toBe(port);
    const s = await serveStore(opts);
    try {
      expect(await (await getClient(cfg)).searchResources('Patient', {})).toHaveLength(0);
    } finally { s.closeAllConnections(); await new Promise((r) => s.close(r)); rmSync(dir, { recursive: true, force: true }); }
  });

  it('getClient with GA_STORE=sqlite talks to the store with the token from .ga/store/token (no login)', async () => {
    await onStore(async ({ dir, base }) => {
      vi.stubEnv('GA_STORE', 'sqlite');
      vi.stubEnv('GA_CONFIG', join(dir, 'config.json'));
      const c = await getClient({ storeUrl: base } as GaConfig);
      await c.createResource<Patient>({ resourceType: 'Patient' });
      expect(await c.searchResources('Patient', {})).toHaveLength(1);
      vi.stubEnv('GA_CONFIG', join(dir, 'nowhere', 'config.json'));
      await expect(getClient({ storeUrl: base } as GaConfig)).rejects.toThrow(/GA is not running/);
    });
  });
});

it('the store keeps every Patient compartment type GA searches (with _tag)', () => {
  loadDefinitions(GA_STORE_TYPES);
  for (const t of PATIENT_COMPARTMENT) expect(getSearchParameters(t)?._tag, t).toBeDefined();
});
