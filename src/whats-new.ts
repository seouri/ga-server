// whats_new: records that arrived since a time, counted by kind, and the "last seen" marker.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, CodeableConcept, Condition, Endpoint, Extension, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { trusted } from './concept-apply.ts';
import { RXNORM } from './concepts.ts';
import { defaultConfigPath } from './config.ts';
import { hasTag } from './engine.ts';
import { arrivedAt, SRC_DATE, TAG } from './identity.ts';
import { type LabelSections, drugLabel } from './drug-labels.ts';
import { collect, fit, groupLabs, highLow, labRow } from './labs.ts';
import { concept, listRows, loadLists } from './lists.ts';
import { writeAtomic } from './smart/store.ts';
import { vaccineGaps } from './vaccines.ts';

export const SOURCES: [string, string][] = [['src-ccda', 'C-CDA'], ['src-ehi', 'Epic EHI export'], ['src-apple-health', 'Apple Health'], ['src-pdf', 'PDF or photo']];

export type Kind = 'lab results' | 'vital signs' | 'Apple Health readings' | 'medications' | 'problems' | 'allergies' | 'vaccines' | 'procedures' | 'visits' | 'notes and messages' | 'other';

export function kindOf(r: Resource): Kind {
  switch (r.resourceType) {
    case 'Observation':
      if (hasTag(r, 'src-apple-health')) return 'Apple Health readings';
      return r.category?.some((c) => c.coding?.some((x) => x.code === 'vital-signs')) ? 'vital signs' : 'lab results';
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

const daysBefore = (asOf: string, n: number) => new Date(Date.parse(asOf) - n * 864e5).toISOString().slice(0, 10);

export function tally(arrived: Resource[], asOf: string) {
  const cutoff = daysBefore(asOf, 365);
  const byKind: Partial<Record<Kind, number>> = {};
  const sources = new Set<string>();
  let historical = 0, noRangeGiven = 0;
  for (const r of arrived) {
    const k = kindOf(r);
    byKind[k] = (byKind[k] ?? 0) + 1;
    const d = clinicalDate(r);
    if (d && d < cutoff) historical++;
    if (k === 'lab results' && r.resourceType === 'Observation' && !r.interpretation?.length && !r.referenceRange?.length) noRangeGiven++; // listed, never judged
    for (const [tag, label] of SOURCES) if (hasTag(r, tag)) sources.add(label);
    for (const i of (r as { identifier?: { system?: string }[] }).identifier ?? []) {
      if (i.system?.startsWith('urn:ga-server:id:smart:')) sources.add(i.system.slice('urn:ga-server:id:smart:'.length));
    }
  }
  return { total: arrived.length, historical, noRangeGiven, byKind, sources: [...sources] };
}

// Types the engine creates, with their patient search parameter.
const TYPES: [Resource['resourceType'], 'subject' | 'patient'][] = [
  ['Observation', 'subject'], ['Condition', 'subject'], ['MedicationStatement', 'subject'], ['MedicationRequest', 'subject'], ['AllergyIntolerance', 'patient'],
  ['Immunization', 'patient'], ['Procedure', 'subject'], ['Encounter', 'subject'], ['DocumentReference', 'subject'], ['Communication', 'subject'],
  ['DiagnosticReport', 'subject'], ['FamilyMemberHistory', 'patient'], ['QuestionnaireResponse', 'subject'],
];

// Records without the arrival extension predate tracking and are never returned.
export async function arrivedSince(client: MedplumClient, patientId: string, since: string): Promise<Resource[]> {
  const out: Resource[] = [];
  for (const [type, param] of TYPES) {
    const q = { [param]: `Patient/${patientId}`, _lastUpdated: `ge${since}`, _sort: '_lastUpdated', _count: '1000' };
    for await (const page of client.searchResourcePages(type as 'Observation', q, { cache: 'no-cache' })) out.push(...page.filter((r) => { const a = arrivedAt(r); return a !== undefined && a >= since; }));
  }
  return out;
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
  kind: 'lab' | 'new medication' | 'medication status' | 'problem status' | 'vaccine follow-up' | 'health maintenance';
  title: string; date?: string; detail: Record<string, unknown>; source?: string; id?: string;
};

export function labItems(arrived: Observation[], allLabs: Observation[], asOf: string): ReviewItem[] {
  const cutoff = daysBefore(asOf, 365);
  const groups = groupLabs(allLabs);
  return arrived.flatMap((o): ReviewItem[] => {
    const flag = highLow(o), date = clinicalDate(o);
    if (!flag || !date || date < cutoff) return [];
    const row = labRow(o);
    const older = groups.find((g) => g.some((x) => x.id === o.id))?.find((x) => { const d = clinicalDate(x); return d && d < date; });
    const p = older && labRow(older);
    return [{ kind: 'lab', title: row.name ?? 'Lab result', date, detail: { value: row.value, range: row.range, flag, previous: p && { date: p.date, value: p.value } }, source: row.source, id: o.id }];
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

// The drug's concept: its own, else the referenced Medication's code, else the reference's display. meds: Medication by `Medication/<id>`.
const medCode = (r: Resource, meds: Map<string, Resource>): { cc?: CodeableConcept; owner: Resource } => {
  const x = r as Record<string, any>;
  const ref = x.medicationReference as { reference?: string; display?: string } | undefined;
  const m = ref?.reference ? meds.get(ref.reference) : undefined;
  if (x.medicationCodeableConcept) return { cc: x.medicationCodeableConcept, owner: r };
  if ((m as Record<string, any> | undefined)?.code) return { cc: (m as Record<string, any>).code, owner: m! };
  return { cc: ref?.display ? { text: ref.display } : undefined, owner: r };
};
// Both keys of a drug (its RxNorm code and its name), so an uncoded copy of a coded drug is the same drug.
const medKeys = (cc?: CodeableConcept, owner?: Resource): string[] => {
  const rx = (owner ? trusted(owner, cc?.coding) : cc?.coding ?? []).find((c) => c.system === RXNORM)?.code;
  const name = concept(cc)?.toLowerCase().replace(/\s+/g, ' ').trim();
  return [...(rx ? [`rx:${rx}`] : []), ...(name ? [`name:${name}`] : [])];
};
const sourceOf = (r: Resource) => (r.meta?.source ? basename(r.meta.source) : undefined);
const medMap = (all: Resource[]) => new Map(all.filter((r) => r.resourceType === 'Medication').map((m) => [`Medication/${m.id}`, m]));

// all: every medication record (any source) plus the Medication resources they reference.
// A first-import burst lists only active drugs or ones dated within a year; older ones stay in the tally.
export function medicationItems(arrived: Resource[], all: Resource[], since: string, asOf: string): ReviewItem[] {
  const meds = medMap(all);
  const keysOf = (r: Resource) => { const { cc, owner } = medCode(r, meds); return medKeys(cc, owner); };
  const before = new Set(all.filter((r) => { const a = arrivedAt(r); return r.resourceType !== 'Medication' && (a === undefined || a < since); }).flatMap(keysOf));
  const cutoff = daysBefore(asOf, 365);
  const seen = new Set<string>();
  return arrived.flatMap((r): ReviewItem[] => {
    const keys = keysOf(r), date = clinicalDate(r), status = (r as { status?: string }).status;
    if (!keys.length || keys.some((k) => before.has(k) || seen.has(k)) || !(status === 'active' || (date && date >= cutoff))) return [];
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
      for (const r of page) {
        const prev = await versionBefore(client, type as 'Condition', r.id as string, since);
        const from = prev && statusOf(prev), to = statusOf(r);
        if (from && to && from !== to) changed.push({ type: type as 'Condition', r, kind, from, to });
      }
    }
  }
  const meds = medMap(await all);
  return changed.map(({ type, r, kind, from, to }) => ({ kind, title: concept(r.resourceType === 'Condition' ? (r as Condition).code : medCode(r, meds).cc) ?? type, date: r.meta?.lastUpdated?.slice(0, 10), detail: { from, to }, source: sourceOf(r), id: r.id }));
}

export function followUpItems(vaccines: Awaited<ReturnType<typeof vaccineGaps>>, hm: Observation[], asOf: string, birthDate?: string): ReviewItem[] {
  const items: ReviewItem[] = vaccines.results.filter((v) => (v.status === 'due' || v.status === 'overdue') && v.records.length).map((v) => ({
    kind: 'vaccine follow-up', title: v.vaccine, date: v.records.map((x) => x.date).sort().at(-1), detail: { status: v.status, reason: v.reason, records: v.records }, source: [...new Set(v.records.map((x) => x.source))].join(', ') || undefined,
  }));
  for (const o of hm) {
    const topic = o.code?.text?.match(/^Health maintenance: (.+)$/)?.[1];
    if (!topic) continue;
    const next = o.component?.find((c) => /next due/i.test(c.code?.text ?? ''))?.valueDateTime?.slice(0, 10);
    const due = next && !(birthDate && next < birthDate) ? next : undefined; // a due date before birth is a bad record
    if (!/^(overdue|due)$/i.test(o.valueString ?? '') && !(due && due <= asOf)) continue;
    const asOfExport = (o.extension as Extension[] | undefined)?.find((e) => e.url === SRC_DATE)?.valueDateTime;
    items.push({ kind: 'health maintenance', title: topic, detail: { status: o.valueString, nextDue: due, asOfExport }, date: asOfExport?.slice(0, 10), source: sourceOf(o), id: o.id });
  }
  return items;
}

const ORDER: ReviewItem['kind'][] = ['lab', 'new medication', 'medication status', 'problem status', 'vaccine follow-up', 'health maintenance'];
const NOTE = 'From the FDA label; not a full interaction screen. Ask your pharmacist. Report only what the label sections say, quoting the section and the label date.';

// A failed section becomes {error} in its place, trimmed like sectionErrors; the rest still returns.
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, ERROR);
export const part = <T,>(p: Promise<T>): Promise<T | { error: string }> => p.catch((e: unknown) => ({ error: message(e) }));
const failed = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && 'error' in v;

// Budgets (characters) that together stay under the remote 150k tool-result cap, so `note` and the label quotes are never cut.
const ITEMS = 30_000, LABELS = 50_000, OUT_OF_RANGE = 15_000, LISTS = 6_000, OMITTED_NAMES = 25, ERROR = 200;

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
  const since = opts.since ?? stored ?? daysBefore(asOf, 90);
  const subject = `Patient/${patientId}`;
  const q = (f: string[][]) => collect(client, 'Observation', new URLSearchParams([['subject', subject], ...f, ['_sort', '_lastUpdated'], ['_count', '1000']]), (o: Observation) => o, Infinity).then((x) => x.rows);
  const listsP = eps.then((e) => loadLists(client, patientId, e));
  const [arrived, lists, labs, hm, status, patient, vaccines] = await Promise.all([
    part(arrivedSince(client, patientId, since)),
    part(listsP),
    part(q([['_filter', `category eq laboratory or _tag eq ${TAG}|extracted-by-llm`], ['_tag:not', `${TAG}|src-apple-health`]])),
    part(q([['code:text', 'Health maintenance']])),
    part(statusItems(client, patientId, since, listsP.then((l) => l.all, () => []))), // names of referenced drugs come from the lists
    part(client.readResource('Patient', patientId, { cache: 'no-cache' }) as Promise<Patient>),
    part(vaccineGaps(client, patientId, asOf)),
  ]);
  const isObs = (r: Resource): r is Observation => r.resourceType === 'Observation';
  const errors: Record<string, string> = {};
  const get = <T,>(v: T | { error: string }): T => { if (failed(v)) throw new Error(v.error); return v; };
  const run = (name: string, f: () => ReviewItem[]): ReviewItem[] => {
    try { return f(); } catch (e) { errors[name] = message(e); return []; }
  };
  const all = [
    ...run('labs', () => labItems(get(arrived).filter(isObs).filter((o) => kindOf(o) === 'lab results'), get(labs), asOf)),
    ...run('new medications', () => medicationItems(get(arrived).filter((r) => kindOf(r) === 'medications'), get(lists).all, since, asOf)),
    ...run('status changes', () => get(status)),
    ...run('follow-ups', () => followUpItems(get(vaccines), get(hm), asOf, failed(patient) ? undefined : patient.birthDate)),
  ];
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
  const names = (kind: 'medications' | 'problems') => failed(lists) ? lists : cut(listRows(lists.all, lists.ctx, kind).filter((r) => r.currency === 'current').map((r) => r.name), LISTS);
  const outOfRange = failed(labs) ? labs : cut(labItems(labs, labs, asOf), OUT_OF_RANGE);
  const context = { currentMedications: names('medications'), activeProblems: names('problems'), recentOutOfRange: outOfRange };
  const truncated = !!kept.truncated || omitted > 0 || [context.currentMedications, context.activeProblems, outOfRange].some((c) => 'truncated' in c);
  let seen: { seen: boolean; seenReason?: string } | undefined;
  if (opts.markSeen) {
    const reason = opts.since ? 'a since date was given'
      : [arrived, lists, labs, hm, status, patient, vaccines, checked].some(failed) || Object.keys(errors).length ? 'a section failed'
        : Array.isArray(checked) && checked.some((c) => c.label.status === 'unavailable') ? 'a drug label was unavailable'
          : truncated ? 'the summary was cut' : undefined;
    if (!reason) writeLastSeen(now.toISOString(), opts.dir);
    seen = { seen: !reason, ...(reason && { seenReason: `not marked seen: ${reason}` }) };
  }
  return {
    note: NOTE, since, ...(!opts.since && !stored && { firstRun: true as const }), ...seen,
    tally: failed(arrived) ? arrived : tally(arrived, asOf), items, itemsTotal: all.length, ...(kept.truncated && { truncated: true as const }),
    ...(Object.keys(errors).length && { sectionErrors: errors }), medicationCheck, ...(omitted > OMITTED_NAMES && { medicationCheckOmitted: omitted }), context,
  };
}
