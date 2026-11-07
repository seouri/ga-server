import { describe, expect, it } from 'vitest';
import { digestMessage, resultMessage } from '../src/notify/compose.ts';
import type { Item } from '../src/maintenance.ts';
import type { ReviewItem } from '../src/whats-new.ts';

const lab = (title: string, previous?: object): ReviewItem => ({ kind: 'lab', title, date: '2026-11-04', source: 'Clinic', detail: { value: '190 mg/dL', range: '<100', flag: 'high', previous } });
const due = (n: number): Item => ({ topic: `t${n}`, name: `Screen ${n}`, kind: 'screening', status: 'overdue', importance: 'high', dueDate: '2026-10-01', why: 'Finds it early.', evidence: [], doctorsPlan: { quote: 'repeat in a year', asOf: '2026-01-01', from: 'agent' } });
const med: ReviewItem = { kind: 'new medication', title: 'Atorvastatin', detail: {} };

describe('notify compose', () => {
  it('resultMessage', () => {
    const m = resultMessage([lab('LDL', { date: '2026-05-01', value: '150 mg/dL' }), lab('A1c')]);
    const lines = m.split('\n');
    expect(lines[0]).toBe('GA: 2 new results');
    for (const s of ['LDL', '190 mg/dL', '<100', 'high', '2026-11-04', 'Clinic', '150 mg/dL', '2026-05-01']) expect(m).toContain(s);
    expect(lines.at(-1)).toBe('Reply with a question about it. Not medical advice.');
    expect(resultMessage([lab('LDL')]).split('\n')[0]).toBe('GA: 1 new result');
  });
  it('digestMessage', () => {
    const m = digestMessage([med], [due(1), due(2)], [{ drug: 'Atorvastatin', label: { status: 'ok' } }]);
    expect(m.split('\n')[0]).toBe('GA: 3 items for you');
    for (const s of ['Screen 1', 'overdue', '2026-10-01', 'Finds it early.', 'repeat in a year', 'Atorvastatin', 'From the FDA label; not a full interaction screen. Ask your pharmacist.']) expect(m).toContain(s);
    expect(m.endsWith('Reply "done" if you already had one, "not now", or ask a question. Not medical advice.')).toBe(true);
    expect(digestMessage([med], [])).not.toContain('FDA');
  });
  it('caps at 1500 chars keeping whole items', () => {
    const m = digestMessage([], Array.from({ length: 30 }, (_, i) => due(i)));
    expect(m.length).toBeLessThanOrEqual(1500);
    expect(m).toMatch(/…and \d+ more: ask GA\nReply "done"/);
    expect(m).toContain('Screen 0');
  });
});
