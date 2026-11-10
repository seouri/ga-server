import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { archiveFolder } from '../archive.ts';
import type { GaConfig } from '../config.ts';
import { addReport, COMPARTMENT, importResources, type ImportReport } from '../engine.ts';
import { sorted } from '../identity.ts';
import { withImportLock } from '../lock.ts';
import { appleBatches, type Batch } from './batches.ts';
import { exportDateOf } from './read.ts';

const TAGGED = 'urn:ga-server:tag|src-apple-health';
// Types the unchanged filter covers (AllergyIntolerance always goes to the engine: its status/reaction can change under one id).
const FILTERED = new Set(['Observation', 'DocumentReference']);

const projection = (r: Record<string, unknown>) =>
  JSON.stringify({ status: r.status, code: r.code, valueQuantity: r.valueQuantity, valueString: r.valueString, component: r.component, effectiveDateTime: r.effectiveDateTime, effectivePeriod: r.effectivePeriod }, sorted);
const EMPTY = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 };
const firstId = (r: { identifier?: { system?: string; value?: string }[] }) => `${r.identifier?.[0]?.system}|${r.identifier?.[0]?.value}`;

// What GA already holds from Apple Health for this patient among these resources (every type but the Patient): first
// identifier -> projection. One search per type and chunk of identifiers (a chunk's URL stays near 4 KB).
const CHUNK = 40;
export async function existing(client: MedplumClient, patientId: string, resources: Resource[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const type of new Set(resources.map((r) => r.resourceType).filter((t) => t !== 'Patient'))) {
    const ids = [...new Set(resources.filter((r) => r.resourceType === type).map((r) => firstId(r as never)))];
    for (let i = 0; i < ids.length; i += CHUNK) {
      for await (const page of client.searchResourcePages(type as 'Observation', {
        [COMPARTMENT[type]]: `Patient/${patientId}`, _tag: TAGGED, identifier: ids.slice(i, i + CHUNK).join(','), _count: '1000',
        _elements: FILTERED.has(type) ? 'identifier,status,code,valueQuantity,valueString,component,effectiveDateTime,effectivePeriod' : 'identifier',
      }, { cache: 'no-cache' })) {
        for (const r of page) out.set(firstId(r as never), projection(r as never));
      }
    }
  }
  return out;
}

export const BATCH = 500;
// A batch's new and changed records by first identifier, saved before it writes (Pending), so a redo after a crash inside
// it counts the records that attempt wrote as created/updated, not unchanged.
export type Pending = { index: number; created: string[]; updated: string[] };
export type AppleBatchOpts = {
  batchSize?: number;
  timeZone?: string; // where days are cut (default: this machine's zone)
  skipThrough?: number;
  redo?: Pending;
  beforeWrite?: (p: Pending) => Promise<void> | void; // inside the batch's lock, before its first write
  onBatch?: (index: number, report: ImportReport & { unchanged?: number }) => Promise<void> | void;
  onArchived?: (archived: 'stored' | 'already-present') => Promise<void> | void;
};
const PATIENT: Resource = { resourceType: 'Patient', id: 'apple-patient' }; // what Patient/apple-patient means in every batch

// Reads the export and writes it batch by batch, each under the import lock with its own unchanged check. skipThrough:
// batches up to that index are read but not written (a resumed import). onBatch: after each committed batch, lock released.
export async function importAppleHealth(
  client: MedplumClient,
  cfg: GaConfig,
  dir: string,
  patientId = cfg.patientId,
  opts: AppleBatchOpts = {},
): Promise<ImportReport & { archived: 'stored' | 'already-present'; unchanged: number; seconds: number; skips: Record<string, unknown> }> {
  const t0 = Date.now();
  const archived = await archiveFolder(client, dir, patientId, 'urn:ga-server:id:apple-health-archive');
  await opts.onArchived?.(archived);
  const source = { kind: 'apple-health', file: dir, date: await exportDateOf(dir), writer: 'importer' } as const;
  const total: ImportReport = { ...EMPTY, unmapped: [] };
  let unchanged = 0;
  const it = appleBatches(dir, { size: opts.batchSize ?? BATCH, timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
  let n: IteratorResult<Batch, { skips: Record<string, unknown> }>;
  try {
    n = await it.next();
    for (; !n.done; n = await it.next()) {
      const { index, resources } = n.value;
      if (index <= (opts.skipThrough ?? -1)) continue;
      const report = await withImportLock(async () => {
        const have = await existing(client, patientId, resources);
        const redo = opts.redo?.index === index ? { created: new Set(opts.redo.created), updated: new Set(opts.redo.updated) } : undefined;
        const p: Pending = { index, created: [], updated: [] };
        let kept = 0, created = 0, updated = 0;
        const rest = resources.filter((r) => {
          if (r.resourceType === 'Patient') return true;
          const id = firstId(r as never), had = have.get(id), same = had === projection(r as never);
          // A redo: what the crashed attempt wrote counts as its engine counted it (created or updated).
          // shortcut: a record that attempt's engine counted as merged, a possible duplicate or a conflict counts as created or
          // updated here (Ruling 10); a non-filtered type (the allergy) it updated counts as the engine's skip. Records stay exact.
          if (redo?.created.has(id) && had !== undefined) created++;
          else if (redo?.updated.has(id) && same) updated++;
          else if (FILTERED.has(r.resourceType) && same) kept++;
          else {
            if (had === undefined) p.created.push(id);
            else if (FILTERED.has(r.resourceType)) p.updated.push(id);
            return true;
          }
          return false;
        });
        if (!redo) await opts.beforeWrite?.(p); // a redo keeps the first attempt's lists
        const written = rest.length ? await importResources(client, [PATIENT, ...rest], source, patientId, '') : { ...EMPTY, unmapped: [] };
        return { ...written, created: written.created + created, updated: written.updated + updated, unchanged: kept };
      });
      addReport(total, report);
      unchanged += report.unchanged;
      await opts.onBatch?.(index, report);
    }
  } finally { await it.return(undefined as never); } // a failed batch: stop the read and close export.xml now (a gateway worker lives on)
  return { ...total, archived, unchanged, seconds: (Date.now() - t0) / 1000, skips: n.value.skips };
}
