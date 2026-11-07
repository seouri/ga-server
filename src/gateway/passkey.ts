import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { readJson, writeJson } from './store.ts';

type Passkey = { id: string; publicKey: string; counter: number; transports?: string[] };
const DAY = 24 * 3600_000;
const COOKIE_MS = 12 * 3600_000;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const rp = (publicUrl: string) => ({ rpID: new URL(publicUrl).hostname, origin: publicUrl });
const keys = (dir: string): Passkey[] => readJson<Passkey[]>(dir, 'passkeys.json', []);

// Only hashes are stored; the link itself is shown once.
export function enrollLink(dir: string, publicUrl: string, now = Date.now()): string {
  const token = randomBytes(32).toString('base64url');
  const live = readJson<Record<string, number>>(dir, 'enroll.json', {});
  for (const h of Object.keys(live)) if (live[h] <= now) delete live[h];
  live[hash(token)] = now + DAY;
  writeJson(dir, 'enroll.json', live);
  return `${publicUrl}/enroll/${token}`;
}

// Non-consuming, so a link-preview bot opening the URL does not burn the token.
export const enrollTokenValid = (dir: string, token: string, now = Date.now()): boolean =>
  (readJson<Record<string, number>>(dir, 'enroll.json', {})[hash(token)] ?? 0) > now;

export function takeEnrollToken(dir: string, token: string, now = Date.now()): boolean {
  const live = readJson<Record<string, number>>(dir, 'enroll.json', {}); // shortcut: read-modify-write can race the CLI, one owner makes it rare
  const h = hash(token);
  const ok = (live[h] ?? 0) > now;
  if (h in live) {
    delete live[h];
    writeJson(dir, 'enroll.json', live);
  }
  return ok;
}

export const registrationOptions = (dir: string, publicUrl: string) =>
  generateRegistrationOptions({
    rpName: 'GA',
    rpID: rp(publicUrl).rpID,
    userName: 'owner',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: keys(dir).map((k) => ({ id: k.id, transports: k.transports })),
  });

// Stores a passkey only with a live enrollment token, consumed after the library verifies.
export async function verifyRegistration(dir: string, publicUrl: string, token: string, response: RegistrationResponseJSON, expectedChallenge: string): Promise<boolean> {
  if (!enrollTokenValid(dir, token)) return false;
  const { rpID, origin } = rp(publicUrl);
  try {
    const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!v.verified || !takeEnrollToken(dir, token)) return false;
    const { id, publicKey, counter, transports } = v.registrationInfo.credential;
    writeJson(dir, 'passkeys.json', [...keys(dir).filter((k) => k.id !== id), { id, publicKey: Buffer.from(publicKey).toString('base64url'), counter, transports }]);
    return true;
  } catch {
    return false;
  }
}

export const authenticationOptions = (dir: string, publicUrl: string) =>
  generateAuthenticationOptions({ rpID: rp(publicUrl).rpID, userVerification: 'required', allowCredentials: keys(dir).map((k) => ({ id: k.id, transports: k.transports })) });

export async function verifyAuthentication(dir: string, publicUrl: string, response: AuthenticationResponseJSON, expectedChallenge: string): Promise<boolean> {
  const all = keys(dir);
  const k = all.find((p) => p.id === response.id);
  if (!k) return false;
  const { rpID, origin } = rp(publicUrl);
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: k.id, publicKey: Buffer.from(k.publicKey, 'base64url'), counter: k.counter, transports: k.transports },
    });
    if (!v.verified) return false;
    const fresh = keys(dir);
    for (const p of fresh) if (p.id === k.id) p.counter = v.authenticationInfo.newCounter;
    writeJson(dir, 'passkeys.json', fresh);
    return true;
  } catch {
    return false;
  }
}

function cookieKey(dir: string): Buffer {
  const f = join(dir, 'cookie.key');
  if (!existsSync(f)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(f, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return readFileSync(f);
}
const sign = (dir: string, exp: string): string => createHmac('sha256', cookieKey(dir)).update(exp).digest('base64url');

export function ownerCookie(dir: string, now = Date.now()): string {
  const exp = String(now + COOKIE_MS);
  return `ga_owner=${exp}.${sign(dir, exp)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MS / 1000}`;
}

export function isOwner(dir: string, cookieHeader: string | undefined, now = Date.now()): boolean {
  const raw = cookieHeader?.split(';').map((c) => c.trim()).find((c) => c.startsWith('ga_owner='))?.slice(9);
  const [exp, mac] = raw?.split('.') ?? [];
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) <= now) return false;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(dir, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
