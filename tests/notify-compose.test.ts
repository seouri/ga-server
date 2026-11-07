import { describe, expect, it } from 'vitest';
import { digestMessage, resultMessage } from '../src/notify/compose.ts';
import type { Item } from '../src/maintenance.ts';
import type { ReviewItem } from '../src/whats-new.ts';

const lab = (title: string, previous?: object): ReviewItem => ({ kind: 'lab', title, date: '2026-11-04', source: 'Clinic', detail: { value: '190 mg/dL', range: '<100', flag: 'high', previous } });
const due = (n: number): Item => ({ topic: `t${n}`, name: `Screen ${n}`, kind: 'screening', status: 'overdue', importance: 'high', dueDate: '2026-10-01', why: 'Finds it early.', evidence: [], doctorsPlan: { quote: 'repeat in a year', asOf: '2026-01-01', from: 'agent' } });
const med: ReviewItem = { kind: 'new medication', title: 'Atorvastatin', detail: {} };

const NOW = new Date('2026-11-07T12:00:00');
const HINT = 'Reply a name for why and sources. Not medical advice.';

describe('notify compose', () => {
  it('resultMessage: one line per result', () => {
    expect(resultMessage([lab('LDL', { date: '2026-05-01', value: '150 mg/dL' }), lab('A1c')], NOW)).toBe([
      'GA: 2 new results', '',
      '• LDL: 190 mg/dL (high; range <100), Nov 4',
      '• A1c: 190 mg/dL (high; range <100), Nov 4', '',
      'Reply a name for details. Not medical advice.',
    ].join('\n'));
    expect(resultMessage([lab('LDL')], NOW).split('\n')[0]).toBe('GA: 1 new result');
  });
  it('digestMessage: headings and one line per item', () => {
    const d = (name: string, status: string, dueDate: string, plan = false): Item => ({ ...due(1), name, status, dueDate, doctorsPlan: plan ? due(1).doctorsPlan : undefined } as Item);
    const m = digestMessage([med], [d('COVID-19 vaccine', 'overdue', '2025-08-01'), d('Lipid recheck', 'due soon', '2026-12-15', true), d('Shingles vaccine, dose 2', 'due', '2026-12-29')], [{ drug: 'Atorvastatin', label: { status: 'ok' } }], NOW);
    expect(m).toBe([
      'GA: 4 items for you', '',
      'New medications:', '• Atorvastatin: new (FDA label notes)',
      'Due:', '• COVID-19 vaccine: overdue since Aug 2025', "• Lipid recheck: due soon Dec 15 (doctor's plan)", '• Shingles vaccine, dose 2: due Dec 29', '',
      HINT,
    ].join('\n'));
    expect(digestMessage([med], [], [], NOW)).not.toContain('FDA');
  });
  it('+N more after 5 items', () => {
    const m = digestMessage([], Array.from({ length: 8 }, (_, i) => due(i)), [], NOW);
    expect(m).toBe(['GA: 8 items for you', '', 'Due:', ...[0, 1, 2, 3, 4].map((i) => `• Screen ${i}: overdue since Oct 1 (doctor's plan)`), '+3 more', '', HINT].join('\n'));
  });
});
