// whats_new: records that arrived since a time, counted by kind, and the "last seen" marker.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, CodeableConcept, Endpoint, Extension, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { trusted } from './concept-apply.ts';
import { RXNORM } from './concepts.ts';
import { defaultConfigPath } from './config.ts';
import { arrivedAt, SRC_DATE, TAG } from './identity.ts';
import { type LabelSections, drugLabel } from './drug-labels.ts';
import { collect, fit, groupLabs, highLow, labRow } from './labs.ts';
import { concept, listRows, loadLists } from './lists.ts';
import { writeAtomic } from './smart/store.ts';
import { vaccineGaps } from './vaccines.ts';

export const SOURCES: [string, string][] = [['src-ccda', 'C-CDA'], ['src-ehi', 'Epic EHI export'], ['src-apple-health', 'Apple Health'], ['src-pdf', 'PDF or photo']];

export type Kind = 'lab results' | 'vital signs' | 'Apple Health readings' | 'medications' | 'problems' | 'allergies' | 'vaccines' | 'procedures' | 'visits' | 'notes and messages' | 'other';

const hasTag = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);

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

export function tally(arrived: Resource[], asOf: string) {
  const cutoff = new Date(Date.parse(asOf) - 365 * 864e5).toISOString().slice(0, 10);
  const byKind: Partial<Record<Kind, number>> = {};
  const sources = new Set<string>();
  let historical = 0;
  for (const r of arrived) {
    const k = kindOf(r);
    byKind[k] = (byKind[k] ?? 0) + 1;
    const d = clinicalDate(r);
    if (d && d < cutoff) historical++;
    for (const [tag, label] of SOURCES) if (hasTag(r, tag)) sources.add(label);
    for (const i of (r as { identifier?: { system?: string }[] }).identifier ?? []) {
      if (i.system?.startsWith('urn:ga-server:id:smart:')) sources.add(i.system.slice('urn:ga-server:id:smart:'.length));
    }
  }
  return { total: arrived.length, historical, byKind, sources: [...sources] };
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

const daysBefore = (asOf: string, n: number) => new Date(Date.parse(asOf) - n * 864e5).toISOString().slice(0, 10);

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
const medKey = (cc?: CodeableConcept, owner?: Resource): string | undefined => {
  const rx = (owner ? trusted(owner, cc?.coding) : cc?.coding ?? []).find((c) => c.system === RXNORM)?.code;
  const name = concept(cc)?.toLowerCase().replace(/\s+/g, ' ').trim();
  return rx ? `rx:${rx}` : name ? `name:${name}` : undefined;
};
const sourceOf = (r: Resource) => (r.meta?.source ? basename(r.meta.source) : undefined);

// all: every medication record (any source) plus the Medication resources they reference.
export function medicationItems(arrived: Resource[], all: Resource[], since: string): ReviewItem[] {
  const meds = new Map(all.filter((r) => r.resourceType === 'Medication').map((m) => [`Medication/${m.id}`, m]));
  const keyOf = (r: Resource) => { const { cc, owner } = medCode(r, meds); return medKey(cc, owner); };
  const before = new Set(all.filter((r) => { const a = arrivedAt(r); return r.resourceType !== 'Medication' && (a === undefined || a < since); }).map(keyOf));
  const seen = new Set<string>();
  return arrived.flatMap((r): ReviewItem[] => {
    const k = keyOf(r);
    if (!k || before.has(k) || seen.has(k)) return [];
    seen.add(k);
    const rxnorm = k.startsWith('rx:') ? k.slice(3) : undefined;
    return [{ kind: 'new medication', title: concept(medCode(r, meds).cc) ?? 'Medication', date: clinicalDate(r), detail: { rxnorm, status: (r as { status?: string }).status }, source: sourceOf(r), id: r.id }];
  });
}

const statusOf = (r: Resource) => { const x = r as Record<string, any>; return (x.status ?? x.clinicalStatus?.coding?.[0]?.code) as string | undefined; };

// A status that changed since `since`, against the last stored version before it.
export async function statusItems(client: MedplumClient, patientId: string, since: string): Promise<ReviewItem[]> {
  const out: ReviewItem[] = [];
  for (const [type, param, kind] of [['MedicationStatement', 'subject', 'medication status'], ['MedicationRequest', 'subject', 'medication status'], ['Condition', 'subject', 'problem status']] as const) {
    for await (const page of client.searchResourcePages(type as 'Condition', { [param]: `Patient/${patientId}`, _lastUpdated: `ge${since}`, _sort: '_lastUpdated', _count: '1000' }, { cache: 'no-cache' })) {
      for (const r of page) {
        const history = await client.readHistory(type as 'Condition', r.id as string, { count: 1000 }) as Bundle;
        const prev = history.entry?.map((e) => e.resource as Resource).find((v) => (v.meta?.lastUpdated ?? '') < since);
        const from = prev && statusOf(prev), to = statusOf(r);
        if (from && to && from !== to) out.push({ kind, title: concept(type === 'Condition' ? r.code : medCode(r, new Map()).cc) ?? type, date: r.meta?.lastUpdated?.slice(0, 10), detail: { from, to }, source: sourceOf(r), id: r.id });
      }
    }
  }
  return out;
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

export async function whatsNew(client: MedplumClient, patientId: string, eps: Promise<Endpoint[]>, opts: { since?: string; markSeen?: boolean; asOf?: string; fetch?: typeof fetch; dir?: string } = {}) {
  const now = new Date();
  const asOf = opts.asOf ?? now.toLocaleDateString('en-CA');
  const stored = opts.since ? undefined : readLastSeen(opts.dir);
  const since = opts.since ?? stored ?? daysBefore(asOf, 90);
  const subject = `Patient/${patientId}`;
  const q = (f: string[][]) => collect(client, 'Observation', new URLSearchParams([['subject', subject], ...f, ['_sort', '_lastUpdated'], ['_count', '1000']]), (o: Observation) => o, Infinity).then((x) => x.rows);
  const [arrived, lists, labs, hm, status, patient] = await Promise.all([
    arrivedSince(client, patientId, since),
    eps.then((e) => loadLists(client, patientId, e)),
    q([['_filter', `category eq laboratory or _tag eq ${TAG}|extracted-by-llm`], ['_tag:not', `${TAG}|src-apple-health`]]),
    q([['code:text', 'Health maintenance']]),
    statusItems(client, patientId, since),
    client.readResource('Patient', patientId, { cache: 'no-cache' }) as Promise<Patient>,
  ]);
  const vaccines = await vaccineGaps(client, patientId, asOf);
  const isObs = (r: Resource): r is Observation => r.resourceType === 'Observation';
  const newMeds = medicationItems(arrived.filter((r) => kindOf(r) === 'medications'), lists.all, since);
  const items = [
    ...labItems(arrived.filter(isObs).filter((o) => kindOf(o) === 'lab results'), labs, asOf),
    ...newMeds, ...status, ...followUpItems(vaccines, hm, asOf, patient.birthDate),
  ].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const medicationCheck = await Promise.all(newMeds.map(async (m) => ({
    drug: m.title,
    label: (m.detail.rxnorm ? await drugLabel(m.detail.rxnorm as string, { fetch: opts.fetch, dir: opts.dir }) : { status: 'no code' }) as LabelSections,
  })));
  const names = (kind: 'medications' | 'problems') => listRows(lists.all, lists.ctx, kind).filter((r) => r.currency === 'current').map((r) => r.name);
  const result = {
    since, ...(!opts.since && !stored && { firstRun: true as const }), tally: tally(arrived, asOf), items: fit(items, 200).rows, medicationCheck,
    context: { currentMedications: names('medications'), activeProblems: names('problems'), recentOutOfRange: labItems(labs, labs, asOf) },
    note: NOTE,
  };
  if (opts.markSeen && !opts.since) writeLastSeen(now.toISOString(), opts.dir);
  return result;
}
