import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enrollLink, enrollTokenValid, isOwner, ownerCookie, takeEnrollToken, verifyAuthentication, verifyRegistration } from '../src/gateway/passkey.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'gw-'));
const url = 'https://ga.example.ts.net';
const tokenOf = (l: string) => l.slice(`${url}/enroll/`.length);

describe('enrollment token', () => {
  it('works once', () => {
    const d = dir();
    const t = tokenOf(enrollLink(d, url));
    expect(takeEnrollToken(d, t)).toBe(true);
    expect(takeEnrollToken(d, t)).toBe(false);
  });
  it('fails after 24 hours and for unknown tokens', () => {
    const d = dir();
    const t = tokenOf(enrollLink(d, url, 1000));
    expect(takeEnrollToken(d, t, 1000 + 24 * 3600_000)).toBe(false);
    expect(takeEnrollToken(d, 'nope')).toBe(false);
  });
});

describe('verifyRegistration token gate', () => {
  it('rejects bad, expired and used tokens and stores nothing', async () => {
    const d = dir();
    const t = tokenOf(enrollLink(d, url));
    expect(await verifyRegistration(d, url, 'bad', { id: 'x' } as never, 'c')).toBe(false);
    expect(await verifyRegistration(d, url, t, { id: 'x' } as never, 'c')).toBe(false); // library rejects junk; token not burned
    expect(enrollTokenValid(d, t)).toBe(true);
    expect(enrollTokenValid(d, t, Date.now() + 24 * 3600_000)).toBe(false);
    takeEnrollToken(d, t);
    expect(await verifyRegistration(d, url, t, { id: 'x' } as never, 'c')).toBe(false);
    expect(existsSync(join(d, 'passkeys.json'))).toBe(false);
  });
});

describe('owner cookie', () => {
  const val = (c: string) => c.split(';')[0];
  it('accepts a fresh cookie among others and sets the attributes', () => {
    const d = dir();
    const c = ownerCookie(d, 1000);
    expect(c).toContain('HttpOnly; Secure; SameSite=Lax; Path=/');
    expect(isOwner(d, `a=b; ${val(c)}; c=d`, 1000)).toBe(true);
  });
  it('rejects tampered, expired and missing', () => {
    const d = dir();
    const v = val(ownerCookie(d, 1000));
    expect(isOwner(d, v.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A')), 1000)).toBe(false);
    expect(isOwner(d, v.replace(/=\d+/, '=99999999999999'), 1000)).toBe(false);
    expect(isOwner(d, v, 1000 + 12 * 3600_000)).toBe(false);
    expect(isOwner(d, undefined)).toBe(false);
    expect(isOwner(d, 'a=b')).toBe(false);
  });
});

it('verifyAuthentication is false with no passkeys', async () => {
  expect(await verifyAuthentication(dir(), url, { id: 'x' } as never, 'c')).toBe(false);
});
