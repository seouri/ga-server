import { expect, test } from 'vitest';
import { toIcs } from '../src/calendar.ts';
import type { Item } from '../src/maintenance.ts';

const item = (topic: string, name: string, status: Item['status'], dueDate?: string, nextMention?: string | null): Item =>
  ({ topic, name, kind: 'screening', status, importance: 'high', evidence: [], ...(dueDate && { dueDate }), ...(nextMention !== undefined && { nextMention }) });
const ics = (items: Item[]) => toIcs(items, '2026-11-07', 'abc123', new Date('2026-11-07T12:00:00Z'));
const events = (s: string) => s.split('BEGIN:VEVENT').slice(1);

test('one all-day event per item still on the list, topic names only', () => {
  const s = ics([
    item('colorectal', 'Colorectal cancer screening', 'done', '2027-02-01'),
    item('aaa', 'AAA', 'not for you', '2027-01-01'),
    item('zoster', 'Zoster', 'postponed', '2027-03-01'),
    item('prostate', 'Prostate', 'discuss', '2027-03-01'), // eligibility still open: never "due"
    item('lung', 'Lung', 'done', '2027-04-01', null), // dismissed
    item('partial', 'Partial', 'done', '2027'), // a partial date is skipped, not fatal
  ]);
  expect(s.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  expect(s.endsWith('END:VCALENDAR\r\n')).toBe(true);
  expect(s).not.toMatch(/[^\r]\n/); // CRLF only
  expect(events(s)).toHaveLength(1);
  expect(s).toMatch(/UID:[0-9a-f]{16}-abc123@ga-server\r\nDTSTAMP:20261107T120000Z\r\nDTSTART;VALUE=DATE:20270201\r\nDTEND;VALUE=DATE:20270202\r\nSUMMARY:GA: Colorectal cancer screening due/);
  expect(s).not.toMatch(/DESCRIPTION|AAA|Zoster|Prostate|Lung|Partial/);
});

test('an item put off until after today is left out until then', () => {
  expect(events(ics([item('a', 'Hep B', 'overdue', '2026-01-01', '2026-11-20')]))).toHaveLength(0);
  expect(events(ics([item('a', 'Hep B', 'overdue', '2026-01-01', '2026-11-07')]))).toHaveLength(1);
});

test('overdue items, and due items with no date, sit on today; UIDs differ per topic', () => {
  const s = ics([item('a', 'Hep B', 'overdue', '2026-01-01'), item('b', 'Hep-B', 'overdue'), item('c', 'HIV', 'due')]);
  expect(events(s).map((e) => /DTSTART;VALUE=DATE:(\d+)/.exec(e)?.[1])).toEqual(['20261107', '20261107', '20261107']);
  expect(s).toContain('SUMMARY:GA: Hep B overdue');
  expect(s).toContain('SUMMARY:GA: HIV due');
  expect(events(s)[0]).toContain('DTEND;VALUE=DATE:20261114'); // a week, so it stays visible until the next refresh
  expect(new Set(events(s).map((e) => /UID:(\S+)/.exec(e)?.[1])).size).toBe(3);
});

test('text is escaped and long lines are folded at 75 octets', () => {
  const s = ics([item('x', `Pap, HPV; co-test\\ ${'long name é '.repeat(10)}`, 'done', '2027-01-01')]);
  expect(s).toContain('SUMMARY:GA: Pap\\, HPV\\; co-test\\\\ ');
  for (const line of s.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  expect(s.split('\r\n').some((l) => l.startsWith(' '))).toBe(true);
});
