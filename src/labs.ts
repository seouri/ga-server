// lab_results: the patient's lab Observations as compact rows, encoding what GA knows about where labs live.
import { basename, dirname } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Observation, Quantity, Resource, ResourceType } from '@medplum/fhirtypes';
import { trusted } from './concept-apply.ts';
import { termKey } from './conceptmap.ts';
import { type Concept, codesFor, concepts, conceptNamed, conceptOf, LOINC } from './concepts.ts';
import { GaError } from './config.ts';
import { TAG } from './identity.ts';

const BUDGET = 140_000; // stays under the remote 150k tool-result cap, so rows are never cut mid-JSON

export type LabRow = { date?: string; name?: string; value?: string; range?: string; interpretation?: string; source?: string; flags?: string[]; id?: string };

export const qty = (q?: Quantity) => (q?.value === undefined ? undefined : `${q.comparator ?? ''}${q.value}${q.unit ?? q.code ? ` ${q.unit ?? q.code}` : ''}`);

// GA's review tags as row flags.
export function flagsOf(meta?: { tag?: { code?: string }[] }): string[] | undefined {
  const tags = new Set(meta?.tag?.map((t) => t.code));
  const f = [...(tags.has('extracted-by-llm') ? ['read from a document by AI'] : []), ...(tags.has('possible-duplicate') ? ['possible-duplicate'] : [])];
  return f.length ? f : undefined;
}

// The record's concept and member label. suggested: only through a GA-added coding on a record tagged concept-suggested.
function conceptMatch(o: Observation): { concept: Concept; label?: string; suggested?: true } | undefined {
  const codings = o.code?.coding ?? [];
  const mine = trusted(o, codings);
  const sure = conceptOf(mine);
  const guess = !sure && mine.length < codings.length ? conceptOf(codings) : undefined;
  return sure ?? (guess && { ...guess, suggested: true });
}

export function labRow(o: Observation, m = conceptMatch(o)): LabRow {
  const c = o.code?.coding?.[0];
  const flags = [...(flagsOf(o.meta) ?? []), ...(m?.suggested ? [`possibly ${m.concept.name} (suggested mapping)`] : [])];
  const r = o.referenceRange?.[0];
  const lo = qty(r?.low), hi = qty(r?.high);
  const range = r?.text ?? (lo && hi ? `${r?.low?.value}–${hi}` : lo ? `≥${lo}` : hi ? `≤${hi}` : undefined);
  return {
    date: (o.effectiveDateTime ?? o.effectivePeriod?.start ?? o.effectiveInstant ?? o.issued)?.slice(0, 10),
    name: o.code?.text ?? c?.display ?? c?.code,
    value: qty(o.valueQuantity) ?? o.valueString ?? o.valueCodeableConcept?.text ?? o.valueCodeableConcept?.coding?.[0]?.display,
    range,
    interpretation: o.interpretation?.[0]?.coding?.[0]?.code ?? o.interpretation?.[0]?.text,
    source: o.meta?.source ? basename(o.meta.source) : undefined,
    flags: flags.length ? flags : undefined,
    id: o.id,
  };
}

const validDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d);

// since/until (YYYY-MM-DD, inclusive) as repeated date params; le<day> would drop results later on that day, so lt the next day.
export function dateRange(q: URLSearchParams, param: string, since?: string, until?: string): void {
  for (const [k, d] of [['since', since], ['until', until]] as const) if (d !== undefined && !validDay(d)) throw new GaError(`${k} must be a date YYYY-MM-DD`);
  if (since) q.append(param, `ge${since}`);
  if (until) q.append(param, `lt${new Date(Date.parse(until) + 86_400_000).toISOString().slice(0, 10)}`);
}

// Reads pages until more than `limit` rows are kept (row() returns undefined to skip) or `scan` records were read.
// more: rows or pages were left unread.
export async function collect<T extends Resource, R>(
  client: MedplumClient, type: ResourceType, q: URLSearchParams, row: (r: T) => R | undefined, limit: number, scan = Infinity,
): Promise<{ rows: R[]; more: boolean }> {
  const rows: R[] = [];
  let read = 0;
  let b: Bundle<T> | undefined = await client.search(type as 'Observation', q, { cache: 'no-cache' }) as unknown as Bundle<T>;
  for (;;) {
    for (const e of b.entry ?? []) {
      read++;
      const r = e.resource && row(e.resource);
      if (r !== undefined) rows.push(r);
    }
    const next: string | undefined = b.link?.find((l) => l.relation === 'next')?.url;
    if (rows.length > limit || read >= scan || !next) return { rows, more: rows.length > limit || !!next };
    // Follow by path: the link's host is Medplum's configured base, which the gateway container may not reach.
    b = await client.get<Bundle<T>>(next.replace(/^\w+:\/\/[^/]+\//, ''), { cache: 'no-cache' });
  }
}

// At most `limit` rows and BUDGET characters, so the remote cap never cuts JSON mid-row.
export function fit<R>(rows: R[], limit: number, more = false, budget = BUDGET): { rows: R[]; total: number; truncated?: true } {
  let size = 0;
  const cut = rows.slice(0, limit).findIndex((r) => (size += JSON.stringify(r).length + 1) > budget);
  const truncated = more || rows.length > limit || cut >= 0;
  const out = rows.slice(0, cut >= 0 ? cut : limit);
  return { rows: out, total: out.length, ...(truncated ? { truncated: true as const } : {}) };
}

const loincOf = (o: Observation) => o.code?.coding?.find((c) => c.system === LOINC)?.code;
// The sources a stored result came from, as the importer stamped them: src-<kind> tags, with the organisation of
// ehi/smart identifiers and the C-CDA file's folder. shortcut: stricter than the concept map's source key (several C-CDA
// folders of one custodian count apart), which only ever stops a join; upgrade if same-custodian C-CDA joins are missed.
function sourcesOf(o: Observation): string[] {
  const kinds = (o.meta?.tag ?? []).flatMap((t) => (t.system === TAG && t.code?.startsWith('src-') ? [t.code.slice(4)] : []));
  const ids = [o.identifier ?? []].flat().map((i) => i.system ?? '');
  return kinds.flatMap((k) => {
    if (k === 'ehi' || k === 'smart') return ids.filter((s) => s.startsWith(`urn:ga-server:id:${k}:`));
    return [k === 'ccda' ? `ccda:${dirname(o.meta?.source ?? '')}` : k];
  });
}
const norm = (s = '') => s.toLowerCase().replace(/\s+/g, ' ').trim();

const num = (o: Observation) => (o.valueQuantity?.comparator ? undefined : o.valueQuantity?.value);
const unitOf = (o: Observation) => o.valueQuantity?.unit ?? o.valueQuantity?.code;

// Out of range: by interpretation when there is one (H/HH/High..., L/LL/Low...), else the value against the reference range.
export function highLow(o: Observation): 'high' | 'low' | undefined {
  const i = o.interpretation?.[0];
  const code = i?.coding?.[0]?.code ?? i?.text;
  if (code) return /^h/i.test(code) ? 'high' : /^l/i.test(code) ? 'low' : undefined;
  const v = o.valueQuantity?.value, r = o.referenceRange?.[0];
  // "<5" against a high of 3 says nothing: a comparator skips the range.
  return v === undefined || o.valueQuantity?.comparator ? undefined : r?.high?.value !== undefined && v > r.high.value ? 'high' : r?.low?.value !== undefined && v < r.low.value ? 'low' : undefined;
}

export type LabTrend = {
  test?: string; name?: string; loinc?: string; unit?: string; latest: { date?: string; value?: string | number; flag?: string; method?: string };
  previous?: { date?: string; value?: string | number; method?: string }; change?: number; count: number; outOfRange: number; first?: string; source?: string; flags?: string[];
};

// One entry per test: a concept (any member code, its own or GA-added and not suggested) is one group, labelled by the member (method);
// others by LOINC, else by name (case/space-insensitive). An uncoded result joins the coded group of its name and unit (+ specimen)
// from the same source when there is exactly one; never across sources (a PDF "Glucose" is not the hospital's), never one its
// source map calls unmatched. A suggested-only result keeps to its name: its GA-suggested LOINC is a guess.
function grouped(obs: Observation[]) {
  const rows = obs.map((o) => {
    const m = conceptMatch(o);
    return { o, r: labRow(o, m), m: m?.suggested ? undefined : m, guess: !!m?.suggested };
  });
  const keyOf = (x: (typeof rows)[number]) => (x.m ? `concept:${x.m.concept.name}` : x.guess ? undefined : loincOf(x.o));
  const twins = new Map<string, Set<string>>();
  const ids = (o: Observation) => {
    const t = termKey(o);
    return t ? sourcesOf(o).map((s) => `${s}\n${t}`) : [];
  };
  for (const x of rows) {
    const k = keyOf(x);
    if (k) for (const id of ids(x.o)) twins.set(id, (twins.get(id) ?? new Set()).add(k));
  }
  const unmatched = (o: Observation) => !!o.meta?.tag?.some((t) => t.system === TAG && t.code === 'concept-unmatched');
  const groups = new Map<string, typeof rows>();
  for (const x of rows) {
    const twin = x.guess || unmatched(x.o) ? undefined : new Set(ids(x.o).flatMap((id) => [...(twins.get(id) ?? [])]));
    const k = keyOf(x) ?? (twin?.size === 1 ? [...twin][0] : norm(x.r.name));
    if (!k) continue; // nothing to group by
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  // Undated last; the same day: the newest written first.
  return [...groups.values()].map((g) => g.sort((a, b) => (b.r.date ?? '').localeCompare(a.r.date ?? '') || (b.o.meta?.lastUpdated ?? '').localeCompare(a.o.meta?.lastUpdated ?? '')));
}

export const groupLabs = (obs: Observation[]): Observation[][] => grouped(obs).map((g) => g.map((x) => x.o));

export function summarizeLabs(obs: Observation[]): LabTrend[] {
  return grouped(obs).map((g): LabTrend => {
    const [l] = g;
    const p = g.find((x) => x.r.date && l.r.date && x.r.date < l.r.date);
    const a = num(l.o), b = p && num(p.o);
    const flag = highLow(l.o) ?? (l.r.interpretation && !/^n/i.test(l.r.interpretation) ? l.r.interpretation : undefined);
    return {
      test: g.find((x) => x.m)?.m?.concept.name, name: l.r.name, loinc: g.map((x) => (x.guess ? undefined : loincOf(x.o))).find(Boolean), unit: unitOf(l.o),
      latest: { date: l.r.date, value: a ?? l.r.value, flag, method: l.m?.label },
      previous: p && { date: p.r.date, value: b ?? p.r.value, method: p.m?.label },
      change: a !== undefined && b !== undefined && unitOf(l.o) === unitOf(p!.o) ? Math.round((a - b) * 1e6) / 1e6 : undefined,
      count: g.length, outOfRange: g.filter((x) => highLow(x.o)).length, first: g.findLast((x) => x.r.date)?.r.date, source: l.r.source, flags: l.r.flags,
    };
  }).sort((x, y) => (y.latest.date ?? '').localeCompare(x.latest.date ?? ''));
}

// The lab concepts' entries, in concepts.json order (summarizeLabs already groups each into one entry).
export const keyLabs = (trends: LabTrend[]): LabTrend[] => concepts().filter((c) => c.kind === 'lab').flatMap((c) => trends.filter((t) => t.test === c.name));

export async function labResults(
  client: MedplumClient,
  patientId: string,
  { name, since, until, limit = 200, summary = false, keyOnly = false }: { name?: string; since?: string; until?: string; limit?: number; summary?: boolean; keyOnly?: boolean },
): Promise<{ rows: (LabRow | LabTrend)[]; total: number; truncated?: true }> {
  // Older PDF imports have no category: the OR keeps them. _id breaks date ties so offset paging neither skips nor repeats.
  const q = new URLSearchParams([
    ['subject', `Patient/${patientId}`],
    ['_filter', `category eq laboratory or _tag eq ${TAG}|extracted-by-llm`],
    ['_tag:not', `${TAG}|src-apple-health`],
    ['_sort', '-date,_id'],
    ['_count', '100'],
  ]);
  // A lab concept's name ("ldl") finds its member codes (GA-added too) plus the literal name (results not yet coded):
  // filtered here, Medplum can't OR code and code:text.
  const c = name ? conceptNamed(name) : undefined;
  const key = c?.kind === 'lab' ? new Set(codesFor(c.name).map((x) => `${x.system}|${x.code}`)) : undefined;
  if (name && !key) q.append('code:text', name);
  dateRange(q, 'date', since, until);
  // An extracted result with some other category (e.g. a vital sign) is not a lab.
  const isLab = (o: Observation) => !o.category?.length || o.category.some((c) => c.coding?.some((x) => x.code === 'laboratory'));
  const named = (o: Observation) => !key || !!o.code?.coding?.some((x) => key.has(`${x.system}|${x.code}`)) || [o.code?.text, ...(o.code?.coding ?? []).map((c) => c.display)].some((t) => norm(t).includes(norm(name)));
  if (summary || key) {
    // Every result: _lastUpdated with _count >= 20 pages by cursor (Medplum caps _offset at 10000); dates are ordered here.
    q.set('_sort', '_lastUpdated');
    q.set('_count', '1000');
    const obs = (await collect(client, 'Observation', q, (o: Observation) => (isLab(o) && named(o) ? o : undefined), Infinity)).rows;
    // keyOnly (health_summary): key labs picked before fit, so other tests can't push them out.
    if (summary) return fit(keyOnly ? keyLabs(summarizeLabs(obs)) : summarizeLabs(obs), limit);
    return fit(obs.map((o) => labRow(o)).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')), limit); // undated last
  }
  const { rows } = await collect(client, 'Observation', q, (o: Observation) => (isLab(o) ? labRow(o) : undefined), limit);
  // Medplum sorts undated results first on -date; a latest-value question wants them last.
  // shortcut: only within the fetched pages, fine unless a patient has over a page of undated labs.
  rows.sort((a, b) => Number(!a.date) - Number(!b.date));
  return fit(rows, limit);
}
