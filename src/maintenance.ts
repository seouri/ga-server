// Health maintenance list: guideline screenings, vaccines, Epic's plan and the person's reminders merged into Items; healthMaintenance loads them.
import type { MedplumClient } from '@medplum/core';
import type { Basic, Extension, Observation, Patient, Resource, ResourceType } from '@medplum/fhirtypes';
import { eachObservation, eachPage, searchAll } from './labs.ts';
import { GaError } from './config.ts';
import { loadRules, screenings, SOON_DAYS, TOLD } from './screenings.ts';
import { SRC_DATE } from './identity.ts';
import type { GuidelineItem, Rules, Status } from './screenings.ts';
import { addDays, addMonths, type Evidence, immunityOf, loadSchedule, vaccineGaps } from './vaccines.ts';

export const REMINDER = 'urn:ga-server:reminder'; // Basic.code system; codes not-now, postpone, dismiss, done, followup
const X = { topic: 'urn:ga-server:ext:topic', until: 'urn:ga-server:ext:until', due: 'urn:ga-server:ext:due', quote: 'urn:ga-server:ext:quote', doneDate: 'urn:ga-server:ext:done-date', method: 'urn:ga-server:ext:method', where: 'urn:ga-server:ext:where' };
export const fullDay = (d: string) => `${d}${'-01-01'.slice(d.length - 4)}`; // 'YYYY' and 'YYYY-MM' count from their first day

export type Plan = { topic?: string; due?: string; status?: string; asOf: string; from: 'epic' | 'agent'; source?: string; id?: string; quote?: string; last?: string };
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
    const asOf = val(o.extension?.find((e) => e.url === SRC_DATE));
    const last = o.component?.find((c) => c.code?.text === 'Last completed date')?.valueDateTime?.slice(0, 10);
    // a date on or before birth is a placeholder (Epic uses the birth date); so is a "Not Due" date on or before the export
    const due = next && !(birthDate && next <= birthDate) && !(/^not due$/i.test(o.valueString ?? '') && next <= asOf) ? next : undefined;
    return [{ topic: cleanName(t.slice(P.length)), asOf, from: 'epic', ...(due && { due }), ...(last && { last }), ...(o.valueString && { status: o.valueString }), ...(o.id && { id: `Observation/${o.id}` }) } as Plan];
  });
}

const ORDER: Status[] = ['overdue', 'due', 'due soon', 'discuss', 'postponed', 'done', 'not for you'];
const RANK: Importance[] = ['high', 'medium', 'low'];
export const DAYS: Record<Importance, number> = { high: 14, medium: 60, low: 365 };

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
    if (plan.last && !item.evidence.some((e) => e.date === plan.last)) item.evidence.push({ date: plan.last, by: "completed (doctor's plan)", ...(plan.id && { id: plan.id }) });
    if (!item.doctorsPlan || (when(plan) && (!when(item.doctorsPlan) || when(plan)! < when(item.doctorsPlan)!))) item.doctorsPlan = plan;
  }

  // A done reminder clears a plan written on or before the day the person told GA; the plan stays visible but no longer drives status or dueDate.
  const doneAt = (i: Item) => reminders.filter((b) => b.code?.coding?.[0]?.code === 'done' && cleanName(text(b.extension?.find((e) => e.url === X.topic)) ?? '').toLowerCase() === i.topic.toLowerCase())
    .map((b) => (b.created ?? '').slice(0, 10)).sort().pop();
  const out = items.flatMap((i) => {
    const cleared = !!i.doctorsPlan && i.doctorsPlan.asOf <= (doneAt(i) ?? '');
    if (cleared && i.kind === 'follow-up') i.nextMention = null;
    const p = cleared ? undefined : i.doctorsPlan;
    // Epic's "Aged Out" says not for you: it changes nothing on a joined item and a follow-up of its own is dropped.
    if (!p || p.status?.toLowerCase() === 'aged out') return i.status === 'not for you' || (i.kind === 'follow-up' && !cleared) ? [] : [i];
    const dueDate = [i.guideline?.dueDate, p.due].filter(Boolean).sort()[0];
    if (dueDate) i.dueDate = dueDate;
    // By date, or overdue when Epic says so without a date; the dateless guideline status below keeps its meaning.
    const ds: Status | undefined = !p.due && p.status?.toLowerCase() === 'overdue' ? 'overdue' : !p.due && /^due/i.test(p.status ?? '') ? 'due'
      : dueDate ? (dueDate < day ? 'overdue' : dueDate <= addDays(day, SOON_DAYS) ? 'due soon' : 'done') : undefined;
    const base = i.status;
    if (base === 'due' || base === 'overdue') i.status = ds === 'overdue' ? 'overdue' : base;
    else if (base === 'discuss') i.status = ds === 'overdue' || ds === 'due soon' ? ds : 'discuss'; // an Epic "Due" does not settle an eligibility question
    // An undated Epic Overdue/Due only says Epic has no completion on file; a dated record GA holds that keeps the guideline current wins.
    else if (!p.due && i.evidence.length && (base === 'done' || base === 'due soon')) i.status = base;
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
    const when = (x: Basic) => `${x.created ?? ''}|${x.meta?.lastUpdated ?? ''}`; // created is a date: the save time breaks same-day ties
    if (!newest.has(topic) || when(b) > when(newest.get(topic)!)) newest.set(topic, b);
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
  const ref = `Patient/${patientId}`;
  const rules = loadRules();
  const screen = screenings(rules, { birthDate: p.birthDate, sex }, asOf);
  // Records are folded as their pages arrive and dropped. Their place in [procedures, reports, evidence, conditions, told] (type,
  // then page order) breaks ties, as when they were one array.
  const seq = [0, 0, 0, 0, 0];
  const fold = (type: number) => (page: Resource[]) => { for (const r of page) screen.add(r, type * 2 ** 32 + seq[type]++); };
  const each = (type: ResourceType, n: number) => eachPage(client, type, { subject: ref }, fold(n));
  const immunity: Evidence[] = [];
  const schedule = loadSchedule();
  // One read of the non-Apple Observations (Apple readings are numerous and never evidence) serves screening evidence and vaccine immunity.
  const hmP = searchAll(client, 'Observation', { subject: ref, 'code:text': 'Health maintenance' }) as Promise<Observation[]>;
  const observations = hmP.then((hm) => {
    const planIds = new Set(hm.map((o) => o.id));
    const evidence = fold(2);
    const page = (os: Observation[]) => {
      evidence(os.filter((o) => !planIds.has(o.id) && (!o.category?.length || o.category.some((c) => c.coding?.some((k) => k.code === 'laboratory' || k.code === 'vital-signs')))));
      for (const o of os) { const e = immunityOf(o, schedule); if (e) immunity.push(e); }
    };
    return eachObservation(client, patientId, page);
  });
  const [hm, basics] = await Promise.all([
    hmP, searchAll(client, 'Basic', { subject: ref, code: `${REMINDER}|` }) as Promise<Basic[]>,
    each('Procedure', 0), each('DiagnosticReport', 1), observations, each('Condition', 3),
  ]);
  const vaccines = await vaccineGaps(client, patientId, asOf, immunity);
  // "I already did this" (done) for a screening becomes a record the rule's own text match and interval read.
  fold(4)(basics.flatMap((b): Resource[] => {
    const get = (url: string) => b.extension?.find((e) => e.url === url)?.valueString;
    const method = get(X.method), date = get(X.doneDate);
    const t = rules.topics.find((x) => x.id === get(X.topic)?.toLowerCase());
    if (b.code?.coding?.[0]?.code !== 'done' || !method || !date || !t) return [];
    const type = t.doneBy.find((d) => d.name === method)?.types[0] ?? 'Procedure';
    return [{ resourceType: type, id: b.id, status: type === 'Procedure' ? 'completed' : 'final', code: { text: method }, meta: { source: TOLD },
      ...(type === 'Procedure' ? { performedDateTime: fullDay(date) } : { effectiveDateTime: fullDay(date) }) } as unknown as Resource];
  }));
  const guideline = screen.result();
  for (const g of guideline) if (g.last?.source === TOLD && g.last.id) g.last.id = g.last.id.replace(/^\w+\//, 'Basic/'); // the synthetic record is the Basic
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
