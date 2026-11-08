// vitals: clinic and Apple Health vital signs as compact rows; Apple's daily summaries only on request (AGENTS.md "Apple Health data").
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { codesFor, conceptNamed, isVitalCode } from './concepts.ts';
import { isClinic, TAG } from './identity.ts';
import { collect, dateRange, fit, labRow, qty, type LabRow } from './labs.ts';

// Apple's per-day (and per-night) summaries are stored with these words in code.text (src/apple/daily.ts).
export const SUMMARY = /, (daily mean|daily total|daily|nightly)\b/i;
// Names that have such a summary; weight, BP, SpO2 and clinic vitals are readings only.
const HAS_DAILY = /heart|respirat|step|distance|flight|sleep|activ|ring/i;

type VitalRow = LabRow & { kind: string; setting: 'home' | 'clinic' | 'unknown' };

// The searches for a vital name: its text, plus its concept's member codes ("weight": 29463-7). Two searches: Medplum can't OR code and code:text.
export const vitalSearches = (name: string): [string, string][] => {
  const c = conceptNamed(name);
  return [['code:text', name], ...(c?.kind === 'vital' ? [['code', codesFor(c.name).map((x) => `${x.system}|${x.code}`).join(',')] as [string, string]] : [])];
};
// Merged searches: one row per record, newest first, undated last.
export const newestFirst = <R extends { id?: string; date?: string }>(rows: R[]): R[] =>
  [...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

export function vitalRow(o: Observation): VitalRow {
  const { source, ...row } = labRow(o);
  const parts = o.component?.map((c) => `${c.code?.text ?? c.code?.coding?.[0]?.display}: ${qty(c.valueQuantity) ?? c.valueString ?? ''}`);
  const tags = new Set(o.meta?.tag?.filter((t) => t.system === TAG).map((t) => t.code));
  const apple = tags.has('src-apple-health');
  const src = apple ? `Apple Health${o.device?.display ? ` (${o.device.display})` : ''}` : source;
  return {
    ...row,
    ...(!row.value && parts?.length ? { value: parts.join('; ') } : {}),
    kind: SUMMARY.exec(row.name ?? '')?.[1] ?? 'reading',
    // A PDF or photo doesn't say where a reading was taken (a home monitor log looks like a clinic printout).
    setting: apple ? 'home' : isClinic(o) ? 'clinic' : 'unknown',
    source: src,
  };
}

const SYS = /systolic/i, DIA = /diastolic/i;
const part = (o: Observation, code: string, re: RegExp) => o.code?.coding?.some((c) => c.code === code) || re.test(o.code?.text ?? '');
// Hospitals often store a blood pressure as two records (systolic 8480-6, diastolic 8462-4) at the same moment: one reading, as Apple's panel.
export function pairBloodPressure(obs: Observation[]): Observation[] {
  const key = (o: Observation) => `${o.effectiveDateTime ?? ''}|${o.meta?.source ?? ''}`;
  const dias = new Map(obs.filter((o) => o.effectiveDateTime && part(o, '8462-4', DIA) && o.valueQuantity).map((o) => [key(o), o]));
  const used = new Set<Observation>();
  const out = obs.map((o) => {
    const d = o.effectiveDateTime && part(o, '8480-6', SYS) && o.valueQuantity ? dias.get(key(o)) : undefined;
    if (!d || d === o || used.has(d)) return o;
    used.add(d);
    return { ...o, code: { text: 'Blood pressure' }, valueQuantity: undefined, component: [{ code: { text: 'Systolic' }, valueQuantity: o.valueQuantity }, { code: { text: 'Diastolic' }, valueQuantity: d.valueQuantity }] } as Observation;
  });
  return out.filter((o) => !used.has(o));
}

export async function vitals(
  client: MedplumClient,
  patientId: string,
  { name, since, until, limit = 200, daily = false }: { name?: string; since?: string; until?: string; limit?: number; daily?: boolean },
): Promise<{ rows: VitalRow[]; total: number; truncated?: true; hint?: string }> {
  // Summaries are Apple 'activity' rows. Readings: every vital-sign row (clinic or home), Apple's activity readings (walking steadiness,
  // six-minute walk, heart-rate recovery) and uncategorised PDF results of a vital concept (lab_results leaves those out). _id breaks date ties for paging.
  const q = new URLSearchParams([['subject', `Patient/${patientId}`], ['_sort', '-date,_id'], ['_count', '100']]);
  if (daily) q.append('_tag', `${TAG}|src-apple-health`);
  if (daily) q.append('category', 'activity');
  else q.append('_filter', `category eq vital-signs or category eq activity or _tag eq ${TAG}|extracted-by-llm`);
  const cats = (o: Observation) => o.category?.flatMap((c) => c.coding?.map((x) => x.code) ?? []) ?? [];
  const reading = (o: Observation) => !o.category?.length ? isVitalCode(o.code) : cats(o).includes('vital-signs') || (cats(o).includes('activity') && !SUMMARY.test(o.code?.text ?? ''));
  dateRange(q, 'date', since, until);
  // Daily summaries carry no vital concept code: by text only.
  const by = !name ? [] : daily ? [['code:text', name] as [string, string]] : vitalSearches(name);
  const found = await Promise.all((by.length ? by : [undefined]).map((p) => {
    const s = new URLSearchParams(q);
    if (p) s.append(...p);
    return collect(client, 'Observation', s, (o: Observation) => ((daily ? SUMMARY.test(o.code?.text ?? '') : reading(o)) ? o : undefined), limit);
  }));
  const obs = [...new Map(found.flatMap((f) => f.rows).map((o) => [o.id, o])).values()];
  const rows = newestFirst(pairBloodPressure(obs).map(vitalRow));
  // Weight, BP and most vitals have no Apple daily summary: an empty daily answer would read as "no data".
  if (daily && !rows.length) {
    const r = await vitals(client, patientId, { name, since, until, limit });
    return { ...r, hint: `no daily summaries for this; these are readings${r.hint ? `; ${r.hint}` : ''}` };
  }
  const out = fit(rows, limit, found.some((f) => f.more));
  const longRange = !daily && (!name || HAS_DAILY.test(name)) ? 'use daily: true for long-range trends, or ' : '';
  return out.truncated ? { ...out, hint: `more results: ${longRange}narrow the dates or the name` } : out;
}
