// Calendar feed (spec Part 3): one secret link per install, an iCalendar file of health maintenance due dates. Topic names only, no clinical detail.
import { createHash, randomBytes } from 'node:crypto';
import { readJson, writeJson } from './gateway/store.ts';
import type { Item } from './maintenance.ts';

const FILE = 'calendar.json';
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

type Stored = { tokenHash?: string; id?: string };
const stored = (dir: string) => readJson<Stored>(dir, FILE, {});
// id: this install's part of every event UID (RFC 5545 wants them globally unique), kept across new links so events update in place.
const idOf = (dir: string) => stored(dir).id ?? randomBytes(8).toString('hex');

// A new link replaces the old one, so a leaked link is fixed by making a new one.
export function newCalendarToken(dir: string): string {
  const token = randomBytes(32).toString('base64url');
  writeJson(dir, FILE, { tokenHash: hash(token), id: idOf(dir) });
  return token;
}
export const revokeCalendar = (dir: string): void => writeJson(dir, FILE, { id: idOf(dir) });
// The install id when the token is the live one, else undefined.
export const calendarFor = (dir: string, token: string): string | undefined => {
  const s = stored(dir);
  return s.tokenHash && s.tokenHash === hash(token) ? s.id : undefined;
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONABLE = new Set(['overdue', 'due', 'due soon', 'done']); // not discuss (eligibility open), postponed, not for you

// One all-day event per item still on the list (dismissed: never; "not now" or postponed: not before its nextMention, as raiseNow); overdue, and due with no date, span a week from asOf so they stay visible
// until the app's next refresh (hours to a day). A malformed date skips that item, never the feed.
export function toIcs(items: Item[], asOf: string, id: string, now = new Date()): string {
  const stamp = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const events = items.filter((i) => ACTIONABLE.has(i.status) && i.nextMention !== null && (!i.nextMention || i.nextMention <= asOf)).flatMap((i) => {
    const onToday = i.status === 'overdue' || (i.status === 'due' && !i.dueDate);
    const date = onToday ? asOf : i.dueDate;
    if (!date || !DAY.test(date)) return [];
    const end = new Date(Date.parse(`${date}T00:00:00Z`) + (onToday ? 7 : 1) * 864e5).toISOString().slice(0, 10);
    return ['BEGIN:VEVENT', `UID:${hash(i.topic).slice(0, 16)}-${id}@ga-server`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(date)}`,
      `DTEND;VALUE=DATE:${day(end)}`, `SUMMARY:${text(`GA: ${i.name} ${i.status === 'overdue' ? 'overdue' : 'due'}`)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT'];
  });
  return [...['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GA//Health maintenance//EN', 'CALSCALE:GREGORIAN', 'NAME:GA health maintenance', 'X-WR-CALNAME:GA health maintenance',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H'], ...events, 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}
