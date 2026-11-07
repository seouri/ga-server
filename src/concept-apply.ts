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
const LEARNS = new Set<SourceInfo['kind']>(['ccda', 'ehi', 'smart']);

export type Status = 'source' | 'spec' | 'source-map' | 'suggested' | 'unmapped' | 'excluded';
export type Unmapped = { source: string; type: string; key: string; name: string; unit?: string; count: number }; // key: the term key the map uses; name, unit: as first seen

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

// Merges done on source content (`merge` reads GA codings as source codes), then given back the incoming concept,
// unless the merge kept a source code (or a Medication reference): then GA adds nothing.
export const onSource = <T extends Resource>(existing: T, incoming: T, f: (ex: T, inc: T) => T): T => {
  const m = f(stripConcept(existing), stripConcept(incoming));
  return own(m) || !cc(m) ? m : conceptOf(incoming, m);
};

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

// What a batch teaches its source maps, grouped by source: terms the map lacks whose records all carry one code. A term
// coded two ways in the batch is ambiguous and is not learned (its uncoded copies stay up for review).
export function learnable(resources: Resource[], src: SourceInfo, maps: Maps): Map<string, MapEntry[]> {
  const seen = new Map<string, { source: string; entry: MapEntry; codes: Set<string> }>();
  if (!LEARNS.has(src.kind)) return new Map();
  for (const r of resources) {
    const l = codeRecord(r, src, maps).learn;
    if (!l || lookup(maps, l.source, l.entry.key)) continue;
    const id = `${l.source}\n${l.entry.key}`;
    const s = seen.get(id) ?? seen.set(id, { ...l, codes: new Set() }).get(id);
    s?.codes.add(`${l.entry.target?.system}|${l.entry.target?.code}`);
  }
  const out = new Map<string, MapEntry[]>();
  for (const { source, entry, codes } of seen.values()) if (codes.size === 1) out.set(source, [...(out.get(source) ?? []), entry]);
  return out;
}

export const addUnmapped = (to: Unmapped[], from: Unmapped[]): void => {
  for (const u of from) {
    const hit = to.find((x) => x.source === u.source && x.type === u.type && x.key === u.key);
    if (hit) hit.count += u.count;
    else to.push({ ...u });
  }
};

// The review line for an unmapped record (codeRecord returned 'unmapped', so it has a source key and a name).
export function countUnmapped(list: Unmapped[], r: Resource, src: SourceInfo): void {
  const unit = (r as Observation).valueQuantity?.unit;
  addUnmapped(list, [{ source: sourceKey(src, r), type: r.resourceType, key: termKey(r) as string, name: nameOf(cc(r)) as string, ...(unit && { unit }), count: 1 }]);
}
