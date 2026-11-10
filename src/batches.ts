// What the batched importers share (Apple Health, Epic EHI, C-CDA; src/import-jobs.ts runs them as resumable jobs): the batch
// options, the pending checkpoint, and the lookup of what GA already holds of a batch.
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import type { MapEntry } from './conceptmap.ts';
import { COMPARTMENT, type ImportReport } from './engine.ts';

export const BATCH_SIZE = 500;
// A batch's new and changed records by identifier, saved before it writes, so a redo after a crash inside it counts the records
// that attempt wrote as it did. files, skips: EHI (the files it lacked, its linking counts).
export type Pending = { index: number; created: string[]; updated: string[]; files?: string[]; skips?: Record<string, number> };
export type BatchOpts = {
  batchSize?: number;
  timeZone?: string; // where Apple Health days are cut (default: this machine's zone)
  skipThrough?: number;
  redo?: Pending;
  beforeWrite?: (p: Pending) => Promise<void> | void; // inside the batch's lock, before its first write
  onBatch?: (index: number, report: ImportReport & { unchanged?: number }) => Promise<void> | void;
  onArchived?: (archived: 'stored' | 'already-present') => Promise<void> | void;
  // EHI, fixed by the first attempt: the Epic org number read from the store (it shapes identifiers, so the batches), and the
  // concepts learned from the whole export (null: none). A later attempt gets them back instead of reading them again.
  epicOrg?: string | null;
  onEpicOrg?: (org: string | null) => Promise<void> | void;
  learned?: Record<string, MapEntry[]>;
  onLearned?: (learned: Record<string, MapEntry[]>) => Promise<void> | void;
};

// The first identifier (an object on some types), as `system|value`.
export const keyOf = (r: Resource): string => {
  const i = [(r as { identifier?: { system?: string; value?: string } | { system?: string; value?: string }[] }).identifier ?? []].flat()[0];
  return `${i?.system}|${i?.value}`;
};

// What GA holds of these records (every type but the Patient), by identifier: o.keys(found record) -> o.value(found record). One
// search per type and chunk of 40 identifiers (a URL near 4 KB); one with a comma alone, as the engine searches it (a comma
// separates values).
export async function held(
  client: MedplumClient,
  patientId: string,
  resources: Resource[],
  o: { tag?: string; elements: (type: string) => string; keys: (r: Resource) => string[]; value: (r: Resource) => string },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const type of new Set(resources.map((r) => r.resourceType).filter((t) => t !== 'Patient'))) {
    const ids = [...new Set(resources.filter((r) => r.resourceType === type).map(keyOf))];
    const plain = ids.filter((k) => !k.includes(','));
    const lists = [...ids.filter((k) => k.includes(',')).map((k) => [k]), ...plain.map((_, i) => plain.slice(i, i + 40)).filter((_, i) => i % 40 === 0)];
    for (const list of lists) {
      for await (const page of client.searchResourcePages(type as 'Observation', {
        [COMPARTMENT[type]]: `Patient/${patientId}`, ...(o.tag && { _tag: o.tag }), identifier: list.join(','), _count: '1000', _elements: o.elements(type),
      }, { cache: 'no-cache' })) {
        for (const r of page) for (const k of o.keys(r)) out.set(k, o.value(r));
      }
    }
  }
  return out;
}
