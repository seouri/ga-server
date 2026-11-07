// Backfill and review for the concept layer (spec "Backfill"): applyAll re-codes stored records, reviewList lists what needs a mapping.
import type { MedplumClient } from '@medplum/core';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { isDeepStrictEqual } from 'node:util';
import { basename } from 'node:path';
import type { DocumentReference } from '@medplum/fhirtypes';
import { codeRecord, countUnmapped, learner, type Unmapped } from './concept-apply.ts';
import { custodian } from './ccda.ts';
import { GaError } from './config.ts';
import { loadMaps, type Maps, sourceKey, termKey, upsertEntries } from './conceptmap.ts';
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
  return async (r: Resource): Promise<SourceInfo | undefined> => {
    const infos: SourceInfo[] = [];
    for (const k of KINDS) {
      if (!r.meta?.tag?.some((t) => t.system === TAG && t.code === `src-${k}`)) continue;
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

async function* scan(client: MedplumClient, patientId: string, types: string[], extra: Record<string, string> = {}): AsyncGenerator<Resource[]> {
  for (const type of types) {
    for (let offset = 0; ; offset += PAGE) {
      // _sort _id: writing a record changes lastUpdated, not its place in this order, so offsets stay stable.
      const page = await client.searchResources(type as 'Observation', { [COMPARTMENT[type]]: `Patient/${patientId}`, _sort: '_id', _count: String(PAGE), _offset: String(offset), ...extra }, { cache: 'no-cache' });
      if (page.length) yield page;
      if (page.length < PAGE) break;
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
  const n = { scanned: 0, matched: 0, coded: 0, suggested: 0, unmapped: 0, changed: 0 };
  for await (const page of scan(client, patientId, opts.type ? [opts.type] : TYPES)) {
    for (const r of page) {
      n.scanned++;
      const info = mine(r) ? await infoOf(r) : undefined;
      if (!info) continue;
      if (opts.source && (keyOf(r, info) !== opts.source || termKey(r) !== opts.key)) continue;
      n.matched++;
      const { resource, status } = codeRecord(r, info, maps);
      if (status === 'spec' || status === 'source-map') n.coded++;
      else if (status === 'suggested' || status === 'unmapped') n[status]++;
      if (isDeepStrictEqual(resource, r)) continue; // codeRecord changes nothing else, so equal means already coded
      await client.updateResource(resource); // only the GA coding, its extension and the concept tags differ
      n.changed++;
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
