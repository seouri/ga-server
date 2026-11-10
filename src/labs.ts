// lab_results: the patient's lab Observations as compact rows, encoding what GA knows about where labs live.
import { basename, dirname } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Observation, Quantity, Resource, ResourceType } from '@medplum/fhirtypes';
import { trusted } from './concept-apply.ts';
import { termKey } from './conceptmap.ts';
import { type Concept, codesFor, concepts, conceptNamed, conceptOf, isVitalCode, LOINC } from './concepts.ts';
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
export function conceptMatch(o: Observation): { concept: Concept; label?: string; suggested?: true } | undefined {
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
    value: qty(o.valueQuantity) ?? o.valueString ?? o.valueCodeableConcept?.text ?? o.valueCodeableConcept?.coding?.[0]?.display ?? o.valueDateTime
      ?? (o.valueBoolean === undefined ? undefined : String(o.valueBoolean)),
    range,
    interpretation: o.interpretation?.[0]?.coding?.[0]?.code ?? o.interpretation?.[0]?.text,
    source: o.meta?.source ? basename(o.meta.source) : undefined,
    flags: flags.length ? flags : undefined,
    id: o.id,
  };
}

// A panel that only groups its members (C-CDA vital signs organizer: hasMember, nothing of its own): its members are the rows.
// A panel with its own value, interpretation, note, range or absent reason (a portal's) is a row.
const OWN = ['component', 'interpretation', 'note', 'referenceRange', 'dataAbsentReason'] as const;
export const isPanel = (o: Observation) =>
  !!o.hasMember?.length && !OWN.some((k) => { const v = o[k]; return Array.isArray(v) ? v.length > 0 : v !== undefined; }) && !Object.keys(o).some((k) => k.startsWith('value'));

export const validDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d);

// since/until (YYYY-MM-DD, inclusive) as repeated date params; le<day> would drop results later on that day, so lt the next day.
export function dateRange(q: URLSearchParams, param: string, since?: string, until?: string): void {
  for (const [k, d] of [['since', since], ['until', until]] as const) if (d !== undefined && !validDay(d)) throw new GaError(`${k} must be a date YYYY-MM-DD`);
  if (since) q.append(param, `ge${since}`);
  if (until) q.append(param, `lt${new Date(Date.parse(until) + 86_400_000).toISOString().slice(0, 10)}`);
}

// Reads pages until more than `limit` rows are kept (row() returns undefined to skip) or `scan` records were read.
// more: rows or pages were left unread.
// Every page of a search, handed to `page` as it arrives and then dropped, so a caller keeps only what it derives.
// _sort=_lastUpdated (ascending, _count >= 20) makes Medplum page by _cursor: it caps _offset at 10000.
export async function eachPage<T extends Resource = Resource>(client: MedplumClient, type: ResourceType, q: Record<string, string>, page: (rs: T[]) => void): Promise<void> {
  for await (const p of client.searchResourcePages(type, { ...q, _sort: '_lastUpdated', _count: '1000' }, { cache: 'no-cache' })) page(p as unknown as T[]);
}

// Every resource of a search.
export async function searchAll(client: MedplumClient, type: ResourceType, q: Record<string, string>): Promise<Resource[]> {
  const out: Resource[] = [];
  await eachPage(client, type, q, (p) => out.push(...p));
  return out;
}

// Every non-Apple Observation: loaded once so what's new derives its subsets in memory, or page by page (eachObservation).
const nonApple = (patientId: string) => ({ subject: `Patient/${patientId}`, '_tag:not': `${TAG}|src-apple-health` });
export const loadObservations = (client: MedplumClient, patientId: string) => searchAll(client, 'Observation', nonApple(patientId)) as Promise<Observation[]>;
export const eachObservation = (client: MedplumClient, patientId: string, page: (rs: Observation[]) => void) => eachPage(client, 'Observation', nonApple(patientId), page);

// The pages of a search, as they come; the next one is fetched only when asked for.
export async function* bundles<T extends Resource>(client: MedplumClient, type: ResourceType, q: URLSearchParams): AsyncGenerator<Bundle<T>> {
  let b = await client.search(type as 'Observation', q, { cache: 'no-cache' }) as unknown as Bundle<T>;
  for (;;) {
    yield b;
    const next: string | undefined = b.link?.find((l) => l.relation === 'next')?.url;
    if (!next) return;
    // Follow by path: the link's host is Medplum's configured base, which the gateway container may not reach.
    b = await client.get<Bundle<T>>(next.replace(/^\w+:\/\/[^/]+\//, ''), { cache: 'no-cache' });
  }
}

export async function collect<T extends Resource, R>(
  client: MedplumClient, type: ResourceType, q: URLSearchParams, row: (r: T) => R | undefined, limit: number, scan = Infinity,
): Promise<{ rows: R[]; more: boolean }> {
  const rows: R[] = [];
  let read = 0;
  for await (const b of bundles<T>(client, type, q)) {
    for (const e of b.entry ?? []) {
      read++;
      const r = e.resource && row(e.resource);
      if (r !== undefined) rows.push(r);
    }
    const next = b.link?.some((l) => l.relation === 'next');
    if (rows.length > limit || read >= scan || !next) return { rows, more: rows.length > limit || !!next };
  }
  return { rows, more: false };
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
// What decides a result's group: its key (concept, else LOINC; none for a guess), else (pending) the twins of its source-term
// ids, else its name.
function decides(o: Observation, m0: ReturnType<typeof conceptMatch>, rowName?: string) {
  const guess = !!m0?.suggested, m = guess ? undefined : m0;
  const loinc = guess ? undefined : loincOf(o);
  const key = m ? `concept:${m.concept.name}` : loinc;
  const t = termKey(o);
  const ids = t ? sourcesOf(o).map((s) => `${s}\n${t}`) : [];
  const unmatched = !!o.meta?.tag?.some((x) => x.system === TAG && x.code === 'concept-unmatched');
  return { m, loinc, key, ids, name: norm(rowName), pending: !key && !guess && !unmatched };
}

// Results folded per set (what decides their group) as they come; their groups are known only at the end, once every coded
// twin is: so a fold keeps per set, which grows with the distinct tests, not their results. init: a set's empty state.
function labSets<S>(init: () => S) {
  const twins = new Map<string, Set<string>>();
  const sets = new Map<string, { s: S; ids?: string[]; name: string }>(); // 'k' + group key, or 'p' + pending (ids, name)
  const add = (d: ReturnType<typeof decides>): S => {
    if (d.key) for (const id of d.ids) twins.set(id, (twins.get(id) ?? new Set()).add(d.key));
    const a = d.pending ? `p${JSON.stringify([d.ids, d.name])}` : `k${d.key ?? d.name}`;
    let x = sets.get(a);
    if (!x) sets.set(a, (x = { s: init(), name: d.name, ...(d.pending && { ids: d.ids }) }));
    return x.s;
  };
  // Each set joins its group: its key, else its one coded twin, else its name (none: skipped). Sets come in the order of
  // their first result, so groups do too.
  const groups = (): S[][] => {
    const out = new Map<string, S[]>();
    for (const [a, x] of sets) {
      const twin = x.ids && new Set(x.ids.flatMap((id) => [...(twins.get(id) ?? [])]));
      const k = a[0] === 'k' ? a.slice(1) : twin?.size === 1 ? [...twin][0] : x.name;
      if (k) (out.get(k) ?? out.set(k, []).get(k)!).push(x.s);
    }
    return [...out.values()];
  };
  return { add, groups };
}

export const summarizeLabs = (obs: Observation[]): LabTrend[] => {
  const f = labTrends();
  for (const o of obs) f.add(o);
  return f.result();
};

// One result as a fold needs it, without the resource. seq: its place in the input, the last tie-break.
type Pt = { seq: number; date?: string; lu?: string; name?: string; value?: string; num?: number; unit?: string; flag?: string; method?: string; source?: string; flags?: string[]; loinc?: string; test?: string };
// a before b in a group's order: newest date first (undated last), the same day: the newest written first, then the first added.
const ahead = (a: Pt, b: Pt) => ((b.date ?? '').localeCompare(a.date ?? '') || (b.lu ?? '').localeCompare(a.lu ?? '') || a.seq - b.seq) < 0;
const best = (ps: (Pt | undefined)[]) => ps.reduce<Pt | undefined>((x, p) => (p && (!x || ahead(p, x)) ? p : x), undefined);
// The newest result dated before `date` (summarizeLabs' previous).
const before = (ps: (Pt | undefined)[], date?: string) => best(ps.filter((p) => p?.date && date && p.date < date));
type Agg = { top: Pt; prev?: Pt; loinc?: Pt; test?: Pt; count: number; outOfRange: number; first?: string };

// summarizeLabs as a fold, so a scan keeps a few compact results per test instead of every result: the same trends as
// grouping every result in the order added.
export function labTrends() {
  const sets = labSets<Agg>(() => ({ count: 0 }) as Agg);
  let seq = 0;
  const add = (o: Observation) => {
    const m0 = conceptMatch(o);
    const r = labRow(o, m0);
    const d = decides(o, m0, r.name);
    const n = num(o);
    const p: Pt = {
      seq: seq++, date: r.date, lu: o.meta?.lastUpdated, name: r.name, value: r.value, num: n, unit: unitOf(o),
      flag: highLow(o) ?? (r.interpretation && !/^n/i.test(r.interpretation) ? r.interpretation : undefined), method: d.m?.label, source: r.source, flags: r.flags,
      loinc: d.loinc, test: d.m?.concept.name,
    };
    const g = sets.add(d);
    if (!g.count) {
      Object.assign(g, { top: p, ...(d.loinc && { loinc: p }), ...(p.test && { test: p }), count: 1, outOfRange: highLow(o) ? 1 : 0, first: p.date });
      return;
    }
    g.count++;
    if (highLow(o)) g.outOfRange++;
    if (p.date && (!g.first || p.date.localeCompare(g.first) < 0)) g.first = p.date;
    if (d.loinc) g.loinc = best([g.loinc, p]);
    if (p.test) g.test = best([g.test, p]);
    if (ahead(p, g.top)) [g.prev, g.top] = [before([g.top, g.prev], p.date), p];
    else g.prev = best([g.prev, before([p], g.top.date)]);
  };
  const result = (): LabTrend[] =>
    sets.groups().map((gs) => {
      const l = best(gs.map((g) => g.top))!;
      // Each set's best result before the latest's day: its top, or (when its top shares that day) its own previous.
      const p = before(gs.flatMap((g) => [g.top, g.prev]), l.date);
      const a = l.num, b = p?.num;
      const firsts = gs.map((g) => g.first).filter((d): d is string => !!d);
      return {
        test: best(gs.map((g) => g.test))?.test, name: l.name, loinc: best(gs.map((g) => g.loinc))?.loinc, unit: l.unit,
        latest: { date: l.date, value: a ?? l.value, flag: l.flag, method: l.method },
        previous: p && { date: p.date, value: b ?? p.value, method: p.method },
        change: a !== undefined && b !== undefined && l.unit === p!.unit ? Math.round((a - b) * 1e6) / 1e6 : undefined,
        count: gs.reduce((n, g) => n + g.count, 0), outOfRange: gs.reduce((n, g) => n + g.outOfRange, 0),
        first: firsts.reduce<string | undefined>((x, d) => (!x || d.localeCompare(x) < 0 ? d : x), undefined), source: l.source, flags: l.flags,
      } satisfies LabTrend;
    }).sort((x, y) => (y.latest.date ?? '').localeCompare(x.latest.date ?? ''));
  return { add, result };
}

// For whats_new: a kept result's next older result in its group (the newest dated before it). Per set it keeps the newest
// result dated before `from` and the newest of each day since, so it grows with the results since `from`, not the whole
// history. keep: a result dated on or after `from` that done() will be asked about.
export function olderInGroup(from: string) {
  const sets = labSets<{ old?: Pt; days: Map<string, Pt> }>(() => ({ days: new Map() }));
  const kept = new Map<string, ReturnType<typeof sets.add>>();
  let seq = 0;
  const add = (o: Observation, keep = false) => {
    const m = conceptMatch(o);
    const r = labRow(o, m);
    const s = sets.add(decides(o, m, r.name));
    const p: Pt = { seq: seq++, date: r.date, lu: o.meta?.lastUpdated, value: r.value };
    if (keep && o.id && p.date && p.date >= from) kept.set(o.id, s);
    if (!p.date) return; // undated: never an older result
    if (p.date < from) s.old = best([s.old, p]);
    else s.days.set(p.date, best([s.days.get(p.date), p])!);
  };
  // (id, date): the older result of kept result id, dated before `date`.
  const done = () => {
    const groupOf = new Map<ReturnType<typeof sets.add>, ReturnType<typeof sets.add>[]>();
    for (const g of sets.groups()) for (const s of g) groupOf.set(s, g);
    return (id: string, date: string): { date?: string; value?: string } | undefined => {
      const s = kept.get(id);
      const p = before((s && groupOf.get(s) || []).flatMap((x) => [x.old, ...x.days.values()]), date);
      return p && { date: p.date, value: p.value };
    };
  };
  return { add, done };
}

// The lab concepts' entries, in concepts.json order (summarizeLabs already groups each into one entry).
export const keyLabs = (trends: LabTrend[]): LabTrend[] => concepts().filter((c) => c.kind === 'lab').flatMap((c) => trends.filter((t) => t.test === c.name));

export async function labResults(
  client: MedplumClient,
  patientId: string,
  { name, since, until, limit = 200, summary = false, keyOnly = false }: { name?: string | string[]; since?: string; until?: string; limit?: number; summary?: boolean; keyOnly?: boolean },
): Promise<{ rows: (LabRow | LabTrend)[]; total: number; truncated?: true }> {
  // An extracted result with some other category, or uncategorised with a vital's code (src/vitals.ts reads those), is not a lab.
  const isLab = (o: Observation) => !isPanel(o) && (!o.category?.length ? !isVitalCode(o.code) : o.category.some((c) => c.coding?.some((x) => x.code === 'laboratory')));
  // Older PDF imports have no category: the OR keeps them. _id breaks date ties so offset paging neither skips nor repeats.
  const query = (n?: string) => {
    const q = new URLSearchParams([
      ['subject', `Patient/${patientId}`],
      ['_filter', `category eq laboratory or _tag eq ${TAG}|extracted-by-llm`],
      ['_tag:not', `${TAG}|src-apple-health`],
      ['_sort', '-date,_id'],
      ['_count', '100'],
    ]);
    // A lab concept's name ("ldl") finds its member codes (GA-added too) plus the literal name (results not yet coded):
    // filtered here, Medplum can't OR code and code:text.
    const c = n ? conceptNamed(n) : undefined;
    const key = c?.kind === 'lab' ? new Set(codesFor(c.name).map((x) => `${x.system}|${x.code}`)) : undefined;
    if (n && !key) q.append('code:text', n);
    dateRange(q, 'date', since, until);
    // From the start of a word: "ast" must not match "fasting", while "ferr" still finds "ferritin".
    const word = new RegExp(`(^|[^a-z0-9])${norm(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const text = (o: Observation) => [o.code?.text, ...(o.code?.coding ?? []).map((c) => c.display)].some((t) => word.test(norm(t)));
    const named = (o: Observation) => !key || !!o.code?.coding?.some((x) => key.has(`${x.system}|${x.code}`)) || text(o);
    return { q, key, named, matches: (o: Observation) => (key ? named(o) : text(o)) };
  };
  // Every result: _lastUpdated with _count >= 20 pages by cursor (Medplum caps _offset at 10000); dates are ordered here.
  // Each result is folded into a trend or made a row as its page arrives: no result is kept whole.
  const scan = async (n: string | undefined, use: (o: Observation) => void) => {
    const { q, named } = query(n);
    q.set('_sort', '_lastUpdated');
    q.set('_count', '1000');
    await collect(client, 'Observation', q, (o: Observation) => { if (isLab(o) && named(o)) use(o); return undefined; }, Infinity);
  };
  const finish = async (n?: string, keep: (o: Observation) => boolean = () => true) => {
    if (summary) {
      const f = labTrends();
      await scan(n, (o) => keep(o) && f.add(o));
      // keyOnly (health_summary): key labs picked before fit, so other tests can't push them out.
      return fit(keyOnly ? keyLabs(f.result()) : f.result(), limit);
    }
    const rows: LabRow[] = [];
    await scan(n, (o) => keep(o) && rows.push(labRow(o)));
    return fit(rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')), limit); // undated last
  };
  if (Array.isArray(name)) {
    // One scan of every lab; a result is kept once when any name matches it (concept names match by code, others by text).
    const matchers = name.map((n) => query(n).matches);
    return finish(undefined, (o) => matchers.some((m) => m(o)));
  }
  const { q, key } = query(name);
  if (summary || key) return finish(name);
  const { rows } = await collect(client, 'Observation', q, (o: Observation) => (isLab(o) ? labRow(o) : undefined), limit);
  // Medplum sorts undated results first on -date; a latest-value question wants them last.
  // shortcut: only within the fetched pages, fine unless a patient has over a page of undated labs.
  rows.sort((a, b) => Number(!a.date) - Number(!b.date));
  return fit(rows, limit);
}
