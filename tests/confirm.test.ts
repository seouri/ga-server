import { describe, expect, it } from 'vitest';
import { findConfirmPage, preview, previewLink, takeConfirmPage, takeConfirmed } from '../src/confirm.ts';

const t0 = new Date('2026-11-06T12:00:00Z');

describe('confirm', () => {
  it('round trips the payload', () => {
    const p = preview('share', { a: 1 }, t0);
    expect(p.confirm).toMatch(/^[A-Z2-7]{6}$/);
    expect(p.expiresAt).toBe('2026-11-06T12:15:00.000Z');
    expect(takeConfirmed('share', p.confirm, t0)).toEqual({ a: 1 });
  });
  it('is single use', () => {
    const p = preview('enable', 1, t0);
    takeConfirmed('enable', p.confirm, t0);
    expect(() => takeConfirmed('enable', p.confirm, t0)).toThrow('confirmation code unknown or expired');
  });
  it('rejects the wrong kind and keeps the code usable', () => {
    const p = preview('share', 1, t0);
    expect(() => takeConfirmed('enable', p.confirm, t0)).toThrow('unknown or expired');
    expect(takeConfirmed('share', p.confirm, t0)).toBe(1);
  });
  it('expires after 15 minutes', () => {
    const p = preview('share', 1, t0);
    expect(() => takeConfirmed('share', p.confirm, new Date(t0.getTime() + 15 * 60_000))).toThrow('unknown or expired');
  });
  it('gives distinct codes', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => preview('share', 0, t0).confirm));
    expect(codes.size).toBe(1000);
  });
  it('a link preview: long code in the URL, unusable as a tool code, shown without use, taken once', async () => {
    const page = { title: 't', view: { a: 1 }, run: async () => ({ done: 'ok' }) };
    const p = previewLink('https://x.example', page, t0);
    const code = /^https:\/\/x\.example\/confirm\/([A-Za-z0-9_-]{43})$/.exec(p.confirmUrl)![1];
    for (const k of ['share', 'enable', 'followup'] as const) expect(() => takeConfirmed(k, code, t0)).toThrow('unknown or expired');
    expect(findConfirmPage(code, t0)?.view).toEqual({ a: 1 });
    expect(findConfirmPage(code, t0)).toBeDefined();
    expect(await takeConfirmPage(code, t0)!.run()).toEqual({ done: 'ok' });
    expect(takeConfirmPage(code, t0)).toBeUndefined();
    const q = previewLink('https://x.example', page, t0);
    expect(findConfirmPage(q.confirmUrl.split('/').pop()!, new Date(t0.getTime() + 15 * 60_000))).toBeUndefined();
  });
});
