// Lab test helpers: random results that exercise the grouping rules, and the grouping and whats_new labItems as they were
// before they became folds (every result held, grouped, each group sorted), frozen here as oracles for the folds.
import type { Observation } from '@medplum/fhirtypes';
import { dirname } from 'node:path';
import { CONCEPT_SRC } from '../../src/concept-apply.ts';
import { termKey } from '../../src/conceptmap.ts';
import { conceptMatch, highLow, labRow } from '../../src/labs.ts';
import { clinicalDate, type ReviewItem } from '../../src/whats-new.ts';
import { addDays } from '../../src/vaccines.ts';

const TAG = 'urn:ga-server:tag';
const loincOf = (o: Observation) => o.code?.coding?.find((c) => c.system === 'http://loinc.org')?.code;
const norm = (s = '') => s.toLowerCase().replace(/\s+/g, ' ').trim();
function sourcesOf(o: Observation): string[] {
  const kinds = (o.meta?.tag ?? []).flatMap((t) => (t.system === TAG && t.code?.startsWith('src-') ? [t.code.slice(4)] : []));
  const ids = [o.identifier ?? []].flat().map((i) => i.system ?? '');
  return kinds.flatMap((k) => {
    if (k === 'ehi' || k === 'smart') return ids.filter((s) => s.startsWith(`urn:ga-server:id:${k}:`));
    return [k === 'ccda' ? `ccda:${dirname(o.meta?.source ?? '')}` : k];
  });
}

// grouped() / groupLabs as of 557de0f.
export function heldGroups(obs: Observation[]): Observation[][] {
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
    if (!k) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(x);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => (b.r.date ?? '').localeCompare(a.r.date ?? '') || (b.o.meta?.lastUpdated ?? '').localeCompare(a.o.meta?.lastUpdated ?? '')).map((x) => x.o));
}

// whats_new labItems as of 557de0f.
export function heldLabItems(arrived: Observation[], allLabs: Observation[], asOf: string): ReviewItem[] {
  const cutoff = addDays(asOf, -365);
  const groups = heldGroups(allLabs);
  return arrived.flatMap((o): ReviewItem[] => {
    const flag = highLow(o), date = clinicalDate(o);
    if (!flag || !date || date < cutoff) return [];
    const row = labRow(o);
    const older = groups.find((g) => g.some((x) => x.id === o.id))?.find((x) => { const d = clinicalDate(x); return d && d < date; });
    const p = older && labRow(older);
    return [{ kind: 'lab', title: row.name ?? 'Lab result', date, detail: { value: row.value, range: row.range, flag, previous: p && { date: p.date, value: p.value } }, source: row.source, id: o.id }];
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

// n random results: ties, undated, uncoded twins across sources, guesses, unmatched. rnd(n): a seeded integer below n.
export function randomLabs(rnd: (n: number) => number, n = 60): Observation[] {
  const pick = <T,>(xs: T[]) => xs[rnd(xs.length)];
  const tag = (...codes: string[]) => codes.map((code) => ({ system: TAG, code }));
  const ga = (code: string) => ({ system: 'http://loinc.org', code, extension: [{ url: CONCEPT_SRC, valueCode: 'agent' }] });
  return Array.from({ length: n }, (_, i) => {
    const name = pick(['Glucose', 'glucose ', 'LDL', 'Hemoglobin A1c', 'eGFR', 'Other', '']);
    const coding = pick([[], [], [{ system: 'http://loinc.org', code: pick(['2345-7', '13457-7', '4548-4', '98979-8', '48642-3', '9999-9']) }], [ga(pick(['2345-7', '13457-7']))]]);
    const src = pick(['ehi', 'pdf', 'ccda']);
    const codes = [`src-${src}`, ...(coding.length && rnd(3) === 0 ? ['concept-suggested'] : []), ...(rnd(8) === 0 ? ['concept-unmatched'] : []), ...(coding.some((c) => 'extension' in c) ? ['extracted-by-llm'] : [])];
    return {
      resourceType: 'Observation', id: `o${i}`, status: 'final', code: { ...(name && { text: name }), coding },
      ...(rnd(6) ? { effectiveDateTime: pick(['2024-01-01', '2024-01-01T09:00:00Z', '2023-05-02', '2025-03-03', '2022-12-31']) } : {}),
      valueQuantity: rnd(5) ? { value: rnd(200), unit: pick(['mg/dL', 'mg/dL', 'mmol/L']) } : { comparator: '<', value: 5, unit: 'mg/dL' },
      ...(rnd(3) === 0 && { interpretation: [{ coding: [{ code: pick(['H', 'L', 'N', 'A']) }] }] }),
      ...(rnd(3) === 0 && { referenceRange: [{ low: { value: 50 }, high: { value: 150 } }] }),
      ...(src === 'ehi' && { identifier: [{ system: `urn:ga-server:id:ehi:${pick(['a', 'b'])}`, value: `x${i}` }] }),
      meta: { tag: tag(...codes), lastUpdated: pick(['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', undefined]), source: `/data/${src}/${pick(['one', 'two'])}.file` },
    } as Observation;
  });
}

export const seeded = (seed: number) => (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
