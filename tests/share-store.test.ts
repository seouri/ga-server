import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GaError } from '../src/config.ts';
import { createShare, findByToken, listShares, parseExpiry, parseSince, revokeShare, takeQuestion, tokenOf } from '../src/share/store.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ga-share-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const base = { label: 'L', patientId: 'p1', baseUrl: 'http://localhost:8110' };
const now = new Date(2026, 10, 6, 12, 0, 0);

describe('createShare', () => {
  it('doctor defaults', () => {
    const { share, token } = createShare(dir, { ...base, audience: 'doctor' }, now);
    expect(share.groups).toEqual(['labs', 'medications', 'problems', 'allergies', 'immunizations', 'vitals']);
    expect(share.layout).toBe('A');
    expect(share.questionsPerDay).toBe(20);
    expect(share.expires).toBe(new Date(now.getTime() + 7 * 86400000).toISOString());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(share.id).toMatch(/^[0-9a-f]{8}$/);
    const raw = readFileSync(join(dir, 'shares.json'), 'utf8');
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw)[0]).not.toHaveProperty('token');
    expect(JSON.parse(raw)[0].tokenHash).toBe(share.tokenHash);
  });
  it('family defaults', () => {
    const { share } = createShare(dir, { ...base, audience: 'family' }, now);
    expect(share.groups).toBe('all');
    expect(share.layout).toBe('B');
    expect(share.expires).toBeUndefined();
    expect(listShares(dir)).toHaveLength(1);
  });
});

describe('findByToken', () => {
  it('finds, rejects wrong, revoked and expired', () => {
    const { share, token } = createShare(dir, { ...base, audience: 'doctor' }, now);
    expect(findByToken(dir, token, now)?.id).toBe(share.id);
    expect(findByToken(dir, token + 'x', now)).toBeUndefined();
    expect(findByToken(dir, token, new Date(now.getTime() + 7 * 86400000 + 1))).toBeUndefined();
    revokeShare(dir, share.id);
    expect(findByToken(dir, token, now)).toBeUndefined();
  });
});

describe('parsers', () => {
  it('parseExpiry', () => {
    expect(parseExpiry('2026-11-13', now)).toBe(new Date(2026, 10, 13, 23, 59, 59, 999).toISOString());
    expect(parseExpiry('12h', now)).toBe(new Date(now.getTime() + 12 * 3600000).toISOString());
    expect(parseExpiry('never', now)).toBeUndefined();
    expect(() => parseExpiry('abc', now)).toThrow(GaError);
    expect(() => parseExpiry('2026-02-31', now)).toThrow(GaError);
  });
  it('parseSince', () => {
    expect(parseSince('12m', now)).toBe('2025-11-06');
    expect(parseSince('2y', now)).toBe('2024-11-06');
    expect(parseSince('2026-01-05', now)).toBe('2026-01-05');
    expect(parseSince('1m', new Date(2026, 2, 31))).toBe('2026-02-28');
    expect(() => parseSince('x', now)).toThrow(GaError);
  });
});

describe('questions and token', () => {
  it('takeQuestion caps per local day', () => {
    const { share } = createShare(dir, { ...base, audience: 'doctor', questionsPerDay: 2 }, now);
    expect([1, 2, 3].map(() => takeQuestion(dir, share.id, now))).toEqual([true, true, false]);
    expect(takeQuestion(dir, share.id, new Date(2026, 10, 7, 0, 5))).toBe(true);
  });
  it('takeQuestion never rewrites shares.json (cannot undo a concurrent revoke)', () => {
    const { share } = createShare(dir, { ...base, audience: 'doctor' }, now);
    const before = readFileSync(join(dir, 'shares.json'), 'utf8');
    expect(takeQuestion(dir, share.id, now)).toBe(true);
    expect(readFileSync(join(dir, 'shares.json'), 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(join(dir, 'asked.json'), 'utf8'))[share.id]).toEqual({ day: '2026-11-06', n: 1 });
  });
  it('tokenOf returns the original token', () => {
    const { share, token } = createShare(dir, { ...base, audience: 'family' }, now);
    expect(tokenOf(dir, share.id)).toBe(token);
  });
});
