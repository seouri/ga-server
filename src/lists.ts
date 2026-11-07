// current_medications, current_problems, allergies: active records with the currency rule (src/current.ts) already applied.
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Endpoint, Resource } from '@medplum/fhirtypes';
import { currencyContext, explain, type Ctx } from './current.ts';
import { TAG } from './identity.ts';
import { collect, fit } from './labs.ts';
import { forPatient, SOURCE_ID } from './smart/sync.ts';

export type Kind = 'medications' | 'problems' | 'allergies';
export type ListRow = { name?: string; status?: string; currency?: string; reason?: string; since?: string; source?: string; flags?: string[]; type?: string; id?: string };

type Any = Record<string, any>;
const SMART_ID = 'urn:ga-server:id:smart:';
const TYPES: Record<Kind, string[]> = { medications: ['MedicationStatement', 'MedicationRequest'], problems: ['Condition'], allergies: ['AllergyIntolerance'] };
const concept = (c?: Any): string | undefined => c?.text ?? c?.coding?.find((x: Any) => x.display)?.display ?? c?.coding?.[0]?.code;
const rank = (r: ListRow) => ['current', 'unconfirmed', undefined, 'inactive'].indexOf(r.currency);

// all: every fetched resource (all four covered types, any status, plus included Medications); the context needs them all.
export function listRows(all: Resource[], ctx: Ctx, kind: Kind, include?: 'all'): ListRow[] {
  const meds = new Map(all.filter((r) => r.resourceType === 'Medication').map((m) => [`Medication/${m.id}`, m as Any]));
  const rows = all.flatMap((res): ListRow[] => {
    const r = res as Any;
    if (!TYPES[kind].includes(r.resourceType)) return [];
    if (kind === 'problems' && !r.category?.some((c: Any) => c.coding?.some((x: Any) => x.code === 'problem-list-item'))) return [];
    const e = explain(res, ctx);
    const status = r.status ?? r.clinicalStatus?.coding?.[0]?.code;
    // An allergy without a clinical status is still listed: leaving out a real allergy is the worse mistake.
    const unstated = kind === 'allergies' && !status && !['refuted', 'entered-in-error'].includes(r.verificationStatus?.coding?.[0]?.code);
    if (!e && !unstated && include !== 'all') return [];
    const keys = (r.identifier ?? []).filter((i: Any) => i.system?.startsWith(SMART_ID)).map((i: Any) => i.system.slice(SMART_ID.length));
    const tags = new Set(r.meta?.tag?.filter((t: Any) => t.system === TAG).map((t: Any) => t.code));
    const flags = [...(tags.has('extracted-by-llm') ? ['read from a document by AI'] : []), ...(tags.has('possible-duplicate') ? ['possible-duplicate'] : [])];
    const row: ListRow = {
      name: concept(r.medicationCodeableConcept) ?? concept(meds.get(r.medicationReference?.reference)?.code) ?? r.medicationReference?.display ?? concept(r.code),
      status: status ?? 'not stated',
      currency: e?.currency ?? (unstated ? undefined : 'inactive'),
      reason: e?.reason ?? (unstated ? 'no clinical status recorded; treat as possibly active' : undefined),
      since: (r.effectiveDateTime ?? r.effectivePeriod?.start ?? r.authoredOn ?? r.onsetDateTime ?? r.onsetPeriod?.start ?? r.recordedDate ?? r.dateAsserted)?.slice(0, 10),
      source: keys.length
        ? `hospital portal ${keys.join(', ')}`
        : tags.has('src-apple-health') ? 'Apple Health copy of a hospital record (prefer the hospital source)' : r.meta?.source ? basename(r.meta.source) : undefined,
      flags: flags.length ? flags : undefined,
      type: kind === 'medications' ? r.resourceType : undefined,
      id: r.id,
    };
    return [Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as ListRow];
  });
  // Current first, then unconfirmed, unstated, inactive; newest first within each.
  return rows.sort((a, b) => rank(a) - rank(b) || (b.since ?? '').localeCompare(a.since ?? ''));
}

export async function currentList(client: MedplumClient, patientId: string, kind: Kind, include?: 'all'): Promise<{ rows: ListRow[]; total: number; truncated?: true }> {
  const all = (type: string, q: string[][]) => collect(client, type as 'Observation', new URLSearchParams([...q, ['_count', '1000']]), (r: Resource) => r, Infinity).then((x) => x.rows);
  const subject = ['subject', `Patient/${patientId}`];
  // Every covered type, any status: the newest Epic import is read from their source dates.
  // shortcut: an Epic import holding none of these four types is missed (the share scans the whole record); scan more types if that matters.
  const [ms, mr, cond, alg, eps] = await Promise.all([
    all('MedicationStatement', [subject, ['_include', 'MedicationStatement:medication']]),
    all('MedicationRequest', [subject, ['_include', 'MedicationRequest:medication']]),
    all('Condition', [subject]),
    all('AllergyIntolerance', [['patient', `Patient/${patientId}`]]),
    client.searchResources('Endpoint', { identifier: `${SOURCE_ID}|`, _count: '1000' }, { cache: 'no-cache' }),
  ]);
  const resources = [...ms, ...mr, ...cond, ...alg];
  return fit(listRows(resources, currencyContext(resources, (eps as Endpoint[]).filter(forPatient(patientId))), kind, include), 1000);
}
