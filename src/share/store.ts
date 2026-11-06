import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GaError, defaultConfigPath } from '../config.ts';
import { loadSecret, saveSecret, writeAtomic } from '../smart/store.ts';

export type Group = 'labs' | 'vitals' | 'medications' | 'problems' | 'allergies' | 'immunizations' | 'visits' | 'notes' | 'procedures' | 'family' | 'messages' | 'apple';
export const GROUPS: readonly Group[] = ['labs', 'vitals', 'medications', 'problems', 'allergies', 'immunizations', 'visits', 'notes', 'procedures', 'family', 'messages', 'apple'];

export type Share = {
  id: string;
  label: string;
  audience: 'doctor' | 'family';
  groups: Group[] | 'all';
  since?: string;
  until?: string;
  expires?: string;
  layout: 'A' | 'B';
  questionsPerDay: number;
  tokenHash: string;
  patientId: string;
  baseUrl: string;
  created: string;
  revoked?: string;
};

export type ShareOpts = {
  audience: 'doctor' | 'family';
  label: string;
  groups?: Group[] | 'all';
  since?: string;
  until?: string;
  expires?: string;
  layout?: 'A' | 'B';
  questionsPerDay?: number;
  patientId: string;
  baseUrl: string;
};

const DOCTOR_GROUPS: Group[] = ['labs', 'medications', 'problems', 'allergies', 'immunizations', 'vitals'];
const DAY = 86400000;
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');
const pad = (n: number): string => String(n).padStart(2, '0');
const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const shareDir = (cfgPath: string = defaultConfigPath()): string => join(dirname(cfgPath), 'share');

const file = (dir: string): string => join(dir, 'shares.json');
const read = (dir: string): Share[] => (existsSync(file(dir)) ? (JSON.parse(readFileSync(file(dir), 'utf8')) as Share[]) : []);
const write = (dir: string, s: Share[]): void => writeAtomic(file(dir), JSON.stringify(s, null, 2), 0o600);

function parseDate(s: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : undefined; // rejects 2026-02-31
}

export function parseExpiry(s: string, now: Date): string | undefined {
  if (s === 'never') return undefined;
  const rel = /^(\d+)([dh])$/.exec(s);
  if (rel) return new Date(now.getTime() + +rel[1] * (rel[2] === 'd' ? DAY : 3600000)).toISOString();
  const d = parseDate(s);
  if (!d) throw new GaError(`invalid expiry "${s}": use 7d, 12h, YYYY-MM-DD or never`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();
}

export function parseSince(s: string, now: Date): string {
  const rel = /^(\d+)([my])$/.exec(s);
  if (rel) {
    const d = new Date(now.getFullYear(), now.getMonth() - (rel[2] === 'y' ? 12 : 1) * +rel[1], 1);
    // Clamp the day so 31 Mar - 1m is 28 Feb, not 3 Mar.
    d.setDate(Math.min(now.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return localDay(d);
  }
  const d = parseDate(s);
  if (!d) throw new GaError(`invalid since "${s}": use 12m, 2y or YYYY-MM-DD`);
  return localDay(d);
}

export function createShare(dir: string, opts: ShareOpts, now: Date = new Date()): { share: Share; token: string } {
  const doctor = opts.audience === 'doctor';
  const token = randomBytes(32).toString('base64url');
  const id = randomBytes(4).toString('hex');
  const expires = opts.expires !== undefined ? parseExpiry(opts.expires, now) : doctor ? parseExpiry('7d', now) : undefined;
  const share: Share = {
    id,
    label: opts.label,
    audience: opts.audience,
    groups: opts.groups ?? (doctor ? DOCTOR_GROUPS : 'all'),
    ...(opts.since && { since: opts.since }),
    ...(opts.until && { until: opts.until }),
    ...(expires && { expires }),
    layout: opts.layout ?? (doctor ? 'A' : 'B'),
    questionsPerDay: opts.questionsPerDay ?? 20,
    tokenHash: hash(token),
    patientId: opts.patientId,
    baseUrl: opts.baseUrl,
    created: now.toISOString(),
  };
  // Secret first: a share without a recoverable token would be unusable.
  saveSecret(dir, `share-${id}`, token);
  write(dir, [...read(dir), share]);
  return { share, token };
}

export const listShares = (dir: string): Share[] => read(dir);

export function findByToken(dir: string, token: string, now: Date = new Date()): Share | undefined {
  const h = hash(token);
  const s = read(dir).find((x) => x.tokenHash === h);
  if (!s || s.revoked || (s.expires && now.getTime() > Date.parse(s.expires))) return undefined;
  return s;
}

export function revokeShare(dir: string, id: string, now: Date = new Date()): Share {
  const all = read(dir);
  const s = all.find((x) => x.id === id);
  if (!s) throw new GaError(`no share ${id}`);
  s.revoked ??= now.toISOString();
  write(dir, all);
  return s;
}

export function tokenOf(dir: string, id: string): string {
  const t = loadSecret<string>(dir, `share-${id}`);
  if (!t) throw new GaError(`no token for share ${id}`);
  return t;
}

// Daily counters live in asked.json, not shares.json: the server never rewrites shares.json, so it cannot undo a CLI revoke.
const askedFile = (dir: string): string => join(dir, 'asked.json');
export function takeQuestion(dir: string, id: string, now: Date = new Date()): boolean {
  const s = read(dir).find((x) => x.id === id);
  if (!s) throw new GaError(`no share ${id}`);
  const all = (existsSync(askedFile(dir)) ? JSON.parse(readFileSync(askedFile(dir), 'utf8')) : {}) as Record<string, { day: string; n: number }>;
  const day = localDay(now);
  const n = all[id]?.day === day ? all[id].n : 0;
  if (n >= s.questionsPerDay) return false;
  all[id] = { day, n: n + 1 };
  writeAtomic(askedFile(dir), JSON.stringify(all, null, 2), 0o600);
  return true;
}
