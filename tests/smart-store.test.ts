import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, jwtVerify, importJWK } from 'jose';
import { deleteSecret, ensureKeys, loadSecret, readSources, saveSecret, signingKey, smartDir, writeSources } from '../src/smart/store.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ga-smart-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('secrets', () => {
  it('round-trips, encrypts, is 0600, detects tampering, deletes', () => {
    saveSecret(dir, 'src1', { refresh_token: 'r1' });
    expect(loadSecret(dir, 'src1')).toEqual({ refresh_token: 'r1' });
    const f = join(dir, 'tokens', 'src1.enc');
    expect(readFileSync(f).includes('r1')).toBe(false);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'key.bin')).mode & 0o777).toBe(0o600);
    const b = readFileSync(f); b[b.length - 1] ^= 1; writeFileSync(f, b);
    expect(() => loadSecret(dir, 'src1')).toThrow(/token store unreadable/);
    deleteSecret(dir, 'src1');
    expect(loadSecret(dir, 'src1')).toBeUndefined();
    deleteSecret(dir, 'src1');
  });
});

describe('keys', () => {
  it('is idempotent and never publishes the private part', async () => {
    const a = await ensureKeys(dir);
    const b = await ensureKeys(dir);
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.publicJwks.keys).toEqual(a.publicJwks.keys);
    expect(a.publicJwks.keys[0]).not.toHaveProperty('d');
    expect(a.publicPem).toContain('BEGIN PUBLIC KEY');
    expect(statSync(join(dir, 'private.jwk.json')).mode & 0o777).toBe(0o600);
  });
  it('signs a verifiable RS384 JWT', async () => {
    const { publicJwks } = await ensureKeys(dir);
    const { key, kid } = await signingKey(dir);
    expect(kid).toBe((publicJwks.keys[0] as { kid: string }).kid);
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS384', kid }).setIssuer('x').sign(key);
    const pub = await importJWK({ ...publicJwks.keys[0], alg: 'RS384' }, 'RS384');
    expect((await jwtVerify(jwt, pub)).payload.iss).toBe('x');
  });
});

describe('sources', () => {
  it('reads empty, writes, reads back; smartDir sits beside the config', () => {
    expect(readSources(dir)).toEqual([]);
    const s = [{ key: 'a-b', name: 'A', fhirBase: 'https://a.b/fhir' }];
    writeSources(dir, s);
    expect(readSources(dir)).toEqual(s);
    expect(smartDir('/x/y/config.json')).toBe('/x/y/smart');
  });
});
