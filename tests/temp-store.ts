// A throwaway GA store for one test: GA's types, at <dir>/store/ga.db with its token at <dir>/store/token (where getClient
// finds it when GA_CONFIG is <dir>/config.json), a client sending the token, and close() (stops it, removes dir).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import { bearer } from '../src/config.ts';
import { GA_STORE_TYPES } from '../src/store-serve.ts';
import { serveStore } from '../src/store/server.ts';

export async function tempStore(dir = mkdtempSync(join(tmpdir(), 'ga-test-store-'))) {
  const server = await serveStore({ file: join(dir, 'store', 'ga.db'), host: '127.0.0.1', port: 0, tokenFile: join(dir, 'store', 'token'), types: GA_STORE_TYPES });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const token = readFileSync(join(dir, 'store', 'token'), 'utf8').trim();
  return {
    dir, base, token, client: new MedplumClient({ baseUrl: base, fetch: bearer(token) }),
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type TempStore = Awaited<ReturnType<typeof tempStore>>;

// run on a fresh temp store, closed after.
export async function onStore<T>(run: (s: TempStore) => Promise<T>): Promise<T> {
  const s = await tempStore();
  try { return await run(s); } finally { await s.close(); }
}
