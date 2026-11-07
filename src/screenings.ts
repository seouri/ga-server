// Adult screenings against shipped USPSTF A, B and C recommendations (src/schedules/uspstf-screening.json).
// Pure: the caller hands in the person's records; every why, cost and grade comes from the rule file.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CodeableConcept, Resource } from '@medplum/fhirtypes';
import { trusted } from './concept-apply.ts';
import { TAG } from './identity.ts';
import { addDays, addMonths, ageOn } from './vaccines.ts';

export type Topic = {
  id: string; name: string; grade: 'A' | 'B' | 'C'; source: string; published: string; ages: [number, number]; sex?: 'male' | 'female';
  riskBased?: string; doneBy: (Method & { years: number | null; minAge?: number })[]; history?: Method[]; why: string; cost: string; epic?: string[];
};
// text: any phrase whose every word is a whole word of the record's name (a trailing * matches a prefix); not: words that rule the name out.
type Method = { name: string; types: string[]; codes: string[]; text?: string[]; not?: string[] };
export type Rules = { edition: string; topics: Topic[] };
export type ScreenInput = { birthDate: string; sex?: 'male' | 'female'; records: Resource[] };
export type Status = 'done' | 'due soon' | 'due' | 'overdue' | 'postponed' | 'not for you' | 'discuss';
export type GuidelineItem = {
  topic: string; name: string; status: Status; grade: string; dueDate?: string; last?: { date: string; by: string; source?: string; id?: string };
  reason: string; why: string; cost: string; citation: string;
};

export const loadRules = (): Rules => JSON.parse(readFileSync(join(import.meta.dirname, 'schedules', 'uspstf-screening.json'), 'utf8')) as Rules;

type Rec = Resource & {
  status?: string; code?: CodeableConcept; dataAbsentReason?: CodeableConcept; verificationStatus?: CodeableConcept; performedDateTime?: string; performedPeriod?: { start?: string };
  effectiveDateTime?: string; effectivePeriod?: { start?: string }; onsetDateTime?: string; recordedDate?: string;
};
const NOT_EVIDENCE = new Set(['not-done', 'stopped', 'entered-in-error', 'cancelled', 'preparation', 'registered', 'refuted']);
const dateOf = (r: Rec) => (r.performedDateTime ?? r.performedPeriod?.start ?? r.effectiveDateTime ?? r.effectivePeriod?.start ?? r.onsetDateTime ?? r.recordedDate ?? '').slice(0, 10);
type Found = { r: Rec; date: string; codes: Set<string>; name: string; raw: string };
// A rule word with capitals ("FIT") must appear in those capitals; any other word ignores case.
const word = (f: Found, w: string) => (w === w.toLowerCase() ? f.name : f.raw).includes(w.endsWith('*') ? ` ${w.slice(0, -1)}` : ` ${w} `);
const phrase = (f: Found, p: string) => p.split(' ').every((w) => word(f, w));
// Names of an order, a refusal or a conversation, not of a test done: never evidence for any topic. Not bare "risk" ("HPV, high risk").
const NOT_DONE = ['refus*', 'declin*', 'not performed', 'not done', 'order*', 'discuss*', 'defer*', 'offer*', 'counsel*', 'referral',
  'risk assessment', 'risk factor*', 'education', 'reminder', 'due', 'overdue', 'scheduled', 'cancel*'];
const matches = (m: Method, f: Found) => m.types.includes(f.r.resourceType) && (m.codes.some((c) => f.codes.has(c))
  || (!!m.text?.some((p) => phrase(f, p)) && ![...NOT_DONE, ...(m.not ?? [])].some((p) => phrase(f, p))));
export const SOON_DAYS = 90; // "due soon" window, shared with the doctor's-plan dates in maintenance.ts
const NEVER = '9999-12-31'; // a once-in-a-lifetime test never falls due again

export function evaluateScreenings(rules: Rules, input: ScreenInput, asOf: string): GuidelineItem[] {
  const day = asOf.slice(0, 10);
  const age = ageOn(input.birthDate, day);
  // Clinic records only: Apple Health readings never count (controller ruling); nothing after asOf.
  // A date before birth is a placeholder: never shown, and the record is no screening evidence (history still counts).
  const all = (input.records as Rec[]).flatMap((r) => {
    const date = dateOf(r);
    const apple = r.meta?.tag?.some((t) => t.system === TAG && t.code === 'src-apple-health');
    const status = r.status ?? r.verificationStatus?.coding?.[0]?.code ?? '';
    if (apple || date > day || NOT_EVIDENCE.has(status) || r.dataAbsentReason) return [];
    const codings = trusted(r, r.code?.coding);
    // "HIV-1/2 Ag/Ab" reads as " HIV 1 2 Ag Ab ".
    const raw = ` ${[r.code?.text, ...codings.map((c) => c.display)].join(' ').replace(/[^A-Za-z0-9]+/g, ' ').trim()} `;
    return [{ r, date: date >= input.birthDate ? date : '', codes: new Set(codings.map((c) => `${c.system}|${c.code}`)), name: raw.toLowerCase(), raw } as Found];
  });
  const records = all.filter((f) => f.date);

  return rules.topics.map((t) => {
    const out = (status: Status, reason: string, extra: Partial<GuidelineItem> = {}): GuidelineItem => ({
      topic: t.id, name: t.name, status, grade: t.grade, ...extra, reason, why: t.why, cost: t.cost,
      citation: `USPSTF recommendation statement, grade ${t.grade}, ${t.published}: ${t.source}`,
    });
    if (age < t.ages[0] || age > t.ages[1]) return out('not for you', `For ages ${t.ages[0]} to ${t.ages[1]}.`);
    const who = t.sex === 'female' ? 'women' : 'men';
    if (t.sex && !input.sex) return out('discuss', `The guideline is for ${who}; whether it applies to you is worth discussing with your doctor.`);
    if (t.sex && input.sex !== t.sex) return out('not for you', `For ${who}.`);
    const h = t.history?.flatMap((m) => all.filter((f) => matches(m, f)).map((f) => ({ ...f, by: m.name }))).sort((x, y) => (y.date ? 1 : 0) - (x.date ? 1 : 0))[0]; // a dated match first
    if (h) return out('discuss', `Your record shows ${h.by}${h.date ? ` on ${h.date}` : ''}; whether this screening still applies is worth discussing with your doctor.`);

    // Each record counts by its shortest matching interval; the record that keeps the person covered longest wins.
    let best: { due: string; date: string; by: string; years: number | null; r: Rec } | undefined;
    for (const m of records) {
      const hits = t.doneBy.filter((d) => matches(d, m) && !(d.minAge && ageOn(input.birthDate, m.date) < d.minAge));
      if (!hits.length) continue;
      const d = hits.reduce((a, b) => ((a.years ?? Infinity) <= (b.years ?? Infinity) ? a : b));
      const due = d.years === null ? NEVER : addMonths(m.date, d.years * 12);
      if (!best || due > best.due || (due === best.due && m.date > best.date)) best = { due, date: m.date, by: d.name, years: d.years, r: m.r };
    }
    const last = best && { date: best.date, by: best.by, ...(best.r.meta?.source && { source: basename(best.r.meta.source) }), ...(best.r.id && { id: `${best.r.resourceType}/${best.r.id}` }) };
    const dueDate = best && best.years !== null ? best.due : undefined;
    const seen = last ? ` Last ${last.by} on ${last.date}.` : '';

    if (t.grade === 'C') return out('discuss', `USPSTF grade C: worth discussing with your doctor.${seen}`, { ...(last && { last }) });
    let status: Status;
    let reason: string;
    if (!best) [status, reason] = ['due', `No ${[...new Set(t.doneBy.map((d) => d.name))].join(' or ')} on record.`];
    else if (!dueDate) [status, reason] = ['done', `${best.by} on ${best.date}; needed once.`];
    else if (dueDate < day) [status, reason] = ['overdue', `Last ${best.by} on ${best.date}; was due ${dueDate}.`];
    else [status, reason] = [dueDate <= addDays(day, SOON_DAYS) ? 'due soon' : 'done', `Last ${best.by} on ${best.date}; next due ${dueDate}.`];
    // GA cannot check the risk factor: only a current screening on record answers it.
    if (t.riskBased && status !== 'done' && status !== 'due soon') {
      return out('discuss', `For people with "${t.riskBased}" (the guideline's words); whether that applies to you is worth discussing with your doctor.${seen}`, { ...(last && { last }) });
    }
    return out(status, reason, { ...(dueDate && { dueDate }), ...(last && { last }) });
  });
}
