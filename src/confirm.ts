import { randomBytes } from 'node:crypto';
import { GaError } from './config.ts';

// Two ways to confirm a preview. Over stdio the code goes back to the agent: the person sees every tool call there.
// Over a chat app the preview is a link to the gateway's owner-only /confirm/<code> page, which runs the action itself; the code never works in a tool call,
// so an instruction hidden in a document cannot make the agent confirm on its own.
// shortcut: in memory, lost on restart (the agent just asks for a new preview).
type Kind = 'share' | 'enable' | 'followup';
export type Done = { done: string; link?: string; qr?: string };
export type Page = { title: string; view: Record<string, unknown>; run: () => Promise<Done> };
const TTL_MS = 15 * 60_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const pending = new Map<string, { kind: Kind; payload: unknown; expires: number }>();
const links = new Map<string, Page & { expires: number }>();

function sweep(now: Date): void {
  for (const m of [pending, links]) for (const [code, e] of m) if (e.expires <= now.getTime()) m.delete(code);
}

function newCode(): string {
  const code = Array.from(randomBytes(6), (b) => ALPHABET[b % 32]).join('');
  return pending.has(code) ? newCode() : code;
}

export function preview<T>(kind: Kind, payload: T, now = new Date()): { confirm: string; expiresAt: string } {
  sweep(now);
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

// The link sits in a public URL, so its code is long.
export function previewLink(publicUrl: string, page: Page, now = new Date()): { confirmUrl: string; expiresAt: string } {
  sweep(now);
  const code = randomBytes(32).toString('base64url');
  const expires = now.getTime() + TTL_MS;
  links.set(code, { ...page, expires });
  return { confirmUrl: `${publicUrl}/confirm/${code}`, expiresAt: new Date(expires).toISOString() };
}

// Showing the page does not use the code (link previews); confirming does.
export function confirmPage(code: string, now = new Date()): Page | undefined {
  const e = links.get(code);
  return e && e.expires > now.getTime() ? e : undefined;
}

export function takeConfirmPage(code: string, now = new Date()): Page | undefined {
  const e = confirmPage(code, now);
  links.delete(code);
  return e;
}

export const CONFIRM_ON_PAGE =
  'Two steps: this call returns a preview and a confirmUrl. Show the preview and the link to the user; they review it and press Confirm on that page ' +
  '(signed in with their passkey). You cannot confirm it yourself.';
