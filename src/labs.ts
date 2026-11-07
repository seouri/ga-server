// lab_results: the patient's lab Observations as compact rows, encoding what GA knows about where labs live.
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Observation, Quantity, Resource, ResourceType } from '@medplum/fhirtypes';
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

export function labRow(o: Observation): LabRow {
  const c = o.code?.coding?.[0];
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
    flags: flagsOf(o.meta),
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
export function fit<R>(rows: R[], limit: number, more = false): { rows: R[]; total: number; truncated?: true } {
  let size = 0;
  const cut = rows.slice(0, limit).findIndex((r) => (size += JSON.stringify(r).length + 1) > BUDGET);
  const truncated = more || rows.length > limit || cut >= 0;
  const out = rows.slice(0, cut >= 0 ? cut : limit);
  return { rows: out, total: out.length, ...(truncated ? { truncated: true as const } : {}) };
}

const LOINC = 'http://loinc.org';
const loincOf = (o: Observation) => o.code?.coding?.find((c) => c.system === LOINC)?.code;
const norm = (s = '') => s.toLowerCase().replace(/\s+/g, ' ').trim();
// The same test under different names across sources ("LOW DENSITY LIPOPROTEIN CHOL" with a LOINC, "LDL cholesterol" from a PDF without one):
// [label, LOINC codes, name pattern]; NOT keeps urine, ratio and particle tests out of the name match.
// shortcut: eGFR misses race-variant codes, and the name patterns can still take urine/CSF/receptor/LDL-P look-alikes; both move to the planned concept-matching layer.
export const KEY_LABS: [string, string[], RegExp][] = [
  ['A1c', ['4548-4', '17856-6'], /a1c|glycated h/],
  ['Glucose', ['2345-7', '2339-0', '1558-6'], /^glucose\b/],
  ['LDL', ['13457-7', '18262-6', '2089-1'], /\bldl\b|low density lipo/],
  ['HDL', ['2085-9'], /\bhdl\b|high density lipo/],
  ['Total cholesterol', ['2093-3'], /^(total )?cholesterol(,? total)?$/],
  ['Triglycerides', ['2571-8'], /^triglyceride/],
  ['Creatinine', ['2160-0'], /^creatinine\b/],
  ['eGFR', ['33914-3', '48642-3', '48643-1', '62238-1', '98979-8'], /egfr|glomerular/],
  ['ALT', ['1742-6', '1743-4'], /^alt\b|alanine amino/],
  ['AST', ['1920-8'], /^ast\b|aspartate amino/],
  ['Hemoglobin', ['718-7'], /^(h(a)?emoglobin|hgb)\b(?!.*(a1c|glyc))/],
  ['Platelets', ['777-3', '26515-7'], /^(platelets?|plt)( count)?$/],
  ['Potassium', ['2823-3', '6298-4'], /^potassium\b/],
  ['Sodium', ['2951-2', '2947-0'], /^sodium\b/],
  ['TSH', ['3016-3', '11580-8'], /\btsh\b|thyrotropin|thyroid stimulating/],
];
const NOT = /urine|\bur\b|ratio|non[- ]?hdl|particle|clearance/;
const byName = (n: string) => KEY_LABS.find(([label, , re]) => n === label.toLowerCase() || (re.test(n) && !NOT.test(n)))?.[0];
// The key lab a result is (by LOINC, else by name), or the one a lab_results name asks for.
export const keyLabOf = (o: Observation) => KEY_LABS.find(([, codes]) => codes.includes(loincOf(o) ?? ''))?.[0] ?? byName(norm(labRow(o).name));

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
  test?: string; name?: string; loinc?: string; unit?: string; latest: { date?: string; value?: string | number; flag?: string }; previous?: { date?: string; value?: string | number };
  change?: number; count: number; outOfRange: number; first?: string; source?: string; flags?: string[];
};

// One entry per test: a key lab (any code or name) is one group; others by LOINC, else by name (case/space-insensitive), and an uncoded
// result joins the LOINC group of the same name.
export function summarizeLabs(obs: Observation[]): LabTrend[] {
  const rows = obs.map((o) => ({ o, r: labRow(o), test: keyLabOf(o) }));
  const coded = new Map(rows.flatMap(({ o, r }) => { const l = loincOf(o); return l ? [[norm(r.name), l] as const] : []; }));
  const groups = new Map<string, typeof rows>();
  for (const x of rows) {
    if (!x.test && !loincOf(x.o) && !norm(x.r.name)) continue; // nothing to group by
    const k = x.test ? `key:${x.test}` : loincOf(x.o) ?? coded.get(norm(x.r.name)) ?? norm(x.r.name);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.values()].map((g): LabTrend => {
    // Undated last; the same day: the newest written first.
    g.sort((a, b) => (b.r.date ?? '').localeCompare(a.r.date ?? '') || (b.o.meta?.lastUpdated ?? '').localeCompare(a.o.meta?.lastUpdated ?? ''));
    const [l] = g;
    const p = g.find((x) => x.r.date && l.r.date && x.r.date < l.r.date);
    const a = num(l.o), b = p && num(p.o);
    const flag = highLow(l.o) ?? (l.r.interpretation && !/^n/i.test(l.r.interpretation) ? l.r.interpretation : undefined);
    return {
      test: l.test, name: l.r.name, loinc: g.map((x) => loincOf(x.o)).find(Boolean), unit: unitOf(l.o),
      latest: { date: l.r.date, value: a ?? l.r.value, flag },
      previous: p && { date: p.r.date, value: b ?? p.r.value },
      change: a !== undefined && b !== undefined && unitOf(l.o) === unitOf(p!.o) ? Math.round((a - b) * 1e6) / 1e6 : undefined,
      count: g.length, outOfRange: g.filter((x) => highLow(x.o)).length, first: g.findLast((x) => x.r.date)?.r.date, source: l.r.source, flags: l.r.flags,
    };
  }).sort((x, y) => (y.latest.date ?? '').localeCompare(x.latest.date ?? ''));
}

// The key labs, in table order (summarizeLabs already groups each into one entry).
export const keyLabs = (trends: LabTrend[]): LabTrend[] => KEY_LABS.flatMap(([test]) => trends.filter((t) => t.test === test));

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
  // A key-lab name ("ldl") also finds that test under its LOINC codes and other names: filtered here, Medplum can't OR code and code:text.
  const key = name ? byName(norm(name)) : undefined;
  if (name && !key) q.append('code:text', name);
  dateRange(q, 'date', since, until);
  // An extracted result with some other category (e.g. a vital sign) is not a lab.
  const isLab = (o: Observation) => !o.category?.length || o.category.some((c) => c.coding?.some((x) => x.code === 'laboratory'));
  const named = (o: Observation) => !key || keyLabOf(o) === key || [o.code?.text, ...(o.code?.coding ?? []).map((c) => c.display)].some((t) => norm(t).includes(norm(name)));
  if (summary || key) {
    // Every result: _lastUpdated with _count >= 20 pages by cursor (Medplum caps _offset at 10000); dates are ordered here.
    q.set('_sort', '_lastUpdated');
    q.set('_count', '1000');
    const obs = (await collect(client, 'Observation', q, (o: Observation) => (isLab(o) && named(o) ? o : undefined), Infinity)).rows;
    // keyOnly (health_summary): key labs picked before fit, so other tests can't push them out.
    if (summary) return fit(keyOnly ? keyLabs(summarizeLabs(obs)) : summarizeLabs(obs), limit);
    return fit(obs.map(labRow).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')), limit); // undated last
  }
  const { rows } = await collect(client, 'Observation', q, (o: Observation) => (isLab(o) ? labRow(o) : undefined), limit);
  // Medplum sorts undated results first on -date; a latest-value question wants them last.
  // shortcut: only within the fetched pages, fine unless a patient has over a page of undated labs.
  rows.sort((a, b) => Number(!a.date) - Number(!b.date));
  return fit(rows, limit);
}
