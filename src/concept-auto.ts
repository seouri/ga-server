// GA's own mapping after an import: searches codes for the terms left unmapped, maps a single exact-name match itself
// (as "GA (automatic)") and returns the rest with ranked candidates for an agent (spec "Map right after import").
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Extension, Resource } from '@medplum/fhirtypes';
import { field, TARGET, trusted, type Unmapped } from './concept-apply.ts';
import type { GaConfig } from './config.ts';
import { mapTerm } from './concept-map-term.ts';
import { CPT, ICD10CM } from './concepts.ts';
import { loadMaps, lookup, termKey } from './conceptmap.ts';
import { COMPARTMENT, DUP_OF } from './engine.ts';
import { hasTag } from './identity.ts';
import { type Candidate, sameName, searchCodes } from './terminology.ts';

export type Reviewed = Unmapped & { candidates: Candidate[] };

const MAX_TERMS = 50;
const IN_FLIGHT = 4;

export function pickAuto(name: string, candidates: Candidate[]): Candidate | undefined {
  const hits = candidates.filter((c) => !c.from && sameName(c.display, name));
  return hits.length === 1 ? hits[0] : undefined;
}

// Whether a stored record came from the map source key. shortcut: any C-CDA record counts for a ccda:<org> key (the org
// is only in the stored source file); upgrade if linked candidates from the wrong clinic show up.
const ofSource = (r: Resource, source: string): boolean => {
  const prefix = source.split(':')[0];
  const kinds = prefix === 'apple-health' ? ['apple-health', 'apple-clinical'] : [prefix];
  if (!kinds.some((k) => hasTag(r, `src-${k}`))) return false;
  if (prefix !== 'ehi' && prefix !== 'smart') return true;
  return [(r as { identifier?: { system?: string }[] }).identifier ?? []].flat().some((i) => i.system === `urn:ga-server:id:${source}`);
};

// The trusted code of the record a possible duplicate of this term points at (DUP_OF), if any.
async function linked(client: MedplumClient, dups: Resource[], t: Unmapped): Promise<Candidate | undefined> {
  for (const r of dups) {
    if (r.resourceType !== t.type || termKey(r) !== t.key || !ofSource(r, t.source)) continue;
    for (const ref of (r as { extension?: Extension[] }).extension?.filter((e) => e.url === DUP_OF) ?? []) {
      const [type, id] = (ref.valueReference?.reference ?? '').split('/');
      const other = await client.readResource(type as 'Procedure', id).catch(() => undefined);
      const cc = other && (other as unknown as Record<string, CodeableConcept | undefined>)[field(type)];
      // The type's first vocabulary first; never CPT (licensed: map_concept refuses it).
      const codes = other ? trusted(other, cc?.coding).filter((x) => x.code && x.system !== CPT && TARGET[t.type]?.includes(x.system ?? '')) : [];
      const c = codes.find((x) => x.system === TARGET[t.type][0]) ?? codes[0];
      if (c) return { system: c.system as string, code: c.code as string, display: c.display ?? cc?.text ?? '', from: 'linked record' };
    }
  }
  return undefined;
}

export async function autoMap(
  client: MedplumClient, patientId: string, terms: Unmapped[], deps: { fetch?: typeof fetch; lookup?: boolean; map?: boolean } = {},
): Promise<{ autoMapped: number; terms: Reviewed[] }> {
  const out: Reviewed[] = terms.map((t) => ({ ...t, candidates: [] }));
  if (deps.lookup === false) return { autoMapped: 0, terms: out };
  const mapped = new Set<Reviewed>();
  const left = () => ({ autoMapped: mapped.size, terms: out.filter((t) => !mapped.has(t)) });
  const maps = await loadMaps(client, true).catch(() => undefined);
  if (!maps) return left(); // a failure never fails the import, sync or tool call that ran this
  // map false (the review list): candidates for every term, mapped or not, and nothing written.
  const todo = out.filter((t) => TARGET[t.type] && (deps.map === false || !lookup(maps, t.source, t.key))).sort((a, b) => b.count - a.count).slice(0, MAX_TERMS);
  // Possible duplicates of each type, read once: their DUP_OF record may already carry the term's code.
  const dups = new Map<string, Promise<Resource[]>>();
  const dupsOf = (type: string) => {
    if (!dups.has(type)) dups.set(type, client.searchResources(type as 'Procedure', { [COMPARTMENT[type]]: `Patient/${patientId}`, _tag: 'urn:ga-server:tag|possible-duplicate', _count: '1000' }, { cache: 'no-cache' }).catch(() => []));
    return dups.get(type) as Promise<Resource[]>;
  };
  const one = async (t: Reviewed) => {
    const searched = await searchCodes(TARGET[t.type][0], t.name, { fetch: deps.fetch });
    const pick = pickAuto(t.name, searched); // only the first vocabulary may be auto-mapped
    const more = t.type === 'Condition' ? await searchCodes(ICD10CM, t.name, { fetch: deps.fetch }) : [];
    const link = await linked(client, await dupsOf(t.type), t);
    t.candidates = [...(link ? [link] : []), ...[...searched, ...more].filter((c) => !(link && c.system === link.system && c.code === link.code))];
    if (deps.map === false || !pick || (link && (link.system !== pick.system || link.code !== pick.code))) return; // a differing linked code: the agent judges
    try {
      const r = await mapTerm(client, patientId, { source: t.source, name: t.name, unit: t.unit, key: t.key, type: t.type, system: pick.system, code: pick.code, display: pick.display, equivalence: 'equivalent', confident: true }, 'GA (automatic)', { fetch: deps.fetch });
      if (r.status === 'mapped' || r.status === 'no records') mapped.add(t);
    } catch {
      // a refusal (out of scope, unknown code) leaves the term for the agent, with its candidates
    }
  };
  const queue = [...todo];
  await Promise.all(Array.from({ length: IN_FLIGHT }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await one(t).catch(() => undefined); // that term stays for the agent
  }));
  return left();
}

// After an import: GA maps what it can of the report's unmapped terms and returns the rest with candidates (and autoMapped).
export async function afterImport<T>(client: MedplumClient, cfg: GaConfig, report: T, deps: { fetch?: typeof fetch } = {}): Promise<T> {
  const unmapped = (report as { unmapped?: unknown } | undefined)?.unmapped;
  if (!Array.isArray(unmapped) || !unmapped.length) return report;
  const r = await autoMap(client, cfg.patientId, unmapped as Unmapped[], { fetch: deps.fetch, lookup: cfg.terminologyLookup !== false });
  return { ...report, unmapped: r.terms, autoMapped: r.autoMapped };
}
