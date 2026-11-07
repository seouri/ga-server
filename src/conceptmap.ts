import { basename, dirname } from 'node:path';
import { conceptMapTranslate, type MedplumClient } from '@medplum/core';
import type { CodeableConcept, Coding, ConceptMap, ConceptMapGroup, Observation, Resource } from '@medplum/fhirtypes';
import { type SourceInfo, TAG } from './identity.ts';
import { SUMMARY } from './vitals.ts';

export const MAP_URL = 'urn:ga-server:conceptmap:';
export const mapUrl = (source: string): string => MAP_URL + encodeURI(source); // a uri has no spaces (C-CDA org names do)
const MAP_TAG = 'concept-map'; // uri :below does not match urn: urls, so loadMaps finds the maps by tag
const TERM = 'urn:ga-server:termkey'; // group.source for every entry
const UNMATCHED = 'urn:ga-server:unmatched'; // group.target of entries without a code
const BY = 'urn:ga-server:ext:concept-by';
const CONFIDENT = 'urn:ga-server:ext:concept-confident';

export type MapEntry = { key: string; target?: Coding; equivalence: 'equivalent' | 'wider' | 'narrower' | 'inexact' | 'unmatched'; confident: boolean; by: 'source' | 'agent' };
export type Maps = Map<string, ConceptMap>; // by source key

const COVERED = new Set(['Immunization', 'Procedure', 'MedicationStatement', 'MedicationRequest', 'Condition']);
const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}%/]+/gu, ' ').trim();
const hasCode = (o: Observation, code: string): boolean => !!o.category?.some((c) => c.coding?.some((x) => x.code === code));

// Spec scope boundary: allowlist by kind, then Observation categories; Apple summaries, rings, sleep, ECG and Epic health maintenance are out.
export function inScope(r: Resource): boolean {
  if (COVERED.has(r.resourceType)) return true;
  if (r.resourceType !== 'Observation') return false;
  const o = r as Observation;
  const text = o.code?.text ?? '';
  if (SUMMARY.test(text) || /^health maintenance:/i.test(text) || /apple watch ecg/i.test(text)) return false;
  return hasCode(o, 'laboratory') || hasCode(o, 'vital-signs') || (!o.category?.length && !!o.meta?.tag?.some((t) => t.system === TAG && t.code === 'extracted-by-llm'));
}

// Labs and vitals: name|unit(|specimen), normalised. Medications: the name as written. Others: normalised name.
// Unit and specimen stay in the key, so a urine glucose is never answered by the serum glucose entry.
export function termKey(r: Resource): string | undefined {
  const name = (c?: CodeableConcept) => c?.text ?? c?.coding?.find((x) => x.display)?.display;
  if (r.resourceType === 'Observation') {
    const o = r as Observation;
    const n = norm(name(o.code));
    if (!n) return undefined;
    return [n, norm(o.valueQuantity?.unit ?? o.valueQuantity?.code), ...(o.specimen?.display ? [norm(o.specimen.display)] : [])].join('|');
  }
  if (r.resourceType === 'MedicationStatement' || r.resourceType === 'MedicationRequest') {
    const m = r as { medicationCodeableConcept?: CodeableConcept; medicationReference?: { display?: string } };
    return (name(m.medicationCodeableConcept) ?? m.medicationReference?.display)?.trim() || undefined;
  }
  const c = r as { code?: CodeableConcept; vaccineCode?: CodeableConcept };
  return norm(name(c.code ?? c.vaccineCode)) || undefined;
}

// C-CDA identifiers carry no organisation (system is the fixed urn:ga-server:id:ccda), so the key uses the document
// custodian name (SourceInfo.org, set by the C-CDA importer), else the export folder name.
export function sourceKey(src: SourceInfo, r: Resource): string {
  if (src.kind === 'pdf' || src.kind === 'apple-health') return src.kind;
  if (src.kind === 'ccda') {
    const org = norm(src.org) || norm(basename(dirname(src.file)));
    if (!org) throw new Error('no organisation for a C-CDA source'); // never one catch-all map
    return `ccda:${org}`;
  }
  const ids = [(r as { identifier?: { system?: string } | { system?: string }[] }).identifier ?? []].flat();
  const prefix = `urn:ga-server:id:${src.kind}:`;
  const key = ids.find((i) => i.system?.startsWith(prefix))?.system?.slice(prefix.length);
  if (!key) throw new Error(`no ${src.kind} source in the identifiers of ${r.resourceType}`);
  return `${src.kind}:${key}`;
}

let cache: Maps | undefined; // per process; upsertEntry clears it

export async function loadMaps(client: MedplumClient): Promise<Maps> {
  if (cache) return cache;
  const maps: Maps = new Map();
  for (const m of await client.searchResources('ConceptMap', { _tag: `${TAG}|${MAP_TAG}`, _count: '1000' })) maps.set(decodeURI((m.url as string).slice(MAP_URL.length)), m);
  return (cache = maps);
}

export function lookup(maps: Maps, source: string, key: string): MapEntry | undefined {
  const map = maps.get(source);
  if (!map?.group) return undefined;
  const hit = conceptMapTranslate(map, { system: TERM, code: key }).match?.[0];
  if (!hit) return undefined;
  const target = map.group.flatMap((g) => g.element?.filter((e) => e.code === key).flatMap((e) => e.target ?? []) ?? []).find((t) => t.equivalence === hit.equivalence && (t.code ?? undefined) === hit.concept?.code);
  const ext = (url: string) => target?.extension?.find((e) => e.url === url);
  return {
    key,
    ...(hit.concept?.code && { target: { system: hit.concept.system, code: hit.concept.code, ...(hit.concept.display && { display: hit.concept.display }) } }),
    equivalence: hit.equivalence as MapEntry['equivalence'],
    confident: ext(CONFIDENT)?.valueBoolean ?? true,
    by: ext(BY)?.valueCode === 'agent' ? 'agent' : 'source',
  };
}

// Creates or updates the source's map, replacing any earlier entry for the key; one group per target system.
export async function upsertEntry(client: MedplumClient, source: string, entry: MapEntry): Promise<void> {
  const url = mapUrl(source);
  const map: ConceptMap = (await client.searchOne('ConceptMap', { url })) ?? { resourceType: 'ConceptMap', status: 'active', url, meta: { tag: [{ system: TAG, code: MAP_TAG }] } };
  const target = entry.target?.code ? entry.target.system : UNMATCHED;
  const groups: ConceptMapGroup[] = (map.group ?? [])
    .map((g) => ({ ...g, element: g.element?.filter((e) => e.code !== entry.key) }))
    .filter((g) => g.element?.length || g.target === target);
  let g = groups.find((x) => x.target === target);
  if (!g) groups.push((g = { source: TERM, target, element: [] }));
  g.element = [...(g.element ?? []), {
    code: entry.key,
    target: [{
      ...(entry.target?.code && { code: entry.target.code, ...(entry.target.display && { display: entry.target.display }) }),
      equivalence: entry.equivalence,
      ...(entry.equivalence === 'narrower' || entry.equivalence === 'inexact' ? { comment: `GA concept map: ${entry.equivalence}` } : {}), // R4 invariant cmd-1
      extension: [{ url: BY, valueCode: entry.by }, { url: CONFIDENT, valueBoolean: entry.confident }],
    }],
  }];
  const body: ConceptMap = { ...map, group: groups.filter((x) => x.element?.length) };
  await (map.id ? client.updateResource(body) : client.createResource(body));
  cache = undefined;
}
