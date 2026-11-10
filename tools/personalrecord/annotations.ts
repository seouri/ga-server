import type { CodeableConcept, Resource } from '@medplum/fhirtypes';

export type PrAnnotation = { annotation_type: 'ended' | 'ongoing' | 'date_change' | 'comment'; created_at: string; code_display: string; effective_datetime_original: string | null; annotation_data: string };

type Loose = Record<string, unknown> & { resourceType: string; note?: Record<string, unknown>[] };

const norm = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// The text an annotation can match: Condition/Observation code.text, MedicationRequest medicationCodeableConcept.text
// or medicationReference.display, DocumentReference type.text.
function names(r: Loose): string[] {
  const t = (c: unknown) => (c as CodeableConcept | undefined)?.text;
  return [t(r.code), t(r.medicationCodeableConcept), (r.medicationReference as { display?: string } | undefined)?.display, t(r.type)].map(norm).filter(Boolean);
}
const dateOf = (r: Loose): string => {
  for (const f of ['effectiveDateTime', 'recordedDate', 'authoredOn', 'date', 'occurrenceDateTime', 'performedDateTime', 'onsetDateTime']) if (typeof r[f] === 'string') return (r[f] as string).slice(0, 10);
  return '';
};

function noteText(a: PrAnnotation): string {
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(a.annotation_data) as Record<string, unknown>; } catch { /* unreadable annotation data: the label alone */ }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (a.annotation_type) {
    case 'ended': return `Ended${str(d.status_date) ? `: ${str(d.status_date)}` : ''} (personalrecord annotation)`;
    case 'ongoing': return `Ongoing${str(d.status_date) ? `: ${str(d.status_date)}` : ''} (personalrecord annotation)`;
    case 'date_change': return `Date corrected to ${str(d.annotated_date)}: ${str(d.original_date) || 'no earlier date'}${str(d.reason) ? `; reason: ${str(d.reason)}` : ''} (personalrecord annotation)`;
    default: return `Comment: ${str(d.text)} (personalrecord annotation)`;
  }
}

export function attachAnnotations(anns: PrAnnotation[], known: Record<string, Resource[]>, rebuilt: Resource[]): { resources: Resource[]; unmatched: { code: string; reason: 'none' | 'several' }[] } {
  const out = rebuilt.map((r) => ({ ...(r as Loose) }));
  const rebuiltIds = new Set(out.map((r) => r.id));
  const copies = new Map<string, Loose>(); // matched known resources, by Type/id
  const unmatched: { code: string; reason: 'none' | 'several' }[] = [];
  const pool: { r: Loose; key: string; isKnown: boolean }[] = [
    ...out.map((r) => ({ r, key: '', isKnown: false })),
    ...Object.values(known).flat().filter((r) => !rebuiltIds.has(r.id)).map((r) => ({ r: r as Loose, key: `${r.resourceType}/${r.id}`, isKnown: true })),
  ];
  for (const a of anns) {
    const want = norm(a.code_display);
    const orig = a.effective_datetime_original?.slice(0, 10);
    const find = (list: typeof pool) => list.filter((p) => names(p.r).includes(want) && (!orig || dateOf(p.r) === orig));
    let hits = find(pool.filter((p) => p.isKnown)); // --known first, the reconstructed ones only when it has none
    if (!hits.length) hits = find(pool.filter((p) => !p.isKnown));
    if (hits.length !== 1) { unmatched.push({ code: a.code_display, reason: hits.length ? 'several' : 'none' }); continue; }
    const hit = hits[0];
    const note = { authorString: 'Patient', time: a.created_at, text: noteText(a) };
    let target = hit.r;
    if (hit.isKnown) {
      target = copies.get(hit.key) ?? structuredClone(hit.r);
      copies.set(hit.key, target);
    }
    target.note = [...(target.note ?? []), note];
  }
  return { resources: [...out, ...copies.values()] as unknown as Resource[], unmatched };
}
