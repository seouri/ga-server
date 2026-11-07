// Codes one record at import: the source's own code, else the spec tables, else the source's ConceptMap (spec "How it works").
import type { CodeableConcept, Coding, Observation, Resource } from '@medplum/fhirtypes';
import { CPT, CVX, cvxFor, HCPCS, ICD10CM, LOINC, RXNORM, SNOMED, vitalSpecCode } from './concepts.ts';
import { inScope, lookup, type MapEntry, type Maps, sourceKey, termKey } from './conceptmap.ts';
import { type SourceInfo, TAG } from './identity.ts';

export const CONCEPT_SRC = 'urn:ga-server:ext:concept-source';
const CONCEPT_TAGS = ['concept-suggested', 'concept-unmapped'];
const TARGET: Record<string, string[]> = {
  Observation: [LOINC], Immunization: [CVX], MedicationStatement: [RXNORM], MedicationRequest: [RXNORM],
  Condition: [SNOMED, ICD10CM], Procedure: [SNOMED, CPT, HCPCS],
};
// Sources that code their own records teach their map. Not pdf (extraction codes are guesses, one map for every lab)
// nor Apple (GA's own fixed codes): both maps are install-wide and agent-curated.
export const LEARNS = new Set<SourceInfo['kind']>(['ccda', 'ehi', 'smart']);

export type Status = 'source' | 'spec' | 'source-map' | 'suggested' | 'unmapped' | 'excluded';
export type Unmapped = { source: string; type: string; name: string; unit?: string; count: number };

const field = (type: string) => (type === 'Immunization' ? 'vaccineCode' : type.startsWith('Medication') ? 'medicationCodeableConcept' : 'code');
const cc = (r: Resource) => (r as unknown as Record<string, CodeableConcept | undefined>)[field(r.resourceType)];
const isGa = (c: Coding) => !!c.extension?.some((e) => e.url === CONCEPT_SRC);
const gaCodings = (r: Resource) => cc(r)?.coding?.filter(isGa) ?? [];
const own = (r: Resource) => cc(r)?.coding?.find((c) => !isGa(c) && c.code && TARGET[r.resourceType]?.includes(c.system ?? ''));
const isConceptTag = (t: Coding) => t.system === TAG && CONCEPT_TAGS.includes(t.code ?? '');
const nameOf = (c?: CodeableConcept) => c?.text ?? c?.coding?.find((x) => x.display)?.display;
const tagged = <T extends Resource>(r: T, tags: Coding[]): T => (tags.length ? { ...r, meta: { ...r.meta, tag: [...(r.meta?.tag ?? []), ...tags] } } : r);
const withCodings = <T extends Resource>(r: T, codings: Coding[]): T => {
  const c = cc(r);
  return c && codings.length ? { ...r, [field(r.resourceType)]: { ...c, coding: [...(c.coding ?? []), ...codings] } } : r;
};

// A copy without GA-added codings or concept tags: the source's own content. An emptied coding array is dropped.
export function stripConcept<T extends Resource>(r: T): T {
  let out = r;
  const c = cc(r);
  if (c?.coding?.some(isGa)) {
    const { coding, ...rest } = c;
    const kept = coding.filter((x) => !isGa(x));
    out = { ...out, [field(r.resourceType)]: kept.length ? { ...rest, coding: kept } : rest };
  }
  if (r.meta?.tag?.some(isConceptTag)) out = { ...out, meta: { ...r.meta, tag: r.meta.tag.filter((t) => !isConceptTag(t)) } };
  return out;
}

// `to` (stripped) with the GA codings and concept tags of `from`.
const conceptOf = <T extends Resource>(from: Resource, to: T): T =>
  tagged(withCodings(stripConcept(to), gaCodings(from)), (from.meta?.tag ?? []).filter(isConceptTag));

// An update keeps the existing GA coding when the incoming record has neither its own target code nor a GA coding.
export const carryConcept = <T extends Resource>(existing: Resource, incoming: T): T =>
  !own(incoming) && !gaCodings(incoming).length && gaCodings(existing).length ? conceptOf(existing, incoming) : incoming;

// Merges done on source content (`merge` reads GA codings as source codes), then given back the incoming concept.
export const onSource = <T extends Resource>(existing: T, incoming: T, f: (ex: T, inc: T) => T): T =>
  conceptOf(incoming, f(stripConcept(existing), stripConcept(incoming)));

// Pure: adds at most one coding (after the source's), its concept-source extension and one concept tag. Idempotent.
export function codeRecord(r: Resource, src: SourceInfo, maps: Maps): { resource: Resource; status: Status; learn?: { source: string; entry: MapEntry } } {
  const base = stripConcept(r);
  const c = cc(base);
  if (!c || !inScope(base)) return { resource: base, status: 'excluded' }; // a reference-only medication is coded on its Medication
  const key = termKey(base);
  let source: string | undefined;
  try {
    source = sourceKey(src, base);
  } catch {
    // ruling: a record without its source identifier is left as it is, never aborting the import
  }
  const mine = own(base);
  if (mine) {
    const learn = source && key && LEARNS.has(src.kind)
      ? { source, entry: { key, target: { system: mine.system, code: mine.code, ...(mine.display && { display: mine.display }) }, equivalence: 'equivalent', confident: true, by: 'source' } as MapEntry }
      : undefined;
    return { resource: base, status: 'source', ...(learn && { learn }) };
  }
  const name = nameOf(c);
  const vital = base.resourceType === 'Observation' && !!(base as Observation).category?.some((x) => x.coding?.some((y) => y.code === 'vital-signs'));
  const spec = name && (base.resourceType === 'Immunization' ? cvxFor(name) : vital ? vitalSpecCode(name) : undefined);
  const mark = (coding: Coding, how: string) => withCodings(base, [{ ...coding, extension: [{ url: CONCEPT_SRC, valueCode: how }] }]);
  if (spec) return { resource: mark(spec, 'spec'), status: 'spec' };
  if (!source || !key) return { resource: base, status: 'excluded' }; // nothing to look up or review by
  const entry = lookup(maps, source, key);
  if (entry?.equivalence === 'unmatched') return { resource: base, status: 'excluded' }; // has no standard code: out of review
  if (entry?.target) {
    const coded = mark(entry.target, entry.by === 'agent' ? 'agent' : 'source-map');
    if (entry.equivalence === 'equivalent' && entry.confident) return { resource: coded, status: 'source-map' };
    return { resource: tagged(coded, [{ system: TAG, code: 'concept-suggested' }]), status: 'suggested' };
  }
  return { resource: tagged(base, [{ system: TAG, code: 'concept-unmapped' }]), status: 'unmapped' };
}

export const addUnmapped = (to: Unmapped[], from: Unmapped[]): void => {
  for (const u of from) {
    const hit = to.find((x) => x.source === u.source && x.type === u.type && x.name === u.name && x.unit === u.unit);
    if (hit) hit.count += u.count;
    else to.push({ ...u });
  }
};

// The review line for an unmapped record (codeRecord returned 'unmapped', so it has a source key and a name).
export function countUnmapped(list: Unmapped[], r: Resource, src: SourceInfo): void {
  const unit = (r as Observation).valueQuantity?.unit;
  addUnmapped(list, [{ source: sourceKey(src, r), type: r.resourceType, name: nameOf(cc(r)) as string, ...(unit && { unit }), count: 1 }]);
}
