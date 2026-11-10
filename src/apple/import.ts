import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { archiveFolder } from '../archive.ts';
import type { GaConfig } from '../config.ts';
import { addReport, importResources, type ImportReport } from '../engine.ts';
import { sorted } from '../identity.ts';
import { withImportLock } from '../lock.ts';
import { appleBatches } from './batches.ts';
import { exportDateOf } from './read.ts';

const TAGGED = 'urn:ga-server:tag|src-apple-health';
// Types the unchanged filter covers (AllergyIntolerance always goes to the engine: its status/reaction can change under one id) and the search param naming the patient.
const TYPES: [string, string][] = [['Observation', 'subject'], ['DocumentReference', 'subject']];

const projection = (r: Record<string, unknown>) =>
  JSON.stringify({ status: r.status, code: r.code, valueQuantity: r.valueQuantity, valueString: r.valueString, component: r.component, effectiveDateTime: r.effectiveDateTime, effectivePeriod: r.effectivePeriod }, sorted);
const EMPTY = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 };
const firstId = (r: { identifier?: { system?: string; value?: string }[] }) => `${r.identifier?.[0]?.system}|${r.identifier?.[0]?.value}`;

// What GA already holds from Apple Health for this patient among these resources: first identifier -> projection. One
// search per type and chunk of identifiers (a chunk's URL stays near 4 KB).
const CHUNK = 40;
export async function existing(client: MedplumClient, patientId: string, resources: Resource[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [type, param] of TYPES) {
    const ids = [...new Set(resources.filter((r) => r.resourceType === type).map((r) => firstId(r as never)))];
    for (let i = 0; i < ids.length; i += CHUNK) {
      for await (const page of client.searchResourcePages(type as 'Observation', {
        [param]: `Patient/${patientId}`, _tag: TAGGED, identifier: ids.slice(i, i + CHUNK).join(','), _count: '1000',
        _elements: 'identifier,status,code,valueQuantity,valueString,component,effectiveDateTime,effectivePeriod',
      }, { cache: 'no-cache' })) {
        for (const r of page) out.set(firstId(r as never), projection(r as never));
      }
    }
  }
  return out;
}

const BATCH = 500;
const PATIENT: Resource = { resourceType: 'Patient', id: 'apple-patient' }; // what Patient/apple-patient means in every batch

// Reads the export and writes it batch by batch, each under the import lock with its own unchanged check. skipThrough:
// batches up to that index are read but not written (a resumed import). onBatch: after each committed batch, lock released.
export async function importAppleHealth(
  client: MedplumClient,
  cfg: GaConfig,
  dir: string,
  patientId = cfg.patientId,
  opts: { batchSize?: number; skipThrough?: number; onBatch?: (index: number, report: ImportReport & { unchanged: number }) => Promise<void> } = {},
): Promise<ImportReport & { archived: 'stored' | 'already-present'; unchanged: number; seconds: number; skips: Record<string, unknown> }> {
  const t0 = Date.now();
  const archived = await archiveFolder(client, dir, patientId, 'urn:ga-server:id:apple-health-archive');
  const source = { kind: 'apple-health', file: dir, date: await exportDateOf(dir), writer: 'importer' } as const;
  const total: ImportReport = { ...EMPTY, unmapped: [] };
  let unchanged = 0;
  const it = appleBatches(dir, { size: opts.batchSize ?? BATCH, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  let n = await it.next();
  for (; !n.done; n = await it.next()) {
    const { index, resources } = n.value;
    if (index <= (opts.skipThrough ?? -1)) continue;
    const report = await withImportLock(async () => {
      const have = await existing(client, patientId, resources);
      let same = 0;
      const rest = resources.filter((r) => {
        if (r.resourceType === 'Patient' || r.resourceType === 'AllergyIntolerance') return true;
        const hit = have.get(firstId(r as never)) === projection(r as never);
        if (hit) same++;
        return !hit;
      });
      const written = rest.length ? await importResources(client, [PATIENT, ...rest], source, patientId, '') : { ...EMPTY, unmapped: [] };
      return { ...written, unchanged: same };
    });
    addReport(total, report);
    unchanged += report.unchanged;
    await opts.onBatch?.(index, report);
  }
  return { ...total, archived, unchanged, seconds: (Date.now() - t0) / 1000, skips: n.value.skips };
}
