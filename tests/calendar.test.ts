import { expect, test } from 'vitest';
import { toIcs } from '../src/calendar.ts';
import type { Item } from '../src/maintenance.ts';

const item = (topic: string, name: string, status: Item['status'], dueDate?: string): Item =>
  ({ topic, name, kind: 'screening', status, importance: 'high', evidence: [], ...(dueDate && { dueDate }) });

test('one all-day event per item with a due date that still applies, topic names only', () => {
  const ics = toIcs([
    item('colorectal', 'Colorectal cancer screening', 'done', '2027-02-01'),
    item('LIPID PANEL - YEARLY', 'LIPID PANEL - YEARLY', 'overdue', '2026-10-01'),
    item('aaa', 'AAA', 'not for you', '2027-01-01'),
    item('zoster', 'Zoster', 'postponed', '2027-03-01'),
    item('hiv', 'HIV', 'due'),
  ], new Date('2026-11-07T12:00:00Z'));
  expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  expect(ics).not.toMatch(/[^\r]\n/); // CRLF only
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  expect(ics).toContain('UID:colorectal@ga-server\r\nDTSTAMP:20261107T120000Z\r\nDTSTART;VALUE=DATE:20270201\r\nDTEND;VALUE=DATE:20270202\r\nSUMMARY:Colorectal cancer screening due');
  expect(ics).toContain('UID:LIPID-PANEL-YEARLY@ga-server');
  expect(ics).not.toMatch(/DESCRIPTION|AAA|Zoster|HIV/);
});

test('text is escaped and long lines are folded at 75 octets', () => {
  const ics = toIcs([item('x', `Pap, HPV; co-test\\ ${'long name '.repeat(10)}`, 'done', '2027-01-01')]);
  expect(ics).toContain('SUMMARY:Pap\\, HPV\\; co-test\\\\ ');
  for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  expect(ics.split('\r\n').some((l) => l.startsWith(' '))).toBe(true);
});
