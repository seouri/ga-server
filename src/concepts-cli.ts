// Backfill and review for the concept layer (spec "Backfill"): applyAll re-codes stored records, reviewList lists what needs a mapping.
import { getStatus, type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { DocumentReference, Observation, Provenance, Resource } from '@medplum/fhirtypes';
import { isDeepStrictEqual } from 'node:util';
import { basename } from 'node:path';
import { codeRecord, countUnmapped, learner, TARGET, type Unmapped } from './concept-apply.ts';
import { custodian } from './ccda.ts';
import { GaError } from './config.ts';
import { loadMaps, lookup, type Maps, rekey, sourceKey, termKey, untyped, upsertEntries } from './conceptmap.ts';
import { COMPARTMENT } from './engine.ts';
import { effective, type SourceInfo, TAG } from './identity.ts';

const TYPES = ['Observation', 'Immunization', 'Procedure', 'MedicationStatement', 'MedicationRequest', 'Condition'];
const KINDS = ['ccda', 'ehi', 'apple-health', 'pdf', 'smart'] as const;
const PAGE = 500;

const keyOf = (r: Resource, info: SourceInfo): string | undefined => {
  try {
    return sourceKey(info, r);
  } catch {
    return undefined;
  }
};

// Rebuilds a stored record's SourceInfo from what the importer stamped: the src-<kind> tag, meta.source (the file or FHIR
// base) and, for ehi/smart, the identifier sourceKey reads. A C-CDA record keeps no custodian name, so it is recovered from
// the stored source file (the DocumentReference titled like meta.source's file name), once per file; if that can't be
// resolved the record is skipped, never re-keyed by folder. A record with several src tags takes the one whose key has a map.
function sourceResolver(client: MedplumClient, patientId: string, maps: () => Maps) {
  let docs: Promise<DocumentReference[]> | undefined;
  const orgs = new Map<string, Promise<{ org?: string } | undefined>>();
  const orgOf = (file: string) => {
    const find = async () => {
      docs ??= client.searchResources('DocumentReference', { subject: `Patient/${patientId}`, identifier: 'urn:ga-server:id:file|', _count: '1000' }, { cache: 'no-cache' });
      const mine = (await docs).filter((d) => d.content?.[0]?.attachment?.title === basename(file) && d.content[0].attachment.url);
      const names = new Set<string | undefined>();
      for (const d of mine) names.add(custodian(await (await client.download(d.content?.[0].attachment?.url as string)).text()));
      return names.size === 1 ? { org: [...names][0] } : undefined;
    };
    if (!orgs.has(file)) orgs.set(file, find().catch(() => undefined));
    return orgs.get(file);
  };
  // only: the one source kind wanted (map_concept): other kinds are never resolved, so no C-CDA file is read for them.
  return async (r: Resource, only?: string): Promise<SourceInfo | undefined> => {
    const infos: SourceInfo[] = [];
    for (const k of KINDS) {
      if ((only && k !== only) || !r.meta?.tag?.some((t) => t.system === TAG && t.code === `src-${k}`)) continue;
      const info: SourceInfo = { kind: k, file: r.meta?.source ?? '', date: '', writer: 'importer' };
      if (k === 'ccda') {
        const o = await orgOf(info.file);
        if (!o) continue;
        info.org = o.org;
      }
      infos.push(info);
    }
    if (infos.length < 2) return infos[0];
    const mapped = infos.filter((i) => maps().has(keyOf(r, i) ?? ''));
    return mapped.length === 1 ? mapped[0] : undefined;
  };
}

// Ids first by cursor (Medplum caps _offset at 10000; a cursor needs _sort=_lastUpdated and _count >= 20), then the records
// in batches of up to 100: writing a record while paging would move it in a _lastUpdated order. size: page and batch size (at least 20).
// shortcut: all ids of a type sit in memory (about 40 bytes each), fine for a personal record.
export async function* scan(client: MedplumClient, patientId: string, types: string[], extra: Record<string, string> = {}, size = PAGE): AsyncGenerator<Resource[]> {
  for (const type of types) {
    const ids: string[] = [];
    const q = { [COMPARTMENT[type]]: `Patient/${patientId}`, _sort: '_lastUpdated', _count: String(size), _elements: 'id', ...extra };
    for await (const page of client.searchResourcePages(type as 'Observation', q, { cache: 'no-cache' })) ids.push(...page.map((r) => r.id as string));
    const step = Math.min(size, 100); // an _id list of 500 uuids makes a URL some servers refuse
    for (let i = 0; i < ids.length; i += step) {
      const batch = await client.searchResources(type as 'Observation', { _id: ids.slice(i, i + step).join(','), _count: String(step) }, { cache: 'no-cache' });
      if (batch.length) yield batch;
    }
  }
}

export async function applyAll(client: MedplumClient, patientId: string, opts: { source?: string; key?: string; type?: string } = {}): Promise<{ scanned: number; matched: number; coded: number; suggested: number; unmapped: number; changed: number }> {
  let maps = await loadMaps(client, true);
  const infoOf = sourceResolver(client, patientId, () => maps);
  // A write onto a record a person last changed would make GA its author and drop the person-edit protection (engine decide/protect): leave those.
  const me = client.getProfile();
  const mine = (r: Resource) => !r.meta?.author?.reference || !me || r.meta.author.reference === `${me.resourceType}/${me.id}`;
  if (!opts.source) {
    // Terms the stored source codes teach their map first, by the same rules as an import's batch (add-only, ambiguous terms skipped).
    const l = learner(maps);
    for await (const page of scan(client, patientId, TYPES)) {
      for (const r of page) {
        const info = mine(r) ? await infoOf(r) : undefined;
        if (info) l.add(r, info);
      }
    }
    const learned = l.entries();
    for (const [source, entries] of learned) await upsertEntries(client, source, entries);
    if (learned.size) maps = await loadMaps(client, true);
  }
  // Versioned: a record changed since it was read (an import, a person) gets 412; it is re-read and re-coded once, else left.
  const recode = async (r: Resource, info: SourceInfo, retry = true): Promise<boolean> => {
    const { resource } = codeRecord(r, info, maps);
    if (isDeepStrictEqual(resource, r)) return false; // codeRecord changes nothing else, so equal means already coded
    try {
      await client.updateResource(resource, { headers: { 'If-Match': `W/"${r.meta?.versionId}"` } }); // only the GA coding, its extension and the concept tags differ
      return true;
    } catch (e) {
      if (!(e instanceof OperationOutcomeError) || getStatus(e.outcome) !== 412) throw e;
      if (!retry) return false;
      const fresh = await client.readResource(r.resourceType, r.id as string, { cache: 'no-cache' });
      return mine(fresh) && recode(fresh, info, false);
    }
  };
  const kind = opts.source?.split(':')[0];
  const n = { scanned: 0, matched: 0, coded: 0, suggested: 0, unmapped: 0, changed: 0 };
  for await (const page of scan(client, patientId, opts.type ? [opts.type] : TYPES, kind ? { _tag: `${TAG}|src-${kind}` } : {})) {
    for (const r of page) {
      n.scanned++;
      if (opts.source && termKey(r) !== opts.key) continue; // before infoOf: no source file is read for other terms
      const info = mine(r) ? await infoOf(r, kind) : undefined;
      if (!info) continue;
      if (opts.source && keyOf(r, info) !== opts.source) continue;
      n.matched++;
      const { status } = codeRecord(r, info, maps);
      if (status === 'spec' || status === 'source-map') n.coded++;
      else if (status === 'suggested' || status === 'unmapped') n[status]++;
      if (await recode(r, info)) n.changed++;
    }
  }
  return n;
}

const dateOf = (r: Resource): string | undefined => {
  const x = r as unknown as Record<string, string | { start?: string } | undefined>;
  const d = r.resourceType === 'Observation' ? effective(r as Observation) : ['occurrenceDateTime', 'performedDateTime', 'onsetDateTime', 'recordedDate', 'authoredOn', 'effectiveDateTime', 'dateAsserted'].map((k) => x[k]).find((v) => typeof v === 'string');
  return typeof d === 'string' ? d.slice(0, 10) : undefined;
};

export async function reviewList(client: MedplumClient, patientId: string, status: 'unmapped' | 'suggested', type?: string): Promise<(Unmapped & { examples: string[] })[]> {
  if (type && !TYPES.includes(type)) throw new GaError(`type must be one of ${TYPES.join(', ')}`);
  const maps = await loadMaps(client, true);
  const infoOf = sourceResolver(client, patientId, () => maps);
  const rows: (Unmapped & { dates: Set<string> })[] = [];
  for await (const page of scan(client, patientId, type ? [type] : TYPES, { _tag: `${TAG}|concept-${status}` })) {
    for (const r of page) {
      const info = await infoOf(r);
      if (!info || !keyOf(r, info) || !termKey(r)) continue;
      const one: Unmapped[] = [];
      countUnmapped(one, r, info);
      const hit = rows.find((x) => x.source === one[0].source && x.type === one[0].type && x.key === one[0].key);
      const row = hit ?? rows[rows.push({ ...one[0], count: 0, dates: new Set() }) - 1];
      row.count++;
      const d = dateOf(r);
      if (d) row.dates.add(d);
    }
  }
  return rows.sort((a, b) => b.count - a.count).map(({ dates, ...u }) => ({ ...u, examples: [...dates].sort().reverse().slice(0, 3) }));
}

// One-off: map entries written before keys carried the record type (`ga concepts apply --migrate-keys`). An entry's type comes
// from its target system when only one kind of record takes it (CVX: Immunization, ICD-10-CM: Condition, CPT/HCPCS: Procedure,
// RxNorm: both medication types); otherwise (SNOMED CT, unmatched) from which types of that source carry the term. Still
// ambiguous: dropped, so its records re-enter review. Idempotent: typed keys are left. Run applyAll after it.
export async function migrateKeys(client: MedplumClient, patientId: string): Promise<{ maps: number; entries: number }> {
  const maps = await loadMaps(client, true);
  const infoOf = sourceResolver(client, patientId, () => maps);
  const types = TYPES.filter((t) => t !== 'Observation');
  const kind = (t: string) => (t.startsWith('Medication') ? 'Medication' : t); // RxNorm fits both medication types
  let carried: Set<string> | undefined; // source \n typed term key of every stored record, read once when needed
  const carriers = async () => {
    if (carried) return carried;
    carried = new Set();
    for await (const page of scan(client, patientId, types)) {
      for (const r of page) {
        const info = await infoOf(r);
        const k = info && keyOf(r, info);
        if (k) carried.add(`${k}\n${termKey(r)}`);
      }
    }
    return carried;
  };
  const out = { maps: 0, entries: 0 };
  for (const [source, map] of maps) {
    const plan = new Map<string, string[]>();
    for (const g of map.group ?? []) {
      for (const e of g.element ?? []) {
        const key = e.code as string;
        if (!untyped(key)) continue;
        const takers = types.filter((t) => TARGET[t].includes(g.target ?? ''));
        const can = takers.length ? takers : types; // no vocabulary (unmatched): any type
        let to = can;
        if (new Set(can.map(kind)).size > 1) {
          const have = await carriers();
          to = can.filter((t) => have.has(`${source}\n${t}|${key}`));
          if (new Set(to.map(kind)).size !== 1) to = [];
        }
        plan.set(key, to.map((t) => `${t}|${key}`));
      }
    }
    const n = plan.size ? await rekey(client, map, (key) => plan.get(key)) : 0;
    if (n) out.maps++;
    out.entries += n;
  }
  return out;
}

export type AgentMapping = { source: string; type: string; term: string; system?: string; code?: string; display?: string; equivalence: string; confident: boolean; when?: string };

// The review of agent mappings (spec "Review"): every map entry an agent made, newest first; when: its latest map_concept
// Provenance (none for an entry whose Provenance predates typed keys). since: YYYY-MM-DD, entries mapped that day or later.
export async function agentMappings(client: MedplumClient, since?: string): Promise<AgentMapping[]> {
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new GaError('since must be a date YYYY-MM-DD');
  const maps = await loadMaps(client, true);
  const rows: AgentMapping[] = [];
  for (const [source, map] of maps) {
    const provs = await client.searchResources('Provenance', { target: `ConceptMap/${map.id}`, _count: '1000' }, { cache: 'no-cache' }) as Provenance[];
    for (const key of new Set(map.group?.flatMap((g) => g.element?.map((e) => e.code as string) ?? []))) {
      const e = lookup(maps, source, key);
      if (e?.by !== 'agent') continue;
      const when = provs.filter((p) => p.reason?.[0]?.text?.startsWith(`${source} "${key}" (`)).map((p) => p.recorded as string).sort().at(-1);
      if (since && (!when || when.slice(0, 10) < since)) continue;
      const typed = /^([A-Z]\w+)\|(.*)$/.exec(key);
      rows.push({ source, type: typed?.[1] ?? 'Observation', term: typed?.[2] ?? key, ...e.target, equivalence: e.equivalence, confident: e.confident, ...(when && { when }) });
    }
  }
  return rows.sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''));
}
