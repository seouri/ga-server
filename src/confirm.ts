import { randomBytes } from 'node:crypto';
import { GaError } from './config.ts';

// Mode C: the code goes back to the agent in the preview. Typed codes or passkey links plug in here later.
// shortcut: in memory, lost on restart (the agent just asks for a new preview).
type Kind = 'share' | 'enable' | 'followup';
const TTL_MS = 15 * 60_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const pending = new Map<string, { kind: Kind; payload: unknown; expires: number }>();

function newCode(): string {
  const code = Array.from(randomBytes(6), (b) => ALPHABET[b % 32]).join('');
  return pending.has(code) ? newCode() : code;
}

export function preview<T>(kind: Kind, payload: T, now = new Date()): { confirm: string; expiresAt: string } {
  for (const [code, e] of pending) if (e.expires <= now.getTime()) pending.delete(code);
  const confirm = newCode();
  const expires = now.getTime() + TTL_MS;
  pending.set(confirm, { kind, payload, expires });
  return { confirm, expiresAt: new Date(expires).toISOString() };
}

export function takeConfirmed<T>(kind: Kind, code: string, now = new Date()): T {
  const e = pending.get(code);
  if (!e || e.kind !== kind || e.expires <= now.getTime()) {
    throw new GaError('confirmation code unknown or expired; ask for a new preview');
  }
  pending.delete(code);
  return e.payload as T;
}
