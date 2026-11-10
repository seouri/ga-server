import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Resource } from '@medplum/fhirtypes';
import { type AppleBatchOpts, BATCH, type Pending } from '../apple/import.ts';
import { archiveFolder } from '../archive.ts';
import { learner } from '../concept-apply.ts';
import { loadMaps, upsertEntries } from '../conceptmap.ts';
import type { GaConfig } from '../config.ts';
import { storeDocument } from '../document.ts';
import { addReport, COMPARTMENT, importResources, type ImportReport } from '../engine.ts';
import { SRC_DATE, type SourceInfo } from '../identity.ts';
import { withImportLock } from '../lock.ts';
import { walkReferences } from '../patient.ts';
import { sha256File } from '../upload-stream.ts';
import { mapConditions } from './conditions.ts';
import { MEDIA_TYPE, mapMessages, mapNotes, noteFiles } from './documents.ts';
import { mapEncounters } from './encounters.ts';
import { linkImmunizationsToExisting, mapFamilyHistory, mapHealthMaintenance, mapImmunizations, mapQuestionnaires, mapSocial, mapVitals } from './history.ts';
import { type EhiCtx, epicOrgNumber, PATIENT_REF, resolveUnlinked } from './ids.ts';
import { linkResultsToExisting, mapLabs } from './labs.ts';
import { mapMeds } from './meds.ts';
import { EhiTables, exportInfo } from './read.ts';

const ARCHIVE = 'urn:ga-server:id:ehi-archive';
const PATIENT: Resource = { resourceType: 'Patient', id: PATIENT_REF.reference.split('/')[1] }; // no PATIENT mapper: collapses onto the GA patient
// A batch of notes or messages also ends at about this much JSON, so a batch of long notes stays small.
const BATCH_BYTES = 1 << 20;

export async function ehiContext(client: MedplumClient, dir: string, patientId: string, timeZone?: string): Promise<EhiCtx> {
  return { ...exportInfo(dir, timeZone), epicOrgNumber: await epicOrgNumber(client, patientId) };
}

// Counts from reading the export: the same on every attempt (each attempt reads the whole export).
const readCounts = () => ({
  labs: { skippedNoName: 0 },
  imm: { skippedNoName: 0, immAdminSameDose: 0, immAdminPossibleDuplicate: 0 },
  family: { skippedNoRelative: 0, skippedNoCondition: 0 },
  vitals: { skippedEmpty: 0 },
  hm: { skippedNoDate: 0 },
  quest: { skippedEmpty: 0 },
  files: { mediaUnknownType: 0, rtfNoNote: 0 },
});
type ReadCounts = ReturnType<typeof readCounts>;
// Counts from the linking passes, which read the store: summed over the batches (a resumed job keeps them in its checkpoint).
type LinkCounts = { conditionNoName: number; labResultsLinked: number; labResultsUnidentified: number; immunizationsEpicLinked: number; immAdminMatched: number; immAdminUnmatched: number };
const LINK_KEYS = ['conditionNoName', 'labResultsLinked', 'labResultsUnidentified', 'immunizationsEpicLinked', 'immAdminMatched', 'immAdminUnmatched'] as const;

// A batch: records for the engine, and files stored first (a note's Rich Text files, which the note then points at; media).
type File = { path: string; type?: string; note?: string }; // note: the id of the note it belongs to
type Batch = { index: number; resources: Resource[]; files: File[] };

// Groups (a report with its results, a day's doses, a thread) are never cut; a batch ends at `size` items or BATCH_BYTES.
function* cut<T>(items: Iterable<T>, size: number, weigh: (x: T) => [n: number, bytes: number]): Generator<T[]> {
  let buf: T[] = [];
  let n = 0;
  let bytes = 0;
  for (const x of items) {
    buf.push(x);
    const [k, b] = weigh(x);
    n += k;
    bytes += b;
    if (n >= size || bytes >= BATCH_BYTES) {
      yield buf;
      buf = [];
      n = bytes = 0;
    }
  }
  if (buf.length) yield buf;
}
const weight = (g: Resource | Resource[]): [number, number] => {
  const rs = [g].flat();
  return [rs.length, JSON.stringify(rs).length];
};

// The records: every mapper in order, visits first (everything else points at them).
function* records(t: EhiTables, ctx: EhiCtx, c: ReadCounts): Generator<Resource | Resource[]> {
  yield* mapEncounters(t, ctx);
  yield* mapConditions(t, ctx);
  yield* mapLabs(t, ctx, c.labs);
  yield* mapMeds(t, ctx);
  yield* mapImmunizations(t, ctx, c.imm);
  yield* mapFamilyHistory(t, ctx, c.family);
  yield* mapVitals(t, ctx, c.vitals);
  yield* mapSocial(t, ctx);
  yield* mapHealthMaintenance(t, ctx, c.hm);
  yield* mapQuestionnaires(t, ctx, c.quest);
}

// The documents: the visits again (they were sent with the notes and messages, and counted again, before batching), notes with
// their Rich Text files, messages, media files. Files no note uses and media of an unknown type are counted (they stay in the archive).
function* documents(t: EhiTables, ctx: EhiCtx, dir: string, size: number, c: ReadCounts): Generator<Omit<Batch, 'index'>> {
  for (const rs of cut(mapEncounters(t, ctx), size, weight)) yield { resources: rs, files: [] };
  const files = noteFiles(dir);
  const used = new Set<string>();
  for (const notes of cut(mapNotes(t, ctx, dir, files), size, (n) => weight(n.doc))) {
    for (const n of notes) for (const f of n.rtf) used.add(f);
    yield { resources: notes.map((n) => n.doc), files: notes.flatMap((n) => n.rtf.map((path) => ({ path, type: 'text/rtf', note: n.doc.id }))) };
  }
  const rtfDir = join(dir, 'Rich Text');
  c.files.rtfNoNote += (existsSync(rtfDir) ? readdirSync(rtfDir) : []).filter((f) => !used.has(join(rtfDir, f))).length;
  for (const g of cut(mapMessages(t, ctx), size, weight)) yield { resources: g.flat(), files: [] };
  const mediaDir = join(dir, 'Media');
  const media = (existsSync(mediaDir) ? readdirSync(mediaDir).sort() : []).map((f): File => ({ path: join(mediaDir, f), type: MEDIA_TYPE[extname(f).toLowerCase()] }));
  for (const fs of cut(media, size, () => [1, 0])) {
    c.files.mediaUnknownType += fs.filter((f) => !f.type).length;
    yield { resources: [], files: fs };
  }
}

// The export's batches in order. Same export and size: same batches, so a resumed import skips exactly the written ones.
function* ehiBatches(t: EhiTables, ctx: EhiCtx, dir: string, size: number, c: ReadCounts): Generator<Batch> {
  let index = 0;
  for (const g of cut(records(t, ctx, c), size, weight)) yield { index: index++, resources: g.flat(), files: [] };
  for (const b of documents(t, ctx, dir, size, c)) yield { index: index++, ...b };
}

// The linking passes of one batch (each reads the store; none writes). Groups keep a pass's pairs inside one batch.
async function link(client: MedplumClient, resources: Resource[], patientId: string): Promise<{ resources: Resource[]; counts: LinkCounts }> {
  const results = await linkResultsToExisting(client, resources, patientId);
  const imms = await linkImmunizationsToExisting(client, results.resources, patientId);
  const unlinked = await resolveUnlinked(client, imms.resources, patientId);
  return {
    resources: unlinked.resources,
    counts: {
      conditionNoName: unlinked.skippedNoName, labResultsLinked: results.identified, labResultsUnidentified: results.unidentified,
      immunizationsEpicLinked: imms.epicLinked, immAdminMatched: imms.matched, immAdminUnmatched: imms.unmatched,
    },
  };
}

// The engine learns concepts from the records it gets; in batches each would learn from its own records only. So they are learned
// from all of the export's records first, as one batch did (the engine's per-batch learning is off: SourceInfo.prelearned).
async function learnAll(client: MedplumClient, dir: string, ctx: EhiCtx, patientId: string, size: number, source: SourceInfo): Promise<void> {
  const maps = await loadMaps(client, true).catch((e: Error) => void console.error(`concept maps not read: ${e.message}`));
  if (!maps) return;
  const l = learner(maps);
  for (const g of cut(records(new EhiTables(dir), ctx, readCounts()), size, weight)) {
    for (const r of (await link(client, g.flat(), patientId)).resources) l.add(r, source);
  }
  for (const [key, entries] of l.entries()) await upsertEntries(client, key, entries).catch((e: Error) => console.error(`concept map ${key} not updated: ${e.message}`));
}

// A reference to a record of this export in an earlier batch (a visit, a dose, a thread's first message) points at that record,
// found by its EHI identifier: the engine resolves references within one batch only. Local ids are `<TABLE>-<pk>` (ids.ts).
// shortcut: a record the engine linked to another source's record without adding its EHI identifier (a conflict with a person's
// edit) is not found, so a reference to it is left unresolved and the record pointing at it is invalid, as a dangling reference.
const LOCAL = /^(\w+)\/([A-Z][A-Z_]*)-(.+)$/;
async function resolveRefs(client: MedplumClient, resources: Resource[], ctx: EhiCtx, patientId: string): Promise<void> {
  const here = new Set(resources.map((r) => `${r.resourceType}/${r.id}`));
  const found = new Map<string, string>();
  walkReferences(resources, (ref) => void (!here.has(ref) && LOCAL.test(ref) && found.set(ref, '')));
  for (const ref of found.keys()) {
    const [, type, table, pk] = LOCAL.exec(ref) as RegExpExecArray;
    const hit = await client.searchOne(type as 'Encounter', { identifier: `urn:ga-server:id:ehi:${ctx.org}|${table}|${pk}`, [COMPARTMENT[type]]: `Patient/${patientId}` }, { cache: 'no-cache' });
    if (hit) found.set(ref, `${type}/${hit.id}`);
    else found.delete(ref);
  }
  walkReferences(resources, (ref) => found.get(ref));
}

// What GA holds now of these records, by EHI identifier (`system|value`) -> source date.
const keyOf = (r: Resource) => {
  const i = [(r as { identifier?: { system?: string; value?: string } | { system?: string; value?: string }[] }).identifier ?? []].flat()[0];
  return `${i?.system}|${i?.value}`;
};
async function held(client: MedplumClient, resources: Resource[], patientId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const type of new Set(resources.map((r) => r.resourceType))) {
    const keys = [...new Set(resources.filter((r) => r.resourceType === type).map(keyOf))];
    // A value with a comma is looked up alone, as the engine does (a comma separates values in a search).
    const lists = [...keys.filter((k) => k.includes(',')).map((k) => [k]), ...Array.from({ length: Math.ceil(keys.filter((k) => !k.includes(',')).length / 40) }, (_, i) => keys.filter((k) => !k.includes(',')).slice(i * 40, i * 40 + 40))];
    const want = new Set(keys);
    for (const list of lists) {
      for await (const page of client.searchResourcePages(type as 'Observation', { [COMPARTMENT[type]]: `Patient/${patientId}`, identifier: list.join(','), _count: '1000', _elements: 'identifier,extension' }, { cache: 'no-cache' })) {
        for (const r of page) {
          const date = (r as { extension?: { url: string; valueDateTime?: string }[] }).extension?.find((e) => e.url === SRC_DATE)?.valueDateTime ?? '';
          for (const i of [r.identifier ?? []].flat()) if (want.has(`${i.system}|${i.value}`)) out.set(`${i.system}|${i.value}`, date);
        }
      }
    }
  }
  return out;
}
const fileStored = async (client: MedplumClient, path: string, patientId: string) => {
  const hash = await sha256File(path);
  return { hash, stored: !!(await client.searchOne('DocumentReference', `identifier=urn:ga-server:id:file|${hash}&subject=Patient/${patientId}`, { cache: 'no-cache' })) };
};

// One batch, under the import lock: its files, then its records. pending (Task 5's checkpoint): before the first write, what of the
// batch GA lacks (created) or holds from an older source (updated), the files it lacks and the linking counts; a redo after a
// crash inside the batch counts what the crashed attempt wrote as that attempt did.
// shortcut: a record the crashed attempt linked to another source's record (merged, updated) or flagged counts as created or
// updated (Ruling 10); the records are exact.
async function writeBatch(client: MedplumClient, b: Batch, ctx: EhiCtx, patientId: string, source: SourceInfo, opts: AppleBatchOpts): Promise<ImportReport & { skips: LinkCounts }> {
  const { resources, counts } = await link(client, b.resources, patientId);
  await resolveRefs(client, resources, ctx, patientId);
  const redo = opts.redo?.index === b.index ? opts.redo : undefined;
  return withImportLock(async () => {
    const report: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: [] };
    const have = await held(client, resources, patientId);
    if (!redo) {
      const files = [];
      for (const f of b.files) if (f.type) files.push(await fileStored(client, f.path, patientId));
      const older = (k: string) => have.has(k) && Date.parse(have.get(k) as string) < Date.parse(ctx.date);
      await opts.beforeWrite?.({
        index: b.index, created: resources.map(keyOf).filter((k) => !have.has(k)), updated: resources.map(keyOf).filter(older),
        files: files.filter((f) => !f.stored).map((f) => f.hash), skips: counts,
      });
    }
    const redoFiles = new Set(redo?.files);
    for (const f of b.files) {
      if (!f.type) {
        console.error(`media skipped, unknown type: ${extname(f.path)}`);
        report.skipped++;
        continue;
      }
      const { docRef, created, fileHash } = await storeDocument(client, f.path, patientId, f.type);
      if (created || redoFiles.delete(fileHash)) report.created++; // a file stored by the crashed attempt: created, once per content
      else report.skipped++;
      const note = f.note && (resources.find((r) => r.id === f.note) as DocumentReference | undefined);
      if (note) note.relatesTo = [...(note.relatesTo ?? []), { code: 'transforms', target: { reference: `DocumentReference/${docRef.id}` } }];
    }
    if (resources.length) addReport(report, await importResources(client, [PATIENT, ...resources], source, patientId, ''));
    if (redo) { // the engine skipped what the crashed attempt wrote
      const created = redo.created.filter((k) => have.has(k)).length;
      const updated = redo.updated.filter((k) => Date.parse(have.get(k) ?? '') === Date.parse(ctx.date)).length;
      report.created += created;
      report.updated += updated;
      report.skipped -= created + updated;
    }
    return { ...report, skips: (redo?.skips as LinkCounts | undefined) ?? counts };
  });
}

// Reads the export and writes it batch by batch (records, then notes, messages and media files), each under the import lock.
// skipThrough: batches up to that index are read but not written (a resumed import). onBatch: after each committed batch.
export async function importEhi(
  client: MedplumClient,
  cfg: GaConfig,
  dir: string,
  patientId = cfg.patientId,
  timeZone?: string,
  opts: AppleBatchOpts = {},
): Promise<
  ImportReport & {
    skippedTables: number;
    archived: 'stored' | 'already-present';
    skips: ReturnType<typeof skipsOf> & ReadCounts['files'] & { tables: EhiTables['skipped'] };
  }
> {
  const ctx = await ehiContext(client, dir, patientId, timeZone);
  // First, so the original is kept even if a later step fails (idempotent: found by its manifest on a re-run).
  const archived = await archiveFolder(client, dir, patientId, ARCHIVE);
  await opts.onArchived?.(archived);
  const size = opts.batchSize ?? BATCH;
  const source: SourceInfo = { kind: 'ehi', file: dir, date: ctx.date, writer: 'importer' };
  await learnAll(client, dir, ctx, patientId, size, source);
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: [] };
  const linked: LinkCounts = { conditionNoName: 0, labResultsLinked: 0, labResultsUnidentified: 0, immunizationsEpicLinked: 0, immAdminMatched: 0, immAdminUnmatched: 0 };
  const t = new EhiTables(dir);
  const c = readCounts();
  for (const b of ehiBatches(t, ctx, dir, size, c)) {
    if (b.index <= (opts.skipThrough ?? -1)) continue;
    const r = await writeBatch(client, b, ctx, patientId, { ...source, prelearned: true }, opts);
    addReport(report, r);
    for (const k of LINK_KEYS) linked[k] += r.skips[k];
    await opts.onBatch?.(b.index, r);
  }
  return { ...report, skippedTables: t.skipped.length, archived, skips: { ...skipsOf(linked, c), ...c.files, tables: t.skipped } };
}

// Counts only, each with its reason. Unidentified/unmatched records are still created (separately), not dropped.
const skipsOf = (linked: LinkCounts, c: ReadCounts) => ({
  conditionNoName: linked.conditionNoName, labResultNoName: c.labs.skippedNoName, labResultsLinked: linked.labResultsLinked, labResultsUnidentified: linked.labResultsUnidentified,
  immunizationNoName: c.imm.skippedNoName, immAdminSameDose: c.imm.immAdminSameDose, immAdminPossibleDuplicate: c.imm.immAdminPossibleDuplicate,
  immunizationsEpicLinked: linked.immunizationsEpicLinked, immAdminMatched: linked.immAdminMatched, immAdminUnmatched: linked.immAdminUnmatched,
  familyNoRelative: c.family.skippedNoRelative, familyNoCondition: c.family.skippedNoCondition, vitalsEmpty: c.vitals.skippedEmpty,
  healthMaintenanceNoDate: c.hm.skippedNoDate, questionnairesEmpty: c.quest.skippedEmpty,
});

// The records with the linking passes applied and their counts, unwritten (the real-data dry pass).
export async function prepareEhi(client: MedplumClient, t: EhiTables, ctx: EhiCtx, patientId: string) {
  const resources: Resource[] = [];
  const counts: LinkCounts = { conditionNoName: 0, labResultsLinked: 0, labResultsUnidentified: 0, immunizationsEpicLinked: 0, immAdminMatched: 0, immAdminUnmatched: 0 };
  const c = readCounts();
  for (const g of cut(records(t, ctx, c), BATCH, weight)) {
    const l = await link(client, g.flat(), patientId);
    resources.push(...l.resources);
    for (const k of LINK_KEYS) counts[k] += l.counts[k];
  }
  return { resources, skips: skipsOf(counts, c) };
}
