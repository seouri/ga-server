import type { MedplumClient } from '@medplum/core';
import type { AllergyIntolerance, Identifier, Resource } from '@medplum/fhirtypes';
import { archiveFolder } from '../archive.ts';
import type { GaConfig } from '../config.ts';
import { type BatchOpts, BATCH_SIZE, held, type Pending } from '../batches.ts';
import { addReport, COMPARTMENT, DUP_OF, importResources, type ImportReport } from '../engine.ts';
import { APPLE, sorted } from '../identity.ts';
import { withImportLock } from '../lock.ts';
import { uploadBinaries } from '../smart/sync.ts';
import { appleBatches, type Batch } from './batches.ts';
import type { ClinicalGroup } from './clinical.ts';
import { exportDateOf } from './read.ts';

const TAGGED = 'urn:ga-server:tag|src-apple-health';
const CLINICAL = 'urn:ga-server:tag|src-apple-clinical';
// Types the unchanged filter covers (readings and ECGs; any other type in a reading batch goes to the engine).
const FILTERED = new Set(['Observation', 'DocumentReference']);

const projection = (r: Record<string, unknown>) =>
  JSON.stringify({ status: r.status, code: r.code, valueQuantity: r.valueQuantity, valueString: r.valueString, component: r.component, effectiveDateTime: r.effectiveDateTime, effectivePeriod: r.effectivePeriod }, sorted);
const EMPTY = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 };
const firstId = (r: { identifier?: { system?: string; value?: string }[] }) => `${r.identifier?.[0]?.system}|${r.identifier?.[0]?.value}`;

// The Apple Health readings GA already holds for this patient among these resources: first identifier -> projection.
export const existing = (client: MedplumClient, patientId: string, resources: Resource[]): Promise<Map<string, string>> =>
  held(client, patientId, resources, {
    tag: TAGGED, keys: (r) => [firstId(r as never)], value: (r) => projection(r as never),
    elements: (type) => (FILTERED.has(type) ? 'identifier,status,code,valueQuantity,valueString,component,effectiveDateTime,effectivePeriod' : 'identifier'),
  });

const SMART = 'urn:ga-server:id:smart:';
const smartId = (r: Resource): Identifier | undefined => ((r as { identifier?: Identifier[] }).identifier ?? []).find((i) => i.system?.startsWith(SMART));
const appleId = (r: Resource): Identifier | undefined => ((r as { identifier?: Identifier[] }).identifier ?? []).find((i) => i.system === APPLE);

// An allergy an older import wrote is identified by its sourceURL only: give it the portal-style identifier now, so the engine
// finds it instead of writing a second one. Not when a record (a portal sync's) already holds that identifier: two records would
// share it; the old one is flagged possible-duplicate instead.
async function adoptOldAllergies(client: MedplumClient, patientId: string, resources: Resource[]): Promise<void> {
  for (const r of resources) {
    const s = smartId(r), a = appleId(r);
    if (r.resourceType !== 'AllergyIntolerance' || !s || !a) continue;
    const held = await client.searchOne('AllergyIntolerance', { identifier: `${s.system}|${s.value}`, patient: `Patient/${patientId}` }, { cache: 'no-cache' });
    const old = await client.searchOne('AllergyIntolerance', { identifier: `${APPLE}|${a.value}`, patient: `Patient/${patientId}` }, { cache: 'no-cache' }) as AllergyIntolerance | undefined;
    if (held) {
      // Left as it is, but flagged for review like the engine's possible duplicates, pointing at the record that holds the identifier.
      const ref = `AllergyIntolerance/${held.id}`;
      if (old && old.id !== held.id && !old.extension?.some((e) => e.url === DUP_OF && e.valueReference?.reference === ref)) {
        const tagged = old.meta?.tag?.some((t) => t.system === 'urn:ga-server:tag' && t.code === 'possible-duplicate');
        await client.updateResource({
          ...old,
          extension: [...(old.extension ?? []), { url: DUP_OF, valueReference: { reference: ref } }],
          meta: { ...old.meta, tag: [...(old.meta?.tag ?? []), ...(tagged ? [] : [{ system: 'urn:ga-server:tag', code: 'possible-duplicate' }])] },
        });
      }
      continue;
    }
    if (old && !old.identifier?.some((i) => i.system === s.system && i.value === s.value)) {
      // Also a clinical copy now: the tag moves from src-apple-health to src-apple-clinical in the same write.
      const tags = (old.meta?.tag ?? []).filter((t) => !(t.system === 'urn:ga-server:tag' && t.code === 'src-apple-health'));
      if (!tags.some((t) => t.system === 'urn:ga-server:tag' && t.code === 'src-apple-clinical')) tags.push({ system: 'urn:ga-server:tag', code: 'src-apple-clinical' });
      await client.updateResource({ ...old, identifier: [...(old.identifier ?? []), s], meta: { ...old.meta, tag: tags } });
    }
  }
}

const PATIENT: Resource = { resourceType: 'Patient', id: 'apple-patient' }; // what Patient/apple-patient means in every batch

// Reads the export and writes it batch by batch, each under the import lock with its own unchanged check. skipThrough:
// batches up to that index are read but not written (a resumed import). onBatch: after each committed batch, lock released.
export async function importAppleHealth(
  client: MedplumClient,
  cfg: GaConfig,
  dir: string,
  patientId = cfg.patientId,
  opts: BatchOpts = {},
): Promise<ImportReport & { archived: 'stored' | 'already-present'; unchanged: number; seconds: number; skips: Record<string, unknown> }> {
  const t0 = Date.now();
  const archived = await archiveFolder(client, dir, patientId, 'urn:ga-server:id:apple-health-archive');
  await opts.onArchived?.(archived);
  const source = { kind: 'apple-health', file: dir, date: await exportDateOf(dir), writer: 'importer' } as const;
  const total: ImportReport = { ...EMPTY, unmapped: [] };
  let unchanged = 0;
  let lastIndex = -1;
  const it = appleBatches(dir, { size: opts.batchSize ?? BATCH_SIZE, timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
  let n: IteratorResult<Batch, { skips: Record<string, unknown>; clinical: { resources: Resource[]; groups: ClinicalGroup[] } }>;
  try {
    n = await it.next();
    for (; !n.done; n = await it.next()) {
      const { index, resources } = n.value;
      lastIndex = index;
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
          // updated here (Ruling 10); a non-filtered type it updated counts as the engine's skip. Records stay exact.
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
  // The hospital's records (every R4 ClinicalRecord), after the readings, one locked call per FHIR base: the engine keys references by
  // Type/id, so two hospitals sharing an id must not share a call. Each call is a checkpoint of its own, numbered after the last reading
  // batch (the read always completes, so a resumed import counts the same indexes and skips the committed ones). Copies only fill what
  // another source's record lacks. A redo after a crash inside a base's call counts what the crashed attempt created as created.
  const { resources, groups } = n.value.clinical;
  const patient = resources.find((r) => r.resourceType === 'Patient') ?? PATIENT;
  const clinical = { ...source, kind: 'apple-clinical', fillOnly: () => true } as const; // hospital records: their own kind and tag
  const first = lastIndex + 1;
  const todo = groups.map((g, k) => ({ g, index: first + k })).filter((x) => x.index > (opts.skipThrough ?? -1));
  if (todo.length) await withImportLock(() => adoptOldAllergies(client, patientId, groups.flatMap((g) => g.resources)));
  // Patient files alone (no other readable clinical record): their identifiers still go onto GA's patient. Not a checkpoint: it writes
  // only the identifiers GA's patient lacks, so a resumed import may run it again.
  if (!groups.length && patient !== PATIENT) await withImportLock(() => importResources(client, [patient], clinical, patientId, ''));
  for (const { g, index } of todo) {
    const report = await withImportLock(async () => {
      await uploadBinaries(client, g.resources, g.binaries, g.src, patientId);
      const tracked = g.resources.filter((r) => COMPARTMENT[r.resourceType]); // the others (Medication, Practitioner...) are not patient data to look up
      const have = await held(client, patientId, tracked, { tag: CLINICAL, keys: (r) => [firstId(r as never)], value: () => '', elements: () => 'identifier' }); // keys only
      const redo = opts.redo?.index === index ? new Set(opts.redo.created) : undefined;
      const fresh = tracked.map((r) => firstId(r as never)).filter((id) => !have.has(id));
      if (!redo) await opts.beforeWrite?.({ index, created: fresh, updated: [] });
      const written = await importResources(client, [patient, ...g.resources], clinical, patientId, '');
      const was = redo ? tracked.map((r) => firstId(r as never)).filter((id) => redo.has(id) && have.has(id)).length : 0; // created by the crashed attempt
      return { ...written, created: written.created + was, skipped: Math.max(0, written.skipped - was) };
    });
    addReport(total, report);
    await opts.onBatch?.(index, report);
  }
  return { ...total, archived, unchanged, seconds: (Date.now() - t0) / 1000, skips: n.value.skips };
}
