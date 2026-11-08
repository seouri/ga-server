// FHIR R4 definitions for the store: StructureDefinitions and SearchParameters indexed into @medplum/core's global index,
// trimmed to the resource types the store is opened with (default: every R4 resource type) and the datatypes they reference.
// A smaller type set uses less memory.
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readFileSync } from 'node:fs';
import type { Bundle, SearchParameter, StructureDefinition } from '@medplum/fhirtypes';

// Not @medplum/definitions' readJson: it resolves from a global __dirname when one exists (node -e, eval workers).
const FHIR_R4 = new URL('../fhir/r4/', import.meta.resolve('@medplum/definitions'));
const readJson = (f: string) => JSON.parse(readFileSync(new URL(f, FHIR_R4), 'utf8'));

// Patient CompartmentDefinition: type -> the search params that put a resource in a patient's compartment.
export const PATIENT_COMPARTMENT_PARAMS: Readonly<Record<string, string[]>> = Object.fromEntries(
  (readJson('compartmentdefinition-patient.json').resource as { code: string; param?: string[] }[]).filter((r) => r.param).map((r) => [r.code, r.param!]));

const ALL: string[] = []; // every concrete R4 resource type, filled on the first load
let loaded: readonly string[] | undefined;

// The resource types the definitions were loaded for (the types the store accepts); empty before loadDefinitions.
export const storedTypes = (): readonly string[] => loaded ?? [];

// Loads the definitions once per process (@medplum/core's index is global): for `types`, or every concrete R4 resource type.
// A second call with the same set does nothing; with another set it throws (the global index cannot hold two).
export function loadDefinitions(types?: readonly string[]): void {
  const want = types && [...new Set(types)].sort();
  if (want && !want.length) throw new Error('no resource types: give at least one, or none for every R4 type');
  if (loaded) {
    if (want && want.join() !== loaded.join()) throw new Error(`FHIR definitions are already loaded for ${loaded.length} other types: one type set per process`);
    if (!want && loaded.length !== ALL.length) throw new Error('FHIR definitions are already loaded for a smaller type set: one type set per process');
    return;
  }
  const base = new Map<string, StructureDefinition>();
  const all: string[] = [];
  for (const f of ['profiles-types.json', 'profiles-resources.json']) {
    for (const e of (readJson(f) as Bundle<StructureDefinition>).entry ?? []) {
      const sd = e.resource;
      if (sd?.resourceType === 'StructureDefinition' && sd.url === `http://hl7.org/fhir/StructureDefinition/${sd.type}`) {
        base.set(sd.type, sd);
        if (sd.kind === 'resource' && !sd.abstract) all.push(sd.type);
      }
    }
  }
  ALL.length || ALL.push(...all.sort());
  const unknown = (want ?? []).filter((t) => !ALL.includes(t));
  if (unknown.length) throw new Error(`not FHIR R4 resource types: ${unknown.join(', ')}`);
  const stored = want ?? ALL;
  // Closure: stored types, their base definitions and every type an element can hold.
  const keep = new Set<string>();
  const visit = (t: string): void => {
    const sd = base.get(t);
    if (!sd || keep.has(t)) return;
    keep.add(t);
    visit(sd.baseDefinition?.split('/').pop() ?? '');
    for (const el of sd.snapshot?.element ?? []) for (const ty of el.type ?? []) visit(ty.code);
  };
  for (const t of stored) visit(t);
  indexStructureDefinitionBundle([...keep].map((t) => base.get(t)!));

  const storedSet = new Set(stored);
  for (const f of ['search-parameters.json', 'search-parameters-medplum.json', 'search-parameters-uscore.json']) {
    const entry = ((readJson(f) as Bundle<SearchParameter>).entry ?? []).flatMap((e) => {
      const sp = e.resource;
      const b = sp?.base?.filter((t) => storedSet.has(t)) ?? [];
      return sp && b.length ? [{ resource: { ...sp, base: b } as SearchParameter }] : [];
    });
    indexSearchParameterBundle({ resourceType: 'Bundle', type: 'collection', entry });
  }
  loaded = [...stored];
}
