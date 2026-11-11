// whats_new: records that arrived since a time, counted by kind, and the "last seen" marker.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, CodeableConcept, Condition, Endpoint, Observation, Resource, ResourceType } from '@medplum/fhirtypes';
import { defaultConfigPath } from './config.ts';
import { isPlanned } from './current.ts';
import { arrivedAt, hasTag, TAG } from './identity.ts';
import { type LabelSections, drugLabel } from './drug-labels.ts';
import { eachObservation, eachPage, fit, highLow, isPanel, labRow, olderInGroup } from './labs.ts';
import { concept, listsByKind, medCode, medKeys, medMap } from './lists.ts';
import { writeAtomic } from './smart/store.ts';
import { healthMaintenance, raiseNow, type Item } from './maintenance.ts';
import { messageText, noteText, snippet } from './notes.ts';
import { hasCategory } from './share/scope.ts';
import { addDays } from './vaccines.ts';

export const SOURCES: [string, string][] = [['src-ccda', 'C-CDA'], ['src-ehi', 'Epic EHI export'], ['src-fhir-export', 'Epic FHIR export'], ['src-dicom', 'DICOM imaging'], ['src-apple-health', 'Apple Health'], ['src-apple-clinical', 'Apple Health (hospital records)'], ['src-pdf', 'PDF or photo']];

export type Kind = 'lab results' | 'vital signs' | 'Apple Health readings' | 'medications' | 'problems' | 'allergies' | 'vaccines' | 'procedures' | 'visits' | 'notes and messages' | 'other';

export function kindOf(r: Resource): Kind {
  switch (r.resourceType) {
    case 'Observation':
      if (hasTag(r, 'src-apple-health')) return 'Apple Health readings';
      if (isPanel(r)) return 'other'; // its members are the readings
      if (hasCategory(r, 'vital-signs')) return 'vital signs';
      // Uncategorised (older PDF imports) and AI-read results count as labs; social history, assessments and the like do not.
      return !r.category?.length || hasCategory(r, 'laboratory') || hasTag(r, 'extracted-by-llm') ? 'lab results' : 'other';
    case 'MedicationStatement': case 'MedicationRequest': return 'medications';
    case 'Condition': return 'problems';
    case 'AllergyIntolerance': return 'allergies';
    case 'Immunization': return 'vaccines';
    case 'Procedure': return 'procedures';
    case 'Encounter': return 'visits';
    case 'DocumentReference': case 'Communication': return 'notes and messages';
    default: return 'other';
  }
}

export function clinicalDate(r: Resource): string | undefined {
  const x = r as Record<string, any>; // shortcut: untyped field probe across resource types, fine while the list is fixed
  const d = x.effectiveDateTime ?? x.effectivePeriod?.start ?? x.effectiveInstant ?? x.occurrenceDateTime ?? x.occurrencePeriod?.start ?? x.performedDateTime ?? x.performedPeriod?.start ?? x.onsetDateTime
    ?? x.recordedDate ?? x.authoredOn ?? x.period?.start ?? x.date ?? x.sent ?? x.issued;
  return typeof d === 'string' ? d.slice(0, 10) : undefined;
}


export function tally(arrived: Resource[], asOf: string) {
  const t = tallier(asOf);
  arrived.forEach(t.add);
  return t.result();
}

// tally as a fold, so the arrivals need not be held.
function tallier(asOf: string) {
  const cutoff = addDays(asOf, -365);
  const byKind: Partial<Record<Kind, number>> = {};
  const sources = new Set<string>();
  let total = 0, historical = 0, noRangeGiven = 0;
  const add = (r: Resource) => {
    total++;
    const k = kindOf(r);
    byKind[k] = (byKind[k] ?? 0) + 1;
    const d = clinicalDate(r);
    if (d && d < cutoff) historical++;
    if (k === 'lab results' && r.resourceType === 'Observation' && !r.interpretation?.length && !r.referenceRange?.length) noRangeGiven++; // listed, never judged
    for (const [tag, label] of SOURCES) if (hasTag(r, tag)) sources.add(label);
    for (const i of [(r as { identifier?: { system?: string } | { system?: string }[] }).identifier ?? []].flat()) { // singular on QuestionnaireResponse
      if (i.system?.startsWith('urn:ga-server:id:smart:')) sources.add(i.system.slice('urn:ga-server:id:smart:'.length));
    }
  };
  return { add, result: () => ({ total, historical, noRangeGiven, byKind, sources: [...sources] }) };
}

// Types the engine creates, with their patient search parameter.
const TYPES: [Resource['resourceType'], 'subject' | 'patient'][] = [
  ['Observation', 'subject'], ['Condition', 'subject'], ['MedicationStatement', 'subject'], ['MedicationRequest', 'subject'], ['AllergyIntolerance', 'patient'],
  ['Immunization', 'patient'], ['Procedure', 'subject'], ['Encounter', 'subject'], ['DocumentReference', 'subject'], ['Communication', 'subject'],
  ['DiagnosticReport', 'subject'], ['FamilyMemberHistory', 'patient'], ['QuestionnaireResponse', 'subject'],
];

// Records without the arrival extension predate tracking and are never returned.
// Apple Health readings are most records and only counted (tally reads these fields), so they come back as a subset.
const APPLE_FIELDS = 'meta,extension,identifier,effectiveDateTime,effectivePeriod,issued';
export async function arrivedSince(client: MedplumClient, patientId: string, since: string): Promise<Resource[]> {
  const out: Resource[] = [];
  await eachArrived(client, patientId, since, (rs) => out.push(...rs));
  return out;
}

// arrivedSince page by page, in the same order: one type after another.
async function eachArrived(client: MedplumClient, patientId: string, since: string, page: (rs: Resource[]) => void): Promise<void> {
  const apple = `${TAG}|src-apple-health`;
  for (const [type, param] of TYPES) {
    // Notes and messages can be large (tens of KB each): 100 per page keeps one page small (cursor paging needs >= 20).
    const base = { [param]: `Patient/${patientId}`, _lastUpdated: `ge${since}`, ...((type === 'DocumentReference' || type === 'Communication') && { _count: '100' }) };
    const qs = type === 'Observation' ? [{ ...base, '_tag:not': apple }, { ...base, _tag: apple, _elements: APPLE_FIELDS }] : [base];
    for (const q of qs) await eachPage(client, type as ResourceType, q, (rs) => page(rs.filter((r) => { const a = arrivedAt(r); return a !== undefined && a >= since; })));
  }
}

const lastSeenFile = (dir: string) => join(dir, 'whats-new.json');

export function readLastSeen(dir: string = dirname(defaultConfigPath())): string | undefined {
  const f = lastSeenFile(dir);
  if (!existsSync(f)) return undefined;
  try {
    const v = (JSON.parse(readFileSync(f, 'utf8')) as { lastSeen?: unknown } | null)?.lastSeen;
    return typeof v === 'string' ? v : undefined;
  } catch { return undefined; } // a bad file must not break whats_new
}

export function writeLastSeen(at: string, dir: string = dirname(defaultConfigPath())): void {
  writeAtomic(lastSeenFile(dir), JSON.stringify({ lastSeen: at }), 0o600);
}

export type ReviewItem = {
  kind: 'lab' | 'new medication' | 'medication status' | 'problem status' | 'note or message' | 'health maintenance';
  title: string; date?: string; detail: Record<string, unknown>; source?: string; id?: string;
};

// Each out-of-range result of `arrived` dated within a year, with the next older result of its group among allLabs.
export function labItems(arrived: Observation[], allLabs: Observation[], asOf: string): ReviewItem[] {
  const f = labFold(asOf);
  allLabs.forEach(f.add);
  return f.result().items(arrived.flatMap((o) => flagged(o, asOf) ?? []));
}

// An out-of-range result dated within a year, as its item needs it, without the resource.
type Flagged = { title: string; date: string; value?: string; range?: string; flag: string; source?: string; id?: string };
function flagged(o: Observation, asOf: string): Flagged | undefined {
  const flag = highLow(o), date = clinicalDate(o);
  if (!flag || !date || date < addDays(asOf, -365)) return undefined;
  const row = labRow(o);
  return { title: row.name ?? 'Lab result', date, value: row.value, range: row.range, flag, source: row.source, id: o.id };
}

// labItems as a fold over the labs as their pages arrive. recent: labItems(labs, labs); items(rs): labItems of those arrived.
function labFold(asOf: string) {
  const older = olderInGroup(addDays(asOf, -365));
  const recent: Flagged[] = [];
  const add = (o: Observation) => {
    const x = flagged(o, asOf);
    older.add(o, true); // every in-year id, so an arrived lab edited between the two scans still finds its group
    if (x) recent.push(x);
  };
  const result = () => {
    const prev = older.done();
    const items = (xs: Flagged[]) => xs.map(({ title, date, value, range, flag, source, id }): ReviewItem => {
      const p = id === undefined ? undefined : prev(id, date);
      return { kind: 'lab', title, date, detail: { value, range, flag, previous: p && { date: p.date, value: p.value } }, source, id };
    }).sort(byDate);
    return { recent: items(recent), items };
  };
  return { add, result };
}

const sourceOf = (r: Resource) => (r.meta?.source ? basename(r.meta.source) : undefined);

// all: every medication record (any source) plus the Medication resources they reference.
// A first-import burst lists only active drugs or ones dated within a year; older ones stay in the tally.
export function medicationItems(arrived: Resource[], all: Resource[], since: string, asOf: string): ReviewItem[] {
  const meds = medMap(all);
  return newMedications(arrived.filter((r) => mayBeNew(r, asOf)), meds, new Set(beforeKeys(all, meds, since)), asOf);
}

const keysOf = (r: Resource, meds: Map<string, Resource>) => { const { cc, owner } = medCode(r, meds); return medKeys(cc, owner); };
// The drug keys of records that arrived before `since` (or before arrivals were tracked).
const beforeKeys = (rs: Resource[], meds: Map<string, Resource>, since: string) =>
  rs.filter((r) => { const a = arrivedAt(r); return r.resourceType !== 'Medication' && (a === undefined || a < since); }).flatMap((r) => keysOf(r, meds));
// Whether r can be a new medication, before its drug is compared: so only those need be kept.
// not-taken (e.g. a no-medications entry) and entered-in-error are no medication the person started.
function mayBeNew(r: Resource, asOf: string): boolean {
  const date = clinicalDate(r), status = (r as { status?: string }).status;
  return !isPlanned(r) && status !== 'not-taken' && status !== 'entered-in-error' && (status === 'active' || (!!date && date >= addDays(asOf, -365)));
}

// arrived: records that mayBeNew; meds: Medication by `Medication/<id>`; before: beforeKeys of every medication record.
function newMedications(arrived: Resource[], meds: Map<string, Resource>, before: Set<string>, asOf: string): ReviewItem[] {
  const seen = new Set<string>();
  return arrived.flatMap((r): ReviewItem[] => {
    const keys = keysOf(r, meds), date = clinicalDate(r), status = (r as { status?: string }).status;
    if (!keys.length || keys.some((k) => before.has(k) || seen.has(k))) return [];
    keys.forEach((k) => seen.add(k));
    const rx = keys.find((k) => k.startsWith('rx:'));
    return [{ kind: 'new medication', title: concept(medCode(r, meds).cc) ?? 'Medication', date, detail: { rxnorm: rx?.slice(3), status }, source: sourceOf(r), id: r.id }];
  });
}

const statusOf = (r: Resource) => { const x = r as Record<string, any>; return (x.status ?? x.clinicalStatus?.coding?.[0]?.code) as string | undefined; };

// The last stored version before `since`: history is newest first, read in small pages until one is older.
async function versionBefore(client: MedplumClient, type: 'Condition', id: string, since: string): Promise<Resource | undefined> {
  const count = 20;
  for (let offset = 0; ; offset += count) {
    const entries = ((await client.readHistory(type, id, { count, offset })) as Bundle).entry ?? [];
    const prev = entries.map((e) => e.resource as Resource).find((v) => (v.meta?.lastUpdated ?? '') < since);
    if (prev || entries.length < count) return prev;
  }
}

// A status that changed since `since`, against the last stored version before it. all: the loaded lists (for referenced Medication names); awaited last so the history reads overlap with loading them.
export async function statusItems(client: MedplumClient, patientId: string, since: string, all: Resource[] | Promise<Resource[]> = []): Promise<ReviewItem[]> {
  const changed: { type: 'Condition'; r: Resource; kind: ReviewItem['kind']; from: string; to: string }[] = [];
  for (const [type, param, kind] of [['MedicationStatement', 'subject', 'medication status'], ['MedicationRequest', 'subject', 'medication status'], ['Condition', 'subject', 'problem status']] as const) {
    for await (const page of client.searchResourcePages(type as 'Condition', { [param]: `Patient/${patientId}`, _lastUpdated: `ge${since}`, _sort: '_lastUpdated', _count: '1000' }, { cache: 'no-cache' })) {
      // Every portal medication and problem is rewritten on each sync (last-seen): read their histories a few at a time.
      const found = await pool(page, 5, async (r) => {
        const prev = await versionBefore(client, type as 'Condition', r.id as string, since);
        const from = prev && statusOf(prev), to = statusOf(r);
        return from && to && from !== to ? [{ type: type as 'Condition', r, kind, from, to }] : [];
      });
      changed.push(...found.flat());
    }
  }
  const meds = medMap(await all);
  return changed.map(({ type, r, kind, from, to }) => ({ kind, title: concept(r.resourceType === 'Condition' ? (r as Condition).code : medCode(r, meds).cc) ?? type, date: r.meta?.lastUpdated?.slice(0, 10), detail: { from, to }, source: sourceOf(r), id: r.id }));
}

// Engine items worth raising now (raiseNow), with their evidence for citation.
export function followUpItems(items: Item[], asOf: string): ReviewItem[] {
  return items.filter((i) => raiseNow(i, asOf)).map((i) => {
    const newest = [...i.evidence].sort((a, b) => b.date.localeCompare(a.date))[0];
    return {
      kind: 'health maintenance', title: i.name, date: i.dueDate, source: newest?.source ?? i.doctorsPlan?.source, id: i.doctorsPlan?.id ?? newest?.id,
      detail: { topic: i.topic, itemKind: i.kind, status: i.status, importance: i.importance, guideline: i.guideline, doctorsPlan: i.doctorsPlan, evidence: i.evidence, why: i.why, cost: i.cost },
    };
  });
}

const byDate = (a: ReviewItem, b: ReviewItem) => (b.date ?? '').localeCompare(a.date ?? '');

// The first n of rows sorted by `by` (stable), as pages of rows arrive, and how many there were.
function top<R>(n: number, by: (a: R, b: R) => number) {
  const t = { rows: [] as R[], total: 0, add: (rs: R[]) => { t.total += rs.length; t.rows = [...t.rows, ...rs].sort(by).slice(0, n); } };
  return t;
}

// New clinical notes and MyChart messages, newest first, with their opening text: a clinician's plan ("repeat labs in 6 weeks") often
// lives only here, so the agent reads them and offers record_followup. Source files and archives have no note text and are skipped.
export function noteItems(arrived: Resource[]): ReviewItem[] {
  return arrived.flatMap((r): ReviewItem[] => {
    const isMsg = r.resourceType === 'Communication';
    const body = isMsg ? messageText(r) : r.resourceType === 'DocumentReference' ? noteText(r) : undefined;
    if (!body) return [];
    const date = (isMsg ? r.sent ?? r.received : r.resourceType === 'DocumentReference' ? r.date : undefined)?.slice(0, 10);
    const title = isMsg ? `Message${r.sender?.display ? ` from ${r.sender.display}` : ''}` : concept((r as { type?: CodeableConcept }).type) ?? 'Clinical note';
    return [{ kind: 'note or message', title, date, detail: { text: snippet(body) }, source: sourceOf(r), id: `${r.resourceType}/${r.id}` }];
  }).sort(byDate);
}

const ORDER: ReviewItem['kind'][] = ['lab', 'new medication', 'medication status', 'problem status', 'note or message', 'health maintenance'];
const NOTE = 'From the FDA label; not a full interaction screen. Ask your pharmacist. Report only what the label sections say, quoting the section and the label date.';

// A failed section becomes {error} in its place, trimmed like sectionErrors; the rest still returns.
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, ERROR);
export const part = <T,>(p: Promise<T>): Promise<T | { error: string }> => p.catch((e: unknown) => ({ error: message(e) }));
const failed = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && 'error' in v;

// Budgets (characters) that together stay under the remote 150k tool-result cap, so `note` and the label quotes are never cut.
// NOTES: interleave and the 200-row cut take at most the first 200 of a kind; one more keeps a cut kind cut.
const ITEMS = 30_000, NOTES = 201, LABELS = 50_000, OUT_OF_RANGE = 15_000, LISTS = 6_000, OMITTED_NAMES = 25, ERROR = 200;

// At most 200 rows and `budget` characters; total is the count before the cut.
const cut = <R,>(all: R[], budget: number) => { const { rows, truncated } = fit(all, 200, false, budget); return { rows, total: all.length, ...(truncated && { truncated: true as const }) }; };

// One kind after another in turn, so many labs cannot crowd out medications, status changes or follow-ups.
const interleave = (items: ReviewItem[]): ReviewItem[] => {
  const queues = ORDER.map((k) => items.filter((i) => i.kind === k));
  return Array.from({ length: Math.max(0, ...queues.map((q) => q.length)) }, (_, n) => queues.flatMap((q) => q[n] ?? [])).flat();
};

// f over items, at most n at a time.
async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]); } }));
  return out;
}

export async function whatsNew(client: MedplumClient, patientId: string, eps: Promise<Endpoint[]>, opts: { since?: string; markSeen?: boolean; asOf?: string; fetch?: typeof fetch; dir?: string } = {}) {
  const now = new Date();
  const asOf = opts.asOf ?? now.toLocaleDateString('en-CA');
  const stored = opts.since ? undefined : readLastSeen(opts.dir);
  const since = opts.since ?? stored ?? addDays(asOf, -90);
  // Every source is read page by page and folded: only what the answer carries is kept.
  const arrivedP = (async () => {
    const t = tallier(asOf), labs: Flagged[] = [], meds: Resource[] = [], notes = top(NOTES, byDate);
    await eachArrived(client, patientId, since, (page) => {
      for (const r of page) {
        t.add(r);
        const kind = kindOf(r);
        if (kind === 'lab results' && r.resourceType === 'Observation') { const x = flagged(r, asOf); if (x) labs.push(x); }
        if (kind === 'medications' && mayBeNew(r, asOf)) meds.push(r);
      }
      notes.add(noteItems(page));
    });
    return { tally: t.result(), labs, meds, notes };
  })();
  // The lists' rows, plus what new medications and status changes need of them: the Medications, and the drugs known before `since`.
  const meds = new Map<string, Resource>(), before = new Set<string>();
  const listsP = eps.then((e) => listsByKind(client, patientId, e, (page) => {
    for (const [k, m] of medMap(page)) meds.set(k, m);
    for (const k of beforeKeys(page, meds, since)) before.add(k);
  }));
  const labsP = (async () => {
    const f = labFold(asOf);
    await eachObservation(client, patientId, (os) => { for (const o of os) if (hasCategory(o, 'laboratory') || hasTag(o, 'extracted-by-llm')) f.add(o); });
    return f.result();
  })();
  const [arrived, lists, labs, status, upkeep] = await Promise.all([
    part(arrivedP),
    part(listsP),
    part(labsP),
    part(statusItems(client, patientId, since, listsP.then(() => [...meds.values()], () => []))), // names of referenced drugs come from the lists
    part(healthMaintenance(client, patientId, asOf)),
  ]);
  const errors: Record<string, string> = {};
  const get = <T,>(v: T | { error: string }): T => { if (failed(v)) throw new Error(v.error); return v; };
  const run = (name: string, f: () => ReviewItem[]): ReviewItem[] => {
    try { return f(); } catch (e) { errors[name] = message(e); return []; }
  };
  const all = [
    ...run('labs', () => get(labs).items(get(arrived).labs)),
    ...run('new medications', () => (get(lists), newMedications(get(arrived).meds, meds, before, asOf))),
    ...run('status changes', () => get(status)),
    ...run('notes and messages', () => get(arrived).notes.rows),
    ...run('follow-ups', () => followUpItems(get(upkeep).items, asOf)),
  ];
  // Notes beyond the first NOTES were dropped as they came; they still count.
  const itemsTotal = all.length + (failed(arrived) ? 0 : arrived.notes.total - arrived.notes.rows.length);
  const kept = fit(interleave(all), 200, false, ITEMS);
  const items = kept.rows.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const dir = opts.dir && join(opts.dir, 'labels');
  const checked = await part(pool(items.filter((i) => i.kind === 'new medication'), 3, async (m) => ({
    drug: m.title,
    label: (m.detail.rxnorm ? await drugLabel(m.detail.rxnorm as string, { fetch: opts.fetch, dir }) : { status: 'no code' }) as LabelSections,
  })));
  // Whole entries only, so a label quote is never cut; the rest are named without their sections.
  let size = 0, omitted = 0;
  const medicationCheck = failed(checked) ? checked : checked.flatMap((c) => {
    if ((size += JSON.stringify(c).length) <= LABELS) return [c];
    return ++omitted <= OMITTED_NAMES ? [{ drug: c.drug, label: { status: 'omitted: too large' } }] : [];
  });
  const names = (kind: 'medications' | 'problems') => failed(lists) ? lists : cut(lists[kind].filter((r) => r.currency === 'current').map((r) => r.name), LISTS);
  const outOfRange = failed(labs) ? labs : cut(labs.recent, OUT_OF_RANGE);
  const context = { currentMedications: names('medications'), activeProblems: names('problems'), recentOutOfRange: outOfRange };
  const truncated = !!kept.truncated || omitted > 0 || [context.currentMedications, context.activeProblems, outOfRange].some((c) => 'truncated' in c);
  let seen: { seen: boolean; seenReason?: string } | undefined;
  if (opts.markSeen) {
    const reason = opts.since ? 'a since date was given'
      : [arrived, lists, labs, status, upkeep, checked].some(failed) || Object.keys(errors).length ? 'a section failed'
        : Array.isArray(checked) && checked.some((c) => c.label.status === 'unavailable') ? 'a drug label was unavailable'
          : truncated ? 'the summary was cut' : undefined;
    if (!reason) writeLastSeen(now.toISOString(), opts.dir);
    seen = { seen: !reason, ...(reason && { seenReason: `not marked seen: ${reason}` }) };
  }
  return {
    note: NOTE, since, ...(!opts.since && !stored && { firstRun: true as const }), ...seen,
    ...(!failed(upkeep) && upkeep.byTheWay && { byTheWay: upkeep.byTheWay }),
    tally: failed(arrived) ? arrived : arrived.tally, items, itemsTotal, ...(kept.truncated && { truncated: true as const }),
    ...(Object.keys(errors).length && { sectionErrors: errors }), medicationCheck, ...(omitted > OMITTED_NAMES && { medicationCheckOmitted: omitted }), context,
  };
}
