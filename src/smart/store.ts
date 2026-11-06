import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { calculateJwkThumbprint, exportJWK, exportSPKI, generateKeyPair, importJWK } from 'jose';
import type { JWK } from 'jose';
import { GaError, defaultConfigPath } from '../config.ts';

export const smartDir = (cfgPath: string = defaultConfigPath()): string => join(dirname(cfgPath), 'smart');

// Same-dir temp file then rename, so a crash never leaves a half-written file.
function writeAtomic(file: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Only saveSecret may create the key, exclusively, so tokens are never orphaned by a silent new key.
function aesKey(dir: string, create: boolean): Buffer {
  const f = join(dir, 'key.bin');
  if (create && !existsSync(f)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(f, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return readFileSync(f);
}

// Secret names become file names: refuse anything that could escape tokens/.
const secretFile = (dir: string, name: string): string => {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new GaError('invalid secret name');
  return join(dir, 'tokens', `${name}.enc`);
};

export function saveSecret(dir: string, name: string, data: unknown): void {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(dir, true), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  writeAtomic(secretFile(dir, name), Buffer.concat([iv, c.getAuthTag(), ct]), 0o600);
}

export function loadSecret<T>(dir: string, name: string): T | undefined {
  const f = secretFile(dir, name);
  if (!existsSync(f)) return undefined;
  try {
    const b = readFileSync(f);
    const d = createDecipheriv('aes-256-gcm', aesKey(dir, false), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) as T;
  } catch {
    throw new GaError('token store unreadable');
  }
}

export function deleteSecret(dir: string, name: string): void {
  rmSync(secretFile(dir, name), { force: true });
}

export async function ensureKeys(dir: string): Promise<{ publicJwks: { keys: object[] }; publicPem: string; created: boolean }> {
  const priv = join(dir, 'private.jwk.json');
  const pub = join(dir, 'public.jwks.json');
  const hasPriv = existsSync(priv);
  const hasPub = existsSync(pub);
  if (hasPub && !hasPriv) {
    throw new GaError('signing key missing: run ga keys after restoring .ga/smart/private.jwk.json or delete public.jwks.json to start over');
  }
  if (hasPriv) {
    // Never regenerate over an existing private key: it is registered with the hospital.
    const { d, p, q, dp, dq, qi, key_ops, ext, ...pubJwk } = JSON.parse(readFileSync(priv, 'utf8')) as JWK;
    const publicJwks = hasPub ? (JSON.parse(readFileSync(pub, 'utf8')) as { keys: object[] }) : { keys: [pubJwk] };
    if (!hasPub) writeAtomic(pub, JSON.stringify(publicJwks));
    const publicPem = await exportSPKI((await importJWK({ ...publicJwks.keys[0], alg: 'RS384' } as JWK, 'RS384', { extractable: true })) as CryptoKey);
    return { publicJwks, publicPem, created: false };
  }
  const { publicKey, privateKey } = await generateKeyPair('RS384', { extractable: true });
  const kid = await calculateJwkThumbprint(await exportJWK(publicKey));
  const meta = { kid, alg: 'RS384', use: 'sig' };
  const publicJwks = { keys: [{ ...(await exportJWK(publicKey)), ...meta }] };
  writeAtomic(priv, JSON.stringify({ ...(await exportJWK(privateKey)), ...meta }), 0o600);
  writeAtomic(pub, JSON.stringify(publicJwks));
  return { publicJwks, publicPem: await exportSPKI(publicKey), created: true };
}

export async function signingKey(dir: string): Promise<{ key: CryptoKey; kid: string }> {
  const f = join(dir, 'private.jwk.json');
  if (!existsSync(f)) throw new GaError('signing key missing: run ga keys');
  const jwk = JSON.parse(readFileSync(f, 'utf8')) as JWK;
  return { key: (await importJWK(jwk, 'RS384')) as CryptoKey, kid: jwk.kid as string };
}

export type SourceRec = { key: string; name: string; fhirBase: string; patient?: string; enabledTypes?: string[] };

export function readSources(dir: string): SourceRec[] {
  const f = join(dir, 'sources.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as SourceRec[]) : [];
}

export function writeSources(dir: string, s: SourceRec[]): void {
  writeAtomic(join(dir, 'sources.json'), JSON.stringify(s, null, 2));
}
