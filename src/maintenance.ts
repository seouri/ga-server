// Health maintenance list: guideline screenings, vaccines, Epic's plan and the person's reminders merged into Items; healthMaintenance loads them.
import type { MedplumClient } from '@medplum/core';
import type { Basic, Condition, Extension, Observation, Patient, Resource, ResourceType } from '@medplum/fhirtypes';
import { searchAll } from './labs.ts';
import { GaError } from './config.ts';
import { evaluateScreenings, loadRules, SOON_DAYS } from './screenings.ts';
import { SRC_DATE, TAG } from './identity.ts';
import type { GuidelineItem, Rules, Status } from './screenings.ts';
import { addDays, addMonths, loadSchedule, vaccineGaps } from './vaccines.ts';

export const REMINDER = 'urn:ga-server:reminder'; // Basic.code system; codes not-now, postpone, dismiss, followup
const X = { topic: 'urn:ga-server:ext:topic', until: 'urn:ga-server:ext:until', due: 'urn:ga-server:ext:due', quote: 'urn:ga-server:ext:quote' };

export type Plan = { topic?: string; due?: string; status?: string; asOf: string; from: 'epic' | 'agent'; source?: string; id?: string; quote?: string };
type Importance = 'high' | 'medium' | 'low';
export type Item = {
  topic: string; name: string; kind: 'screening' | 'vaccine' | 'follow-up'; status: Status; importance: Importance; dueDate?: string;
  guideline?: { dueDate?: string; grade?: string; citation: string; reason: string }; doctorsPlan?: Plan;
  evidence: { date: string; by: string; source?: string; id?: string }[]; why?: string; cost?: string; nextMention?: string | null;
};

// Epic topic names (upper-case substrings) per CDC vaccine id; Haemophilus influenzae is not flu.
const VACCINE_EPIC: Record<string, string[]> = {
  zoster: ['ZOSTER'], 'covid-19': ['COVID'], influenza: ['FLU', 'INFLUENZA VACCINE'], 'td-tdap': ['TDAP', 'TD VACCINE'], pneumococcal: ['PNEUMOCOCCAL'],
  'hepatitis-a': ['HEPATITIS A VACCINE'], 'hepatitis-b': ['HEPATITIS B VACCINE'], hpv: ['HPV'], mmr: ['MMR'], varicella: ['VARICELLA'],
  meningococcal: ['MENINGOCOCCAL'], polio: ['POLIO'], rsv: ['RSV'],
};
// Whole-word match of an upper-case fragment in a topic name, punctuation as spaces; a plural last word counts.
const words = (s: string) => ` ${s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
const hasWord = (name: string, frag: string) => { const n = words(name), f = words(frag); return n.includes(f) || n.includes(`${f.trimEnd()}S `); };
// Epic marks some topics "* NAME", quotes a word, or appends a note to clinicians (': UPDATE W "EDIT MODIFIERS"', an Epic workflow step).
const cleanName = (t: string) => t.replace(/^\*\s*/, '').replace(/"/g, '').replace(/\s*:\s*UPDATE W\b.*$/i, '').trim();

const val = (e?: Extension) => (e?.valueDate ?? e?.valueDateTime ?? e?.valueString ?? '').slice(0, 10);
const text = (e?: Extension) => e?.valueString;

export function vaccineItems(v: Awaited<ReturnType<typeof vaccineGaps>>): Item[] {
  const map = { complete: 'done', immune: 'done', due: 'due', overdue: 'overdue', 'not-recommended': 'not for you', 'not-evaluated': 'discuss' } as const;
  const names = new Map(loadSchedule().vaccines.map((x) => [x.id, `${x.name} vaccine`]));
  return v.results.map((r): Item => {
    const status = map[r.status];
    const importance = status === 'overdue' && r.records.length ? 'high' : status === 'overdue' || status === 'due' ? 'medium' : 'low';
    return {
      topic: r.vaccine, name: names.get(r.vaccine) ?? r.vaccine, kind: 'vaccine', status, importance, why: r.reason,
      guideline: { citation: `CDC adult immunization schedule, ${v.edition}`, reason: r.reason },
      evidence: r.records.map((x) => ({ date: x.date, by: r.vaccine, source: x.source })),
    };
  });
}

export function epicPlans(hm: Observation[], birthDate?: string): Plan[] {
  const P = 'Health maintenance: ';
  return hm.flatMap((o) => {
    const t = o.code?.text;
    if (!t?.startsWith(P)) return [];
    const next = o.component?.find((c) => c.code?.text === 'Next due date')?.valueDateTime?.slice(0, 10);
    const due = next && !(birthDate && next < birthDate) ? next : undefined; // a date before birth is a placeholder
    const asOf = val(o.extension?.find((e) => e.url === SRC_DATE));
    return [{ topic: cleanName(t.slice(P.length)), asOf, from: 'epic', ...(due && { due }), ...(o.valueString && { status: o.valueString }), ...(o.id && { id: `Observation/${o.id}` }) } as Plan];
  });
}

const ORDER: Status[] = ['overdue', 'due', 'due soon', 'discuss', 'postponed', 'done', 'not for you'];
const RANK: Importance[] = ['high', 'medium', 'low'];
const DAYS: Record<Importance, number> = { high: 14, medium: 60, low: 365 };

export function combine(guideline: GuidelineItem[], vaccines: Item[], plans: Plan[], reminders: Basic[], rules: Rules, asOf: string): Item[] {
  const day = asOf.slice(0, 10);
  const items: Item[] = [
    ...guideline.map((g): Item => ({
      topic: g.topic, name: g.name, kind: 'screening', status: g.status, ...(g.dueDate && { dueDate: g.dueDate }), importance: g.grade === 'C' ? 'low' : 'high', why: g.why, cost: g.cost,
      guideline: { ...(g.dueDate && { dueDate: g.dueDate }), grade: g.grade, citation: g.citation, reason: g.reason },
      evidence: g.last ? [g.last] : [],
    })),
    ...vaccines,
  ];
  // A plan never revives a "not for you" item: it becomes a follow-up of its own.
  const byTopic = (name: string) => items.find((i) => i.kind !== 'follow-up' && i.status !== 'not for you' && (i.topic.toLowerCase() === name.toLowerCase()
    || (!hasWord(name, 'HAEMOPHILUS') && (VACCINE_EPIC[i.topic] ?? rules.topics.find((t) => t.id === i.topic)?.epic)?.some((e) => hasWord(name, e)))));

  const agent = reminders.filter((b) => b.code?.coding?.[0]?.code === 'followup').flatMap((b): Plan[] => {
    const topic = text(b.extension?.find((e) => e.url === X.topic));
    if (!topic) return [];
    const due = val(b.extension?.find((e) => e.url === X.due));
    const quote = text(b.extension?.find((e) => e.url === X.quote));
    return [{ topic: cleanName(topic), asOf: (b.created ?? '').slice(0, 10), from: 'agent', ...(due && { due }), ...(quote && { quote }) }];
  });
  // Several plans for one topic: the earliest is kept; an Epic "Overdue" without a date counts as earliest, so a dated plan never hides it.
  // An undated "Due" ranks as today, after an undated Overdue and before any later date.
  const when = (x: Plan) => x.due ?? (x.status?.toLowerCase() === 'overdue' ? '0000-00-00' : /^due/i.test(x.status ?? '') ? day : undefined);
  for (const plan of [...plans, ...agent]) {
    const topic = plan.topic ?? '';
    let item = byTopic(topic) ?? items.find((i) => i.kind === 'follow-up' && i.topic.toLowerCase() === topic.toLowerCase());
    if (!item) {
      item = { topic, name: topic, kind: 'follow-up', status: 'done', importance: 'medium', evidence: [] };
      items.push(item);
    }
    if (!item.doctorsPlan || (when(plan) && (!when(item.doctorsPlan) || when(plan)! < when(item.doctorsPlan)!))) item.doctorsPlan = plan;
  }

  const out = items.flatMap((i) => {
    const p = i.doctorsPlan;
    // Epic's "Aged Out" says not for you: it changes nothing on a joined item and a follow-up of its own is dropped.
    if (!p || p.status?.toLowerCase() === 'aged out') return i.status === 'not for you' || i.kind === 'follow-up' ? [] : [i];
    const dueDate = [i.guideline?.dueDate, p.due].filter(Boolean).sort()[0];
    if (dueDate) i.dueDate = dueDate;
    // By date, or overdue when Epic says so without a date; the dateless guideline status below keeps its meaning.
    const ds: Status | undefined = !p.due && p.status?.toLowerCase() === 'overdue' ? 'overdue' : !p.due && /^due/i.test(p.status ?? '') ? 'due'
      : dueDate ? (dueDate < day ? 'overdue' : dueDate <= addDays(day, SOON_DAYS) ? 'due soon' : 'done') : undefined;
    const base = i.status;
    if (base === 'due' || base === 'overdue') i.status = ds === 'overdue' ? 'overdue' : base;
    else if (base === 'discuss') i.status = ds === 'overdue' || ds === 'due soon' ? ds : 'discuss'; // an Epic "Due" does not settle an eligibility question
    else i.status = ds ?? base;
    if (i.kind === 'follow-up') i.importance = i.status === 'overdue' ? 'high' : 'medium';
    return [i];
  });

  // The newest reminder per topic wins.
  const newest = new Map<string, Basic>();
  for (const b of reminders) {
    const code = b.code?.coding?.[0]?.code;
    const topic = cleanName(text(b.extension?.find((e) => e.url === X.topic)) ?? '').toLowerCase();
    if (!topic || (code !== 'not-now' && code !== 'postpone' && code !== 'dismiss')) continue;
    if (!newest.has(topic) || (b.created ?? '') > (newest.get(topic)!.created ?? '')) newest.set(topic, b);
  }
  for (const i of out) {
    const b = newest.get(i.topic.toLowerCase());
    const code = b?.code?.coding?.[0]?.code;
    if (!b) continue;
    const until = val(b.extension?.find((e) => e.url === X.until));
    if (code === 'postpone' && until > day) [i.status, i.nextMention] = ['postponed', until];
    else if (code === 'not-now') i.nextMention = addDays((b.created ?? '').slice(0, 10), DAYS[i.importance]);
    else if (code === 'dismiss' && i.importance === 'low') i.nextMention = null;
  }

  return out.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || RANK.indexOf(a.importance) - RANK.indexOf(b.importance)
    || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
}

const NOTE = "Guideline items cite their source. The doctor's plan is shown as of its date. Not medical advice: input for a conversation with your clinician.";

export async function healthMaintenance(client: MedplumClient, patientId: string, asOf = new Date().toLocaleDateString('en-CA'), months?: number) {
  const p = await client.readResource('Patient', patientId) as Patient;
  if (!p.birthDate) throw new GaError('Patient has no birthDate in GA');
  const sex = p.gender === 'male' || p.gender === 'female' ? p.gender : undefined;
  const all = (type: ResourceType, q: Record<string, string>) => searchAll(client, type, q);
  const ref = `Patient/${patientId}`;
  // Apple Health readings are numerous and never evidence: leave them out of every Observation read (vaccineGaps does the same).
  const noApple = { '_tag:not': `${TAG}|src-apple-health` };
  const [procedures, reports, labs, uncategorised, hm, conditions, basics] = await Promise.all([
    all('Procedure', { subject: ref }), all('DiagnosticReport', { subject: ref }),
    all('Observation', { subject: ref, category: 'laboratory,vital-signs', ...noApple }), all('Observation', { subject: ref, 'category:missing': 'true', ...noApple }),
    all('Observation', { subject: ref, 'code:text': 'Health maintenance' }), all('Condition', { subject: ref }), all('Basic', { subject: ref, code: `${REMINDER}|` }),
  ]) as [Resource[], Resource[], Observation[], Observation[], Observation[], Condition[], Basic[]];
  const planIds = new Set(hm.map((o) => o.id));
  const evidence = [...new Map([...labs, ...uncategorised].map((o) => [o.id, o])).values()].filter((o) => !planIds.has(o.id));
  const rules = loadRules();
  const vaccines = await vaccineGaps(client, patientId, asOf);
  const guideline = evaluateScreenings(rules, { birthDate: p.birthDate, sex, records: [...procedures, ...reports, ...evidence, ...conditions] }, asOf);
  const items = combine(guideline, vaccineItems(vaccines), epicPlans(hm, p.birthDate), basics, rules, asOf);
  return { asOf, edition: rules.edition, items, upcoming: upcoming(items, asOf, months), byTheWay: byTheWay(items, asOf), note: NOTE };
}

// Worth raising now: overdue, due soon, or due with high or medium importance, and not held back by a postponement (nextMention null: never).
export const raiseNow = (i: Item, asOf: string): boolean =>
  (i.status === 'overdue' || i.status === 'due soon' || (i.status === 'due' && i.importance !== 'low')) && i.nextMention !== null && (!i.nextMention || i.nextMention <= asOf);

const monthYear = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// The one line an agent adds after answering (spec Part 3): the most important item to raise (items come sorted), plus a count of the rest.
export function byTheWay(items: Item[], asOf: string): { line: string; topic: string } | undefined {
  const [top, ...rest] = items.filter((i) => raiseNow(i, asOf));
  if (!top) return undefined;
  const when = top.status === 'overdue' ? `overdue${top.dueDate ? ` since ${monthYear(top.dueDate)}` : ''}` : top.status === 'due soon' && top.dueDate ? `due in ${monthYear(top.dueDate)}` : 'due';
  const more = rest.length ? `, plus ${rest.length} other item${rest.length > 1 ? 's' : ''}` : '';
  return { line: `By the way, ${top.name} is ${when}${more}. Want to review it now?`, topic: top.topic };
}

// Items with a due date after asOf and within `months`, soonest first.
export const upcoming = (items: Item[], asOf: string, months = 6) =>
  items.filter((i) => i.dueDate && i.dueDate > asOf && i.dueDate <= addMonths(asOf, months) && i.status !== 'postponed' && i.status !== 'not for you')
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
    .map(({ topic, name, dueDate, status, importance }) => ({ topic, name, dueDate, status, importance }));
