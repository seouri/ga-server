import { DAYS, raiseNow, type Item } from '../maintenance.ts';
import { addDays } from '../vaccines.ts';
import type { ReviewItem } from '../whats-new.ts';
import type { State } from './settings.ts';

const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Local time. A window that crosses midnight (22:00-07:00) is start <= t || t < end; equal ends mean no sleep.
export function inSleep(now: Date, [start, end]: [string, string]): boolean {
  const t = now.getHours() * 60 + now.getMinutes(), s = mins(start), e = mins(end);
  return s === e ? false : s < e ? t >= s && t < e : t >= s || t < e;
}

export const digestTime = (now: Date, digestAt: string, lastDigestDay?: string): boolean =>
  now.getHours() * 60 + now.getMinutes() >= mins(digestAt) && lastDigestDay !== now.toLocaleDateString('en-CA');

export const newResults = (items: ReviewItem[], state: State, asOf: string): ReviewItem[] =>
  items.filter((i) => i.kind === 'lab' && i.date && i.date >= addDays(asOf, -30) && !(i.id && state.sentResults[i.id]));

export const dueToSend = (items: Item[], state: State, asOf: string): Item[] =>
  items.filter((i) => raiseNow(i, asOf) && (!state.sentTopics[i.topic] || addDays(state.sentTopics[i.topic], DAYS[i.importance]) <= asOf));
