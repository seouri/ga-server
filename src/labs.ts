// lab_results: the patient's lab Observations as compact rows, encoding what GA knows about where labs live.
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Observation, Quantity } from '@medplum/fhirtypes';
import { GaError } from './config.ts';

const TAG = 'urn:ga-server:tag|';
const PAGE = 100;
const BUDGET = 140_000; // stays under the remote 150k tool-result cap, so rows are never cut mid-JSON

export type LabRow = { date?: string; name?: string; value?: string; range?: string; interpretation?: string; source?: string; flags?: string[]; id?: string };

const qty = (q?: Quantity) => (q?.value === undefined ? undefined : `${q.comparator ?? ''}${q.value}${q.unit ?? q.code ? ` ${q.unit ?? q.code}` : ''}`);

export function labRow(o: Observation): LabRow {
  const c = o.code?.coding?.[0];
  const r = o.referenceRange?.[0];
  const lo = qty(r?.low), hi = qty(r?.high);
  const range = r?.text ?? (lo && hi ? `${r?.low?.value}–${hi}` : lo ? `≥${lo}` : hi ? `≤${hi}` : undefined);
  const tags = new Set(o.meta?.tag?.map((t) => t.code));
  const flags = [...(tags.has('extracted-by-llm') ? ['read from a document by AI'] : []), ...(tags.has('possible-duplicate') ? ['possible-duplicate'] : [])];
  const row: LabRow = {
    date: (o.effectiveDateTime ?? o.effectivePeriod?.start ?? o.effectiveInstant ?? o.issued)?.slice(0, 10),
    name: o.code?.text ?? c?.display ?? c?.code,
    value: qty(o.valueQuantity) ?? o.valueString ?? o.valueCodeableConcept?.text ?? o.valueCodeableConcept?.coding?.[0]?.display,
    range,
    interpretation: o.interpretation?.[0]?.coding?.[0]?.code ?? o.interpretation?.[0]?.text,
    source: o.meta?.source ? basename(o.meta.source) : undefined,
    flags: flags.length ? flags : undefined,
    id: o.id,
  };
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as LabRow;
}

const validDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d);

export async function labResults(
  client: MedplumClient,
  patientId: string,
  { name, since, until, limit = 200 }: { name?: string; since?: string; until?: string; limit?: number },
): Promise<{ rows: LabRow[]; total: number; truncated?: true }> {
  for (const [k, d] of [['since', since], ['until', until]] as const) if (d !== undefined && !validDay(d)) throw new GaError(`${k} must be a date YYYY-MM-DD`);
  // Older PDF imports have no category: the OR keeps them. _id breaks date ties so offset paging neither skips nor repeats.
  const q = new URLSearchParams([
    ['subject', `Patient/${patientId}`],
    ['_filter', `category eq laboratory or _tag eq ${TAG}extracted-by-llm`],
    ['_tag:not', `${TAG}src-apple-health`],
    ['_sort', '-date,_id'],
    ['_count', String(PAGE)],
  ]);
  if (name) q.append('code:text', name);
  if (since) q.append('date', `ge${since}`);
  // le<day> would drop results later on that day: lt the next day.
  if (until) q.append('date', `lt${new Date(Date.parse(until) + 86_400_000).toISOString().slice(0, 10)}`);
  const rows: LabRow[] = [];
  let b: Bundle<Observation> | undefined = await client.search('Observation', q, { cache: 'no-cache' });
  while (b) {
    for (const e of b.entry ?? []) {
      const o = e.resource;
      // An extracted result with some other category (e.g. a vital sign) is not a lab.
      if (o && (!o.category?.length || o.category.some((c) => c.coding?.some((x) => x.code === 'laboratory')))) rows.push(labRow(o));
    }
    const next: string | undefined = b.link?.find((l) => l.relation === 'next')?.url;
    // Follow by path: the link's host is Medplum's configured base, which the gateway container may not reach.
    b = rows.length > limit || !next ? undefined : await client.get<Bundle<Observation>>(next.replace(/^\w+:\/\/[^/]+\//, ''), { cache: 'no-cache' });
  }
  let size = 0;
  const fit = rows.slice(0, limit).findIndex((r) => (size += JSON.stringify(r).length + 1) > BUDGET);
  const truncated = rows.length > limit || fit >= 0;
  rows.length = fit >= 0 ? fit : Math.min(rows.length, limit);
  return { rows, total: rows.length, ...(truncated ? { truncated: true as const } : {}) };
}
