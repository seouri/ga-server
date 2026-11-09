// current_medications, current_problems, allergies: active records with the currency rule (src/current.ts) already applied.
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Endpoint, Resource } from '@medplum/fhirtypes';
import { trusted } from './concept-apply.ts';
import { RXNORM } from './concepts.ts';
import { currencyContext, explain, isPlanned, smartKeys, type Ctx } from './current.ts';
import { TAG } from './identity.ts';
import { collect, fit, flagsOf } from './labs.ts';
import { newestEpicImport } from './share/scope.ts';

export type Kind = 'medications' | 'problems' | 'allergies';
type ListRow = { name?: string; status?: string; currency?: string; reason?: string; since?: string; source?: string; flags?: string[]; type?: string; id?: string; ids?: string[] };

type Any = Record<string, any>;
const TYPES: Record<Kind, string[]> = { medications: ['MedicationStatement', 'MedicationRequest'], problems: ['Condition'], allergies: ['AllergyIntolerance'] };
export const concept = (c?: Any): string | undefined => c?.text ?? c?.coding?.find((x: Any) => x.display)?.display ?? c?.coding?.[0]?.code;
const rank = (r: ListRow) => ['current', 'unconfirmed', undefined, 'none known', 'planned', 'inactive'].indexOf(r.currency);

// A "no known allergies" statement (SNOMED situations, as hospitals' FHIR and GA's C-CDA import code it) is no allergy.
const NO_KNOWN: Record<string, string> = { '716186003': 'No known allergies', '409137002': 'No known drug allergies', '429625007': 'No known food allergies', '428607008': 'No known environmental allergies' };
const noKnown = (r: Any): string | undefined => r.code?.coding?.map((c: Any) => (c.system === 'http://snomed.info/sct' ? NO_KNOWN[c.code] : undefined)).find(Boolean);

export const medMap = (all: Resource[]) => new Map(all.filter((r) => r.resourceType === 'Medication').map((m) => [`Medication/${m.id}`, m]));


// The drug's concept: its own, else the referenced Medication's code, else the reference's display. meds: Medication by `Medication/<id>`.
export const medCode = (r: Resource, meds: Map<string, Resource>): { cc?: CodeableConcept; owner: Resource } => {
  const x = r as Record<string, any>;
  const ref = x.medicationReference as { reference?: string; display?: string } | undefined;
  const m = ref?.reference ? meds.get(ref.reference) : undefined;
  if (x.medicationCodeableConcept) return { cc: x.medicationCodeableConcept, owner: r };
  if ((m as Record<string, any> | undefined)?.code) return { cc: (m as Record<string, any>).code, owner: m! };
  return { cc: ref?.display ? { text: ref.display } : undefined, owner: r };
};
// Both keys of a drug (its RxNorm code and its name), so an uncoded copy of a coded drug is the same drug.
export const medKeys = (cc?: CodeableConcept, owner?: Resource): string[] => {
  const rx = (owner ? trusted(owner, cc?.coding) : cc?.coding ?? []).find((c) => c.system === RXNORM)?.code;
  const name = concept(cc)?.toLowerCase().replace(/\s+/g, ' ').trim();
  return [...(rx ? [`rx:${rx}`] : []), ...(name ? [`name:${name}`] : [])];
};

// all: every fetched resource (all four covered types, any status, plus included Medications); the context needs them all.
export function listRows(all: Resource[], ctx: Ctx, kind: Kind, include?: 'all'): ListRow[] {
  const meds = medMap(all);
  const items = all.flatMap((res): { row: ListRow; keys: string[]; code?: string }[] => {
    const r = res as Any;
    if (!TYPES[kind].includes(r.resourceType)) return [];
    if (kind === 'problems' && !r.category?.some((c: Any) => c.coding?.some((x: Any) => x.code === 'problem-list-item'))) return [];
    const e = explain(res, ctx);
    const status = r.status ?? r.clinicalStatus?.coding?.[0]?.code;
    // An allergy without a clinical status is still listed: leaving out a real allergy is the worse mistake.
    const unstated = kind === 'allergies' && !status && !r.verificationStatus?.coding?.some((c: Any) => ['refuted', 'entered-in-error'].includes(c.code));
    if (!e && !unstated && include !== 'all') return [];
    const keys = smartKeys(res);
    const tags = new Set(r.meta?.tag?.filter((t: Any) => t.system === TAG).map((t: Any) => t.code));
    const row: ListRow = {
      name: concept(r.medicationCodeableConcept) ?? concept(meds.get(r.medicationReference?.reference)?.code) ?? r.medicationReference?.display ?? concept(r.code),
      status: status ?? 'not stated',
      currency: e?.currency ?? (unstated ? undefined : isPlanned(res) ? 'planned' : 'inactive'),
      reason: e?.reason ?? (unstated ? 'no clinical status recorded; treat as possibly active' : isPlanned(res) ? 'planned or proposed in a plan of treatment; not taken yet' : undefined),
      since: (r.effectiveDateTime ?? r.effectivePeriod?.start ?? r.authoredOn ?? r.onsetDateTime ?? r.onsetPeriod?.start ?? r.recordedDate ?? r.dateAsserted)?.slice(0, 10),
      source: keys.length
        ? `hospital portal ${keys.join(', ')}`
        : tags.has('src-apple-health') ? 'Apple Health copy of a hospital record (prefer the hospital source)' : r.meta?.source ? basename(r.meta.source) : undefined,
      flags: flagsOf(r.meta),
      type: kind === 'medications' ? r.resourceType : undefined,
      id: r.id,
    };
    // A "no known allergies" statement, active or with no clinical status, is no allergy
    const none = kind === 'allergies' && (e || unstated) ? noKnown(r) : undefined;
    if (none) Object.assign(row, { name: none, currency: 'none known', reason: 'a "no known allergies" statement in the record, not an allergy' });
    // A refuted allergy is never current (isActive); with include "all" it reads as what it says
    else if (kind === 'allergies' && r.verificationStatus?.coding?.some((c: Any) => c.code === 'refuted')) {
      const nk = noKnown(r); // a withdrawn "no known allergies" statement says nothing about any substance
      Object.assign(row, nk ? { name: `${nk} (refuted)`, reason: 'refuted: the record withdraws this "no known allergies" statement' } : { name: `Not allergic to ${row.name ?? 'the substance'}`, reason: 'refuted: the record says the person is not allergic' });
    }
    const cc = kind === 'medications' ? medCode(res, meds).cc : r.code;
    const name = (none ?? concept(cc))?.toLowerCase().replace(/\s+/g, ' ').trim();
    const dupKeys = kind === 'medications' ? medKeys(cc, res) : name ? [`name:${name}`] : [];
    const coding = kind === 'medications' ? undefined : r.code?.coding?.find((x: Any) => x.system && x.code);
    return [{ row, keys: dupKeys, code: coding && `${coding.system}|${coding.code}` }];
  });
  // One row per item across sources: same RxNorm or name (problems, allergies: and no differing standard codes). The best currency wins.
  const groups: { best: ListRow; keys: Set<string>; code?: string; sources: Set<string>; ids: string[] }[] = [];
  for (const { row, keys, code } of items) {
    const g = keys.length ? groups.find((g) => keys.some((k) => g.keys.has(k)) && !(code && g.code && code !== g.code)) : undefined;
    if (!g) { groups.push({ best: row, keys: new Set(keys), code, sources: new Set(row.source ? [row.source] : []), ids: row.id ? [row.id] : [] }); continue; }
    keys.forEach((k) => g.keys.add(k));
    g.code ??= code;
    if (row.source) g.sources.add(row.source);
    if (row.id) g.ids.push(row.id);
    if (rank(row) < rank(g.best)) g.best = row;
  }
  const rows = groups.map((g): ListRow => ({
    ...g.best,
    ...(g.sources.size ? { source: [...g.sources].sort().join('; ') } : {}),
    ...(g.ids.length > 1 ? { ids: g.ids } : {}),
  }));
  // Current first, then unconfirmed, unstated, inactive; newest first within each.
  return rows.sort((a, b) => rank(a) - rank(b) || (b.since ?? '').localeCompare(a.since ?? ''));
}

// Every covered record and the currency context, fetched once. eps: the patient's source Endpoints (read once, also for the stale-source warning).
export async function loadLists(client: MedplumClient, patientId: string, eps: Endpoint[]): Promise<{ all: Resource[]; ctx: Ctx }> {
  // A page may hold at most 1000 entries, includes counted (Medplum and GA's store refuse more): 500 matches leave room for their Medications.
  const all = (type: string, q: string[][]) => collect(client, type as 'Observation', new URLSearchParams([...q, ['_count', q.some(([k]) => k === '_include') ? '500' : '1000']]), (r: Resource) => r, Infinity).then((x) => x.rows);
  const subject = ['subject', `Patient/${patientId}`];
  const [ms, mr, cond, alg, newest] = await Promise.all([
    all('MedicationStatement', [subject, ['_include', 'MedicationStatement:medication']]),
    all('MedicationRequest', [subject, ['_include', 'MedicationRequest:medication']]),
    all('Condition', [subject]),
    all('AllergyIntolerance', [['patient', `Patient/${patientId}`]]),
    newestEpicImport(client, patientId),
  ]);
  return { all: [...ms, ...mr, ...cond, ...alg], ctx: currencyContext([], eps, newest) };
}

export async function currentList(client: MedplumClient, patientId: string, kind: Kind, include: 'all' | undefined, eps: Endpoint[]): Promise<{ rows: ListRow[]; total: number; truncated?: true }> {
  const { all, ctx } = await loadLists(client, patientId, eps);
  return fit(listRows(all, ctx, kind, include), 1000);
}
