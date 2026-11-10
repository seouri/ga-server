// Adult screenings against shipped USPSTF A, B and C recommendations (src/schedules/uspstf-screening.json).
// Pure: the caller hands in the person's records; every why, cost and grade comes from the rule file.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CodeableConcept, Resource } from '@medplum/fhirtypes';
import { trusted } from './concept-apply.ts';
import { isClinic, TAG } from './identity.ts';
import { addDays, addMonths, ageOn } from './vaccines.ts';

export type Topic = {
  id: string; name: string; grade: 'A' | 'B' | 'C'; source: string; published: string; ages: [number, number]; sex?: 'male' | 'female';
  riskBased?: string; doneBy: (Method & { years: number | null; minAge?: number })[]; history?: Method[]; why: string; cost: string; epic?: string[];
};
// text: any phrase whose every word is a whole word of the record's name (a trailing * matches a prefix); not: words that rule the name out.
type Method = { name: string; types: string[]; codes: string[]; text?: string[]; not?: string[]; clinic?: boolean }; // clinic: hospital sources only
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
// What the person told GA (postpone done) counts for a clinic-only method too: they say where it was done.
export const TOLD = 'you told GA';
const matches = (m: Method, f: Found) => m.types.includes(f.r.resourceType) && (!m.clinic || isClinic(f.r) || f.r.meta?.source === TOLD) && (m.codes.some((c) => f.codes.has(c))
  || (!!m.text?.some((p) => phrase(f, p)) && ![...NOT_DONE, ...(m.not ?? [])].some((p) => phrase(f, p))));
export const SOON_DAYS = 90; // "due soon" window, shared with the doctor's-plan dates in maintenance.ts
const NEVER = '9999-12-31'; // a once-in-a-lifetime test never falls due again

export function evaluateScreenings(rules: Rules, input: ScreenInput, asOf: string): GuidelineItem[] {
  const f = screenings(rules, input, asOf);
  input.records.forEach((r, i) => f.add(r, i));
  return f.result();
}

// What a record contributes, without the record.
type Hit = { date: string; by: string; order: number; years?: number | null; due?: string; source?: string; id?: string };

// evaluateScreenings as a fold, so a caller hands records over as pages arrive and keeps none: per topic the record that
// covers longest and, per history method, its first dated and first matching record. order: the record's place in the
// input (ties go to the earlier), so records may be added in any order.
export function screenings(rules: Rules, input: Omit<ScreenInput, 'records'>, asOf: string) {
  const day = asOf.slice(0, 10);
  const age = ageOn(input.birthDate, day);
  const best = new Map<string, Hit>();
  const history = new Map<string, { dated?: Hit; any?: Hit }[]>(rules.topics.map((t) => [t.id, (t.history ?? []).map(() => ({}))]));
  const first = (a: Hit | undefined, b: Hit) => (!a || b.order < a.order ? b : a);
  // Clinic records only: Apple Health readings never count (controller ruling); nothing after asOf.
  // A date before birth is a placeholder: never shown, and the record is no screening evidence (history still counts).
  const add = (rec: Resource, order: number) => {
    const r = rec as Rec;
    const date = dateOf(r);
    const apple = r.meta?.tag?.some((t) => t.system === TAG && t.code === 'src-apple-health');
    const status = r.status ?? r.verificationStatus?.coding?.[0]?.code ?? '';
    if (apple || date > day || NOT_EVIDENCE.has(status) || r.dataAbsentReason) return;
    const codings = trusted(r, r.code?.coding);
    // "HIV-1/2 Ag/Ab" reads as " HIV 1 2 Ag Ab ".
    const raw = ` ${[r.code?.text, ...codings.map((c) => c.display)].join(' ').replace(/[^A-Za-z0-9]+/g, ' ').trim()} `;
    const f: Found = { r, date: date >= input.birthDate ? date : '', codes: new Set(codings.map((c) => `${c.system}|${c.code}`)), name: raw.toLowerCase(), raw };
    for (const t of rules.topics) {
      t.history?.forEach((m, i) => {
        if (!matches(m, f)) return;
        const h = history.get(t.id)![i], hit = { date: f.date, by: m.name, order };
        h.any = first(h.any, hit);
        if (f.date) h.dated = first(h.dated, hit);
      });
      // Each record counts by its shortest matching interval; the record that keeps the person covered longest wins.
      if (!f.date) continue;
      const hits = t.doneBy.filter((d) => matches(d, f) && !(d.minAge && ageOn(input.birthDate, f.date) < d.minAge));
      if (!hits.length) continue;
      const d = hits.reduce((a, b) => ((a.years ?? Infinity) <= (b.years ?? Infinity) ? a : b));
      const due = d.years === null ? NEVER : addMonths(f.date, d.years * 12);
      const b = best.get(t.id);
      if (!b || due > b.due! || (due === b.due && (f.date > b.date || (f.date === b.date && order < b.order)))) {
        best.set(t.id, { due, date: f.date, by: d.name, years: d.years, order, ...(r.meta?.source && { source: basename(r.meta.source) }), ...(r.id && { id: `${r.resourceType}/${r.id}` }) });
      }
    }
  };

  const result = () => rules.topics.map((t) => {
    const out = (status: Status, reason: string, extra: Partial<GuidelineItem> = {}): GuidelineItem => ({
      topic: t.id, name: t.name, status, grade: t.grade, ...extra, reason, why: t.why, cost: t.cost,
      citation: `USPSTF recommendation statement, grade ${t.grade}, ${t.published}: ${t.source}`,
    });
    if (age < t.ages[0] || age > t.ages[1]) return out('not for you', `For ages ${t.ages[0]} to ${t.ages[1]}.`);
    const who = t.sex === 'female' ? 'women' : 'men';
    if (t.sex && !input.sex) return out('discuss', `The guideline is for ${who}; whether it applies to you is worth discussing with your doctor.`);
    if (t.sex && input.sex !== t.sex) return out('not for you', `For ${who}.`);
    const hs = history.get(t.id)!;
    const h = hs.find((x) => x.dated)?.dated ?? hs.find((x) => x.any)?.any; // a dated match first, then by method, then by record
    if (h) return out('discuss', `Your record shows ${h.by}${h.date ? ` on ${h.date}` : ''}; whether this screening still applies is worth discussing with your doctor.`);

    const b = best.get(t.id);
    const last = b && { date: b.date, by: b.by, ...(b.source && { source: b.source }), ...(b.id && { id: b.id }) };
    const dueDate = b && b.years !== null ? b.due : undefined;
    const seen = last ? ` Last ${last.by} on ${last.date}.` : '';

    if (t.grade === 'C') return out('discuss', `USPSTF grade C: worth discussing with your doctor.${seen}`, { ...(last && { last }) });
    let status: Status;
    let reason: string;
    if (!b) [status, reason] = ['due', `No ${[...new Set(t.doneBy.map((d) => d.name))].join(' or ')} on record.`];
    else if (!dueDate) [status, reason] = ['done', `${b.by} on ${b.date}; needed once.`];
    else if (dueDate < day) [status, reason] = ['overdue', `Last ${b.by} on ${b.date}; was due ${dueDate}.`];
    else [status, reason] = [dueDate <= addDays(day, SOON_DAYS) ? 'due soon' : 'done', `Last ${b.by} on ${b.date}; next due ${dueDate}.`];
    // GA cannot check the risk factor: only a current screening on record answers it.
    if (t.riskBased && status !== 'done' && status !== 'due soon') {
      return out('discuss', `For people with "${t.riskBased}" (the guideline's words); whether that applies to you is worth discussing with your doctor.${seen}`, { ...(last && { last }) });
    }
    return out(status, reason, { ...(dueDate && { dueDate }), ...(last && { last }) });
  });
  return { add, result };
}
