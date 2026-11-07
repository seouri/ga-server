// Calendar feed (spec Part 3): one secret link per install, an iCalendar file of health maintenance due dates. Topic names only, no clinical detail.
import { createHash, randomBytes } from 'node:crypto';
import { readJson, writeJson } from './gateway/store.ts';
import type { Item } from './maintenance.ts';

const FILE = 'calendar.json';
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

// A new link replaces the old one, so a leaked link is fixed by making a new one.
export function newCalendarToken(dir: string, now = new Date()): string {
  const token = randomBytes(32).toString('base64url');
  writeJson(dir, FILE, { tokenHash: hash(token), created: now.toISOString() });
  return token;
}
export const revokeCalendar = (dir: string): void => writeJson(dir, FILE, {});
export const calendarValid = (dir: string, token: string): boolean => {
  const h = readJson<{ tokenHash?: string }>(dir, FILE, {}).tokenHash;
  return !!h && h === hash(token);
};

// RFC 5545: escape text, CRLF line ends, fold lines over 75 octets.
const text = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
const fold = (line: string): string => {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  return [...out, cur].join('\r\n ');
};
const day = (d: string) => d.replaceAll('-', '');

// One all-day event per item with a due date that still applies; the UID is stable per topic, so a moved date updates the event.
export function toIcs(items: Item[], now = new Date()): string {
  const stamp = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const events = items.filter((i) => i.dueDate && i.status !== 'not for you' && i.status !== 'postponed').flatMap((i) => {
    const next = new Date(Date.parse(`${i.dueDate}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    return ['BEGIN:VEVENT', `UID:${i.topic.replace(/[^A-Za-z0-9]+/g, '-')}@ga-server`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(i.dueDate!)}`,
      `DTEND;VALUE=DATE:${day(next)}`, `SUMMARY:${text(`${i.name} due`)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT'];
  });
  return [...['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GA//Health maintenance//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:GA health maintenance'], ...events, 'END:VCALENDAR']
    .map(fold).join('\r\n') + '\r\n';
}
