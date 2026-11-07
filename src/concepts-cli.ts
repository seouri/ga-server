// Backfill and review for the concept layer (spec "Backfill"): applyAll re-codes stored records, reviewList lists what needs a mapping.
import type { MedplumClient } from '@medplum/core';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { isDeepStrictEqual } from 'node:util';
import { codeRecord, countUnmapped, type Unmapped } from './concept-apply.ts';
import { loadMaps, lookup, type MapEntry, sourceKey, termKey, upsertEntries } from './conceptmap.ts';
import { COMPARTMENT } from './engine.ts';
import { effective, type SourceInfo, TAG } from './identity.ts';

const TYPES = ['Observation', 'Immunization', 'Procedure', 'MedicationStatement', 'MedicationRequest', 'Condition'];
const KINDS = ['ccda', 'ehi', 'apple-health', 'pdf', 'smart'] as const;
const PAGE = 500;

// A stored record's SourceInfo, rebuilt from what the importer stamped: the src-<kind> tag, meta.source (the file or FHIR
// base) and, for ehi/smart, the identifier that sourceKey reads. shortcut: a C-CDA record keeps no custodian name, so its
// key is the folder name (sourceKey's fallback); a map keyed by custodian is not reached, re-import to code those.
const infoOf = (r: Resource): SourceInfo | undefined => {
  const kind = KINDS.find((k) => r.meta?.tag?.some((t) => t.system === TAG && t.code === `src-${k}`));
  return kind && { kind, file: r.meta?.source ?? '', date: '', writer: 'importer' };
};
const keyOf = (r: Resource, info: SourceInfo): string | undefined => {
  try {
    return sourceKey(info, r);
  } catch {
    return undefined;
  }
};

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

export async function applyAll(client: MedplumClient, patientId: string, opts: { source?: string; key?: string } = {}): Promise<{ scanned: number; coded: number; suggested: number; unmapped: number; changed: number }> {
  let maps = await loadMaps(client, true);
  if (!opts.source) {
    // Terms the stored source codes teach their map first (add-only; a term coded two ways is ambiguous and skipped), like an import's batch.
    const seen = new Map<string, { source: string; entry: MapEntry; codes: Set<string> }>();
    for await (const page of scan(client, patientId, TYPES)) {
      for (const r of page) {
        const info = infoOf(r);
        const l = info && codeRecord(r, info, maps).learn;
        if (!l || lookup(maps, l.source, l.entry.key)) continue;
        const s = seen.get(`${l.source}\n${l.entry.key}`) ?? seen.set(`${l.source}\n${l.entry.key}`, { ...l, codes: new Set() }).get(`${l.source}\n${l.entry.key}`);
        s?.codes.add(`${l.entry.target?.system}|${l.entry.target?.code}`);
      }
    }
    const bySource = new Map<string, MapEntry[]>();
    for (const { source, entry, codes } of seen.values()) if (codes.size === 1) bySource.set(source, [...(bySource.get(source) ?? []), entry]);
    for (const [source, entries] of bySource) await upsertEntries(client, source, entries);
    if (bySource.size) maps = await loadMaps(client, true);
  }
  const n = { scanned: 0, coded: 0, suggested: 0, unmapped: 0, changed: 0 };
  for await (const page of scan(client, patientId, TYPES)) {
    for (const r of page) {
      n.scanned++;
      const info = infoOf(r);
      if (!info) continue;
      if (opts.source && (keyOf(r, info) !== opts.source || termKey(r) !== opts.key)) continue;
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

export async function reviewList(client: MedplumClient, patientId: string, status: 'unmapped' | 'suggested', type?: string): Promise<(Omit<Unmapped, 'key'> & { examples: string[] })[]> {
  const rows: (Unmapped & { dates: Set<string> })[] = [];
  for await (const page of scan(client, patientId, type ? [type] : TYPES, { _tag: `${TAG}|concept-${status}` })) {
    for (const r of page) {
      const info = infoOf(r);
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
  return rows.sort((a, b) => b.count - a.count).map(({ key: _k, dates, ...u }) => ({ ...u, examples: [...dates].sort().reverse().slice(0, 3) }));
}
