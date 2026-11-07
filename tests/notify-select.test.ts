import { describe, expect, it } from 'vitest';
import { digestTime, dueToSend, inSleep, newResults } from '../src/notify/select.ts';
import type { Item } from '../src/maintenance.ts';
import type { ReviewItem } from '../src/whats-new.ts';

const at = (h: number, m = 0) => new Date(2026, 10, 7, h, m);
const lab = (id: string, date: string, kind: ReviewItem['kind'] = 'lab'): ReviewItem => ({ kind, title: 'LDL', date, detail: { flag: 'high' }, id });
const item = (o: Partial<Item> = {}): Item => ({ topic: 't', name: 'T', kind: 'screening', status: 'overdue', importance: 'high', evidence: [], ...o });

describe('notify select', () => {
  it('inSleep', () => {
    const w: [string, string] = ['22:00', '07:00'];
    expect([at(23, 30), at(3), at(7), at(21, 59)].map((d) => inSleep(d, w))).toEqual([true, true, false, false]);
    expect(inSleep(at(13, 30), ['13:00', '14:00'])).toBe(true);
    expect(inSleep(at(10), ['07:00', '07:00'])).toBe(false);
  });
  it('digestTime', () => {
    expect(digestTime(at(8, 59), '09:00')).toBe(false);
    expect(digestTime(at(9), '09:00')).toBe(true);
    expect(digestTime(at(9), '09:00', '2026-11-07')).toBe(false);
  });
  it('newResults', () => {
    const r = newResults([lab('a', '2026-09-28'), lab('b', '2026-11-04'), lab('c', '2026-11-04', 'new medication'), lab('d', '2026-11-04')], { sentResults: { d: 'x' }, sentTopics: {} }, '2026-11-07');
    expect(r.map((i) => i.id)).toEqual(['b']);
  });
  it('dueToSend', () => {
    const s = (d: string) => ({ sentResults: {}, sentTopics: { t: d } });
    expect(dueToSend([item()], s('2026-10-28'), '2026-11-07')).toEqual([]);
    expect(dueToSend([item()], s('2026-10-24'), '2026-11-07')).toHaveLength(1);
    expect(dueToSend([item({ nextMention: '2026-12-01' })], s('2026-01-01'), '2026-11-07')).toEqual([]);
  });
});
