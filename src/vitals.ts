// vitals: clinic and Apple Health vital signs as compact rows; Apple's daily summaries only on request (AGENTS.md "Apple Health data").
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { codesFor, conceptNamed } from './concepts.ts';
import { TAG } from './identity.ts';
import { collect, dateRange, fit, labRow, qty, type LabRow } from './labs.ts';

// Apple's per-day (and per-night) summaries are stored with these words in code.text (src/apple/daily.ts).
export const SUMMARY = /, (daily mean|daily total|daily|nightly)\b/i;
// Names that have such a summary; weight, BP, SpO2 and clinic vitals are readings only.
const HAS_DAILY = /heart|respirat|step|distance|flight|sleep|activ|ring/i;

type VitalRow = LabRow & { kind: string; setting: 'home' | 'clinic' };

export function vitalRow(o: Observation): VitalRow {
  const { source, ...row } = labRow(o);
  const parts = o.component?.map((c) => `${c.code?.text ?? c.code?.coding?.[0]?.display}: ${qty(c.valueQuantity) ?? c.valueString ?? ''}`);
  const apple = o.meta?.tag?.some((t) => t.code === 'src-apple-health');
  const src = apple ? `Apple Health${o.device?.display ? ` (${o.device.display})` : ''}` : source;
  return {
    ...row,
    ...(!row.value && parts?.length ? { value: parts.join('; ') } : {}),
    kind: SUMMARY.exec(row.name ?? '')?.[1] ?? 'reading',
    setting: apple ? 'home' : 'clinic',
    source: src,
  };
}

export async function vitals(
  client: MedplumClient,
  patientId: string,
  { name, since, until, limit = 200, daily = false }: { name?: string; since?: string; until?: string; limit?: number; daily?: boolean },
): Promise<{ rows: VitalRow[]; total: number; truncated?: true; hint?: string }> {
  // Summaries are Apple 'activity' rows; every vital-sign row (clinic or a home reading) is a reading. _id breaks date ties for paging.
  const q = new URLSearchParams([['subject', `Patient/${patientId}`], ['_sort', '-date,_id'], ['_count', '100']]);
  if (daily) q.append('_tag', `${TAG}|src-apple-health`);
  q.append('category', daily ? 'activity' : 'vital-signs');
  dateRange(q, 'date', since, until);
  // A vital concept's name ("weight") also finds its member codes: a second search, Medplum can't OR code and code:text.
  const c = name && !daily ? conceptNamed(name) : undefined;
  const by: [string, string][] = name ? [['code:text', name]] : [];
  if (c?.kind === 'vital') by.push(['code', codesFor(c.name).map((x) => `${x.system}|${x.code}`).join(',')]);
  const found = await Promise.all((by.length ? by : [undefined]).map((p) => {
    const s = new URLSearchParams(q);
    if (p) s.append(...p);
    return collect(client, 'Observation', s, (o: Observation) => (!daily || SUMMARY.test(o.code?.text ?? '') ? vitalRow(o) : undefined), limit);
  }));
  const ids = new Set<string | undefined>();
  const rows = found.length === 1 ? found[0].rows : found.flatMap((f) => f.rows).filter((r) => !ids.has(r.id) && !!ids.add(r.id)).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  // Weight, BP and most vitals have no Apple daily summary: an empty daily answer would read as "no data".
  if (daily && !rows.length) {
    const r = await vitals(client, patientId, { name, since, until, limit });
    return { ...r, hint: `no daily summaries for this; these are readings${r.hint ? `; ${r.hint}` : ''}` };
  }
  const out = fit(rows, limit, found.some((f) => f.more));
  const longRange = !daily && (!name || HAS_DAILY.test(name)) ? 'use daily: true for long-range trends, or ' : '';
  return out.truncated ? { ...out, hint: `more results: ${longRange}narrow the dates or the name` } : out;
}
