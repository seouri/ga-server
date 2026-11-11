// Maps one source term to a standard code: the logic of map_concept, shared with GA's own automatic mapping so both write mappings the same way.
import type { MedplumClient } from '@medplum/core';
import type { Provenance, Resource } from '@medplum/fhirtypes';
import { CPT } from './concepts.ts';
import { field, TARGET } from './concept-apply.ts';
import { validate, wellFormed } from './concept-validate.ts';
import { applyAll } from './concepts-cli.ts';
import { inScope, loadMaps, lookup, termKey, upsertEntry, type MapEntry } from './conceptmap.ts';
import { GaError } from './config.ts';

export type MapInput = { source: string; name: string; unit?: string; key?: string; type: string; system: string; code: string; display: string; equivalence: MapEntry['equivalence']; confident: boolean };

// A stand-in record carrying only what the term key and scope read; category laboratory so that, for Observations,
// only the name rules (Apple summaries, health maintenance, ECG) decide scope.
const termOf = (type: string, name: string, unit?: string): Resource => {
  const cc = { text: name };
  if (type === 'Observation') return { resourceType: 'Observation', status: 'final', code: cc, category: [{ coding: [{ code: 'laboratory' }] }], ...(unit && { valueQuantity: { unit } }) };
  return { resourceType: type, [field(type)]: cc } as unknown as Resource;
};

export async function mapTerm(
  client: MedplumClient, patientId: string, input: MapInput, who: string, deps: { fetch?: typeof fetch } = {},
): Promise<{ changed: number; status: 'mapped' | 'suggested' | 'unmatched' | 'no records'; reason?: string }> {
  const { source, name, unit, key: given, type, system, code, display, equivalence, confident } = input;
  // Refusals first: nothing is sent or written for them.
  if (system === CPT) throw new GaError('CPT is licensed and cannot be checked: map procedures to SNOMED CT');
  const term = termOf(type, name, unit);
  const derived = termKey(term);
  if (!derived || !inScope(term)) throw new GaError(`${type} "${name}" is not in the concept layer's scope (GA's own Apple Health summaries, health maintenance and the ECG are never mapped)`);
  // A given key may only add the specimen to the key derived from name and unit.
  if (given !== undefined && given !== derived && !given.startsWith(`${derived}|`)) throw new GaError(`key "${given}" is not a key of ${type} "${name}"${unit ? ` (${unit})` : ''}`);
  const key = given ?? derived;
  const unmatched = equivalence === 'unmatched';
  if (!unmatched && !TARGET[type].includes(system)) throw new GaError(`${type} takes ${TARGET[type].join(', ')}, not ${system}`);
  if (!unmatched && !wellFormed(system, code)) throw new GaError(`"${code}" is not a ${system} code`);
  const v = unmatched ? { ok: true } : await validate(system, code, { fetch: deps.fetch });
  if (!v.ok && v.reason !== 'validation unavailable') throw new GaError(`${v.reason}: not mapped`); // the code does not exist
  const sure = confident && v.ok && !v.reason; // an unavailable or skipped validation is applied as suggested
  const correction = !!lookup(await loadMaps(client, true), source, key); // a term mapped before may be coded on any record
  const map = await upsertEntry(client, source, {
    key, equivalence, confident: sure, by: 'agent',
    ...(!unmatched && { target: { system, code, display: v.display ?? display } }),
  });
  // Provenance right after the map write: every mapping has one, even if re-applying fails.
  await client.createResource<Provenance>({
    resourceType: 'Provenance',
    target: [{ reference: `ConceptMap/${map?.id}` }],
    recorded: new Date().toISOString(),
    activity: { coding: [{ system: 'urn:ga-server:activity', code: 'map_concept' }] },
    agent: [{ who: { display: who } }],
    reason: [{ text: `${source} "${key}" (${type}): ${unmatched ? 'unmatched' : `${system}|${code} ${equivalence}${sure ? '' : ', suggested'}`}` }],
  });
  const { changed, matched } = await applyAll(client, patientId, { source, key, type, review: !correction });
  if (!matched) return { changed, status: 'no records', reason: `no ${type} records of "${key}" from ${source}; the mapping is kept for later imports` };
  return { changed, status: unmatched ? 'unmatched' : sure && equivalence === 'equivalent' ? 'mapped' : 'suggested', ...(v.reason && { reason: v.reason }) };
}
