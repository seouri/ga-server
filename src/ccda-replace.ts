// `ga ccda replace` (CLI only, owner-started; Task 13 removes it with the Microsoft converter): the Microsoft-era C-CDA records
// replaced by the in-process converter's, made from GA's stored C-CDA documents. Without --yes a dry run: it reads, matches and
// prints counts, and writes nothing. With --yes, under the import lock, in this order (each step is safe to rerun after a crash):
//  1. read: the stored C-CDA documents and this patient's C-CDA records; a record this command wrote carries MARK, every other
//     one is old. Refusals (a source document not stored, an entry the new path neither imports nor names) come before any write.
//  2. backup (compose ga-backup or ga-backup-store, RUN_ONCE=1): no backup, no write.
//  3. strip: an old record another GA source also holds (EHI, portal, PDF, Apple) keeps its body and loses only its C-CDA
//     identifiers and src-ccda tag, so the new import links to it again.
//  4. write: every stored document imported on the new path, oldest first, with the other old records hidden from the import
//     (it can neither find, link, merge nor flag them). Each record it writes carries MARK; one it creates takes its document's
//     import time as arrival: the earliest arrival of that document's old records, else none (GA never stamps the stored file).
//  5. match: each old record to the converted record it continues (matchEntries, per source document), found in the store by its
//     new C-CDA key. A new record takes its old counterpart's arrival time.
//  6. protected (source-conflict, person-edited, agent-written): the old record stays with its body and takes its counterpart's
//     C-CDA identifier; that new copy goes (references follow it to the protected record).
//  7. repoint: anything in the patient compartment (and Basic) pointing at a record that goes points at its counterpart.
//  8. delete: old records with a counterpart; Compositions last, after the check below (while one remains the record reads as
//     Microsoft-era, so a rerun runs in full). An old record with no counterpart is kept, pointed at or not: never less. (One
//     holding no information, which compare explains, cannot be stored: both stores refuse an Observation without a code.)
//  9. check: nothing points at a deleted record; only then "ccdaConverter": "medplum" in the config.
// A run that stopped is rerun on the store it started on: after ga migrate-store a deleted record reads 404 (the copy holds no
// deletes), which the final check cannot tell from a reference that never pointed anywhere.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGone, isNotFound, type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Extension, Identifier, Resource } from '@medplum/fhirtypes';
import { ccdaDate, convertCcdaLocal, custodian, isCcda, LOCAL_TAG } from './ccda.ts';
import { compareCcda, matchEntries } from './ccda-compare.ts';
import { stripConcept } from './concept-apply.ts';
import { defaultConfigPath, GaError, type GaConfig, setCcdaConverter, storeKind } from './config.ts';
import { batchKeys, choiceBase, COMPARTMENT, DATA_ABSENT, DUP_OF, importResources } from './engine.ts';
import { ARRIVED, arrivedAt, hasTag, LAST_SEEN, sha256, SINGULAR_ID, SRC_DATE, TAG, type SourceInfo } from './identity.ts';
import { withImportLock } from './lock.ts';
import { walkReferences } from './patient.ts';

export type ReplaceReport = {
  deleted: Record<string, number>; // old records removed: each has a new counterpart
  stripped: Record<string, number>; // records another source holds: only their C-CDA identifiers came off
  kept: Record<string, number>; // old records kept: protected, or with no counterpart
  created: Record<string, number>; // records the new path created (dry run: converted records no old one continues)
  repointed: number; // records whose references were moved to a new counterpart
  dangling: number; // references to a deleted record left after the run (must be 0)
  documents: number;
};
export type ReplaceOptions = {
  yes: boolean;
  log: (s: string) => void;
  configFile?: string; // the config the flag is written to; default GA's own
  backup?: () => Promise<void>; // default composeBackup; throws when no backup was made
  after?: (step: string) => void | Promise<void>; // tests: a crash (or another write) between steps
};

type R = Resource & { identifier?: Identifier | Identifier[]; extension?: Extension[] };
type Doc = { id: string; hash: string; title: string; xml: string; file?: string; at?: string };

const CCDA = 'urn:ga-server:id:ccda';
// On every record this command wrote: a rerun never takes it for an old one.
const MARK = 'ccda-replace';
// On a record the strip took the C-CDA identifiers off, until the new path links it again (the write removes it): one still
// carrying it after the write would leave a copy beside it, so the run stops, on every rerun too.
const STRIPPED = 'ccda-stripped';
const PROTECT = ['source-conflict', 'person-edited', 'writer-agent'];
const refOf = (r: Resource) => `${r.resourceType}/${r.id}`;
const idsOf = (r: R): Identifier[] => [r.identifier ?? []].flat();
const withIds = (r: R, ids: Identifier[]): R => ({ ...r, identifier: SINGULAR_ID.has(r.resourceType) ? ids[0] : ids }) as R;
const otherSource = (r: R) => idsOf(r).some((i) => i.system?.startsWith('urn:ga-server:id:') && i.system !== CCDA);
const isProtected = (r: Resource) => PROTECT.some((c) => hasTag(r, c));
const add = (m: Record<string, number>, t: string) => { m[t] = (m[t] ?? 0) + 1; };
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
const byType = (m: Record<string, number>) => Object.entries(m).map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
const BOOK = new Set([SRC_DATE, ARRIVED, DUP_OF, LAST_SEEN]);
const untag = (r: R, code: string): R => ({ ...r, meta: { ...r.meta, tag: (r.meta?.tag ?? []).filter((t) => !(t.system === TAG && t.code === code)) } });
const retag = (r: R, code: string): R => (hasTag(r, code) ? r : { ...r, meta: { ...r.meta, tag: [...(r.meta?.tag ?? []), { system: TAG, code }] } });

// A stored record as its converter gave it, for matchEntries: no GA identifiers, codings or bookkeeping.
function asConverted(r: R): Resource {
  const { identifier, extension, ...rest } = stripConcept(r) as R;
  const ids = idsOf({ identifier } as R).filter((i) => !i.system?.startsWith('urn:ga-server:id:'));
  const ext = (extension ?? []).filter((e) => !BOOK.has(e.url));
  return { ...rest, ...(ids.length && { identifier: ids }), ...(ext.length && { extension: ext }) } as Resource;
}

const pointsAt = (r: Resource, refs: Set<string>): string[] => {
  const hits: string[] = [];
  walkReferences(r, (ref) => { if (refs.has(ref)) hits.push(ref); return undefined; });
  return hits;
};

async function all(client: MedplumClient, type: string, q: Record<string, string>): Promise<R[]> {
  const out: R[] = [];
  for await (const page of client.searchResourcePages(type as 'Observation', { ...q, _count: '1000' }, { cache: 'no-cache' })) out.push(...(page as R[]));
  return out;
}

// Everything in the patient's compartment, GA's reminders and follow-ups (Basic), the patient's RelatedPersons, and every Provenance (record_followup keeps the
// note or report it quotes there; Provenance has no patient, and GA writes few), one page at a time. AuditEvents are access logs:
// left as they were.
const SCANNED = [...Object.entries(COMPARTMENT), ['Basic', 'subject'], ['RelatedPerson', 'patient'], ['Provenance', '']];
async function scan(client: MedplumClient, pid: string, fn: (r: R) => void): Promise<void> {
  for (const [type, field] of SCANNED) {
    for await (const page of client.searchResourcePages(type as 'Observation', { ...(field && { [field]: `Patient/${pid}` }), _count: '1000' }, { cache: 'no-cache' })) {
      for (const r of page) fn(r as R);
    }
  }
}

// References from anything scan reads to a deleted record of a scanned type (a run that stopped after its last delete no longer
// knows what it deleted). Targets outside the scan (another patient's, a patient-less record) are read to be sure. A target that
// never existed is not counted: the Microsoft path pointed reports at placeholder results the store refused (no code), long before
// this command; both stores tell a deleted record (410 gone) from one never written (404). Any other error (a store down, a
// rate limit, a lost login) stops the check: it never counts as "not missing". After ga migrate-store a deleted record reads 404
// (the copy holds no deletes), so a crashed run must be rerun on the store it started on.
async function missingTargets(client: MedplumClient, pid: string): Promise<number> {
  const have = new Set<string>();
  const refs: string[] = [];
  const types = new Set(SCANNED.map(([t]) => t));
  const refsOf = (r: R) => { const out: string[] = []; walkReferences(r, (x) => { if (types.has(x.split('/')[0]) && x.split('/').length === 2) out.push(x); return undefined; }); return out; };
  const provs: R[] = []; // Provenance has no patient: only one about this patient's records counts
  await scan(client, pid, (r) => { have.add(refOf(r)); if (r.resourceType === 'Provenance') provs.push(r); else refs.push(...refsOf(r)); });
  for (const p of provs) { const rs = refsOf(p); if (rs.some((x) => have.has(x))) refs.push(...rs); }
  let missing = 0;
  for (const x of new Set(refs.filter((x) => !have.has(x)))) {
    const [type, id] = x.split('/');
    const gone = await client.readResource(type as 'Observation', id).then(() => false, (e) => {
      if (e instanceof OperationOutcomeError && isGone(e.outcome)) return true;
      if (e instanceof OperationOutcomeError && isNotFound(e.outcome)) return false;
      throw e;
    });
    if (gone) missing += refs.filter((y) => y === x).length;
  }
  return missing;
}

async function storedDocs(client: MedplumClient, pid: string): Promise<Doc[]> {
  const docs: Doc[] = [];
  const q = { subject: `Patient/${pid}`, identifier: 'urn:ga-server:id:file|', contenttype: 'application/xml' };
  for (const d of await all(client, 'DocumentReference', q)) {
    const att = (d as unknown as { content?: { attachment: { url?: string; title?: string } }[] }).content?.[0]?.attachment;
    const xml = att?.url ? await (await client.download(att.url)).text() : '';
    const hash = idsOf(d).find((i) => i.system === 'urn:ga-server:id:file')?.value;
    if (hash && isCcda(xml)) docs.push({ id: d.id as string, hash, title: att?.title ?? '', xml });
  }
  return docs;
}

// The import, with the old records hidden from every search it makes; every record it writes with a C-CDA identifier gets MARK,
// and one it creates arrives at its document's import time (at: the earliest arrival of its old records) instead of now; with none
// (old records from before GA recorded arrivals) it carries no arrival, like the records it replaces, so it never reads as new.
function hiding(client: MedplumClient, hidden: Set<string>, at: () => string | undefined, created: Record<string, number>): MedplumClient {
  const visible = <T extends Resource>(rs: T[]) => rs.filter((r) => !hidden.has(refOf(r)));
  const mark = (r: R): R => (idsOf(r).some((i) => i.system === CCDA) ? untag(retag(r, MARK), STRIPPED) : r);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const own: Record<string, unknown> = {
    searchOne: async (type: any, q: any, o: any) => visible(await client.searchResources(type, q, o))[0],
    searchResources: async (type: any, q: any, o: any) => visible(await client.searchResources(type, q, o)),
    searchResourcePages: async function* (type: any, q: any, o: any) { for await (const page of client.searchResourcePages(type, q, o)) yield visible(page); },
    createResource: async (r: R, o: any) => {
      const when = at();
      const ext = (r.extension ?? []).flatMap((e) => (e.url !== ARRIVED ? [e] : when ? [{ url: ARRIVED, valueInstant: when }] : []));
      const out = await client.createResource(mark({ ...r, ...(r.extension && { extension: ext }) }), o);
      if (idsOf(out).some((i) => i.system === CCDA)) add(created, out.resourceType);
      return out;
    },
    updateResource: (r: R, o: any) => client.updateResource(mark(r), o),
  };
  return new Proxy(client, { get: (t, p) => (typeof p === 'string' && p in own ? own[p] : ((v) => (typeof v === 'function' ? v.bind(t) : v))(Reflect.get(t, p, t))) });
}

// One backup run of the install's own backup service (scripts/backup.sh), at the install root.
export function composeBackup(cfg: GaConfig, root = join(dirname(fileURLToPath(import.meta.url)), '..')): () => Promise<void> {
  const args = storeKind(cfg) === 'sqlite' ? ['--profile', 'sqlite', 'run', '--rm', '-e', 'RUN_ONCE=1', 'ga-backup-store'] : ['run', '--rm', '-e', 'RUN_ONCE=1', 'ga-backup'];
  const cmd = `docker compose ${args.join(' ')}`;
  return () => new Promise((resolve, reject) => execFile('docker', ['compose', ...args], { cwd: root }, (e, out) => {
    if (!e && /backup ok:/.test(String(out))) resolve();
    else reject(new GaError(`refused, nothing changed: the backup did not finish (${cmd}, in ${root}). Make that command succeed, then run ga ccda replace --yes again`));
  }));
}

export async function replaceCcda(client: MedplumClient, cfg: GaConfig, o: ReplaceOptions): Promise<ReplaceReport> {
  const configFile = o.configFile ?? defaultConfigPath();
  const run = () => replace(client, cfg, o, configFile);
  return o.yes ? withImportLock(run, { dir: dirname(configFile) }) : run();
}

async function replace(client: MedplumClient, cfg: GaConfig, o: ReplaceOptions, configFile: string): Promise<ReplaceReport> {
  const pid = cfg.patientId;
  const report: ReplaceReport = { deleted: {}, stripped: {}, kept: {}, created: {}, repointed: 0, dangling: 0, documents: 0 };
  if (cfg.ccdaConverter === 'medplum') {
    o.log('nothing to replace: C-CDA documents already import with the new converter ("ccdaConverter": "medplum")');
    return report;
  }
  // 1. read and refuse
  const docs = await storedDocs(client, pid);
  const byHash = new Map(docs.map((d) => [d.hash, d]));
  const fileDoc = new Map<string, Doc | undefined>();
  const hashOf = (source: string): string | undefined => { try { return sha256(readFileSync(source)); } catch { return undefined; } }; // moved or deleted
  // A record's source document: the file at meta.source by content hash; a file no longer there by its name, unless two stored
  // documents share that name (Epic exports reuse DOC0001.XML): then none, never a guess.
  const docOf = (source?: string): Doc | undefined => {
    if (!source) return undefined;
    if (!fileDoc.has(source)) {
      const hash = hashOf(source);
      const named = docs.filter((d) => d.title === basename(source));
      fileDoc.set(source, hash ? byHash.get(hash) : named.length === 1 ? named[0] : undefined);
    }
    return fileDoc.get(source);
  };
  // Microsoft-era Compositions: the patient's, and those the Microsoft path stored with no patient whose source file is one of this
  // patient's stored documents by content (never by name: another patient's document may share it).
  const msTags = { _tag: `${TAG}|src-ccda`, '_tag:not': `${TAG}|${LOCAL_TAG}` };
  const patientless = await all(client, 'Composition', { ...msTags, 'subject:missing': 'true' });
  const unowned = patientless.filter((c) => { const h = c.meta?.source && hashOf(c.meta.source); return !!h && byHash.has(h); });
  // One whose file is gone but whose name is one of this patient's documents may be this patient's: no telling, so no flag.
  const unsure = patientless.filter((c) => c.meta?.source && !hashOf(c.meta.source) && docs.some((d) => d.title === basename(c.meta?.source as string)));
  if (unsure.length) throw new GaError(`refused, nothing changed: ${unsure.length} Microsoft-era Compositions with no patient name one of your stored documents (${[...new Set(unsure.map((c) => basename(c.meta?.source as string)))].join(', ')}) but their file is no longer there; put the file back at its old path, then run ga ccda replace again`);
  const ms = await client.search('Composition', { ...msTags, subject: `Patient/${pid}`, _count: '1' }, { cache: 'no-cache' });
  // None left: nothing to replace (a crash after the last delete only lacks the flag). Records the new path wrote without this
  // command (no MARK) must not be taken for old ones.
  if (!ms.entry?.length && !unowned.length) {
    if (o.yes) {
      report.dangling = await missingTargets(client, pid);
      if (report.dangling) throw new GaError(`stopped: ${report.dangling} references point at deleted records; the flag is not set. Restore the backup taken before ga ccda replace --yes, or repoint them`);
      setCcdaConverter(configFile);
    }
    o.log(`no Microsoft-era C-CDA records${o.yes ? `; ${configFile}: "ccdaConverter": "medplum"` : ''}`);
    return report;
  }
  report.documents = docs.length;
  const records: R[] = [...unowned];
  for (const [type, field] of Object.entries(COMPARTMENT)) records.push(...(await all(client, type, { identifier: `${CCDA}|`, [field]: `Patient/${pid}` })));
  const old = records.filter((r) => !hasTag(r, MARK));
  const merged = old.filter((r) => !isProtected(r) && otherSource(r));
  const replaced = old.filter((r) => !merged.includes(r)); // C-CDA only, or protected
  const unstored = [...replaced, ...merged.filter((r) => hasTag(r, 'src-ccda'))].filter((r) => !docOf(r.meta?.source));
  if (unstored.length) {
    const names = [...new Set(unstored.map((r) => (r.meta?.source ? basename(r.meta.source) : 'no source recorded')))].join(', ');
    throw new GaError(`refused, nothing changed: ${unstored.length} C-CDA records come from documents GA has not stored (${names}). Import each again with ga import <file> (that stores it), then run ga ccda replace again`);
  }
  const conv = docs.map((d) => {
    try { return { d, ...convertCcdaLocal(d.xml) }; } catch { throw new GaError(`refused, nothing changed: the stored C-CDA document ${d.title} does not convert`); }
  });
  const unaccounted = conv.flatMap((c) => compareCcda(c.d.xml, [], c.resources, c.notImported).unaccounted);
  if (unaccounted.length) {
    throw new GaError(`refused, nothing changed: ${unaccounted.reduce((a, u) => a + u.entries, 0)} C-CDA entries the new converter neither imports nor names (${[...new Set(unaccounted.map((u) => u.section))].join(', ')})`);
  }
  for (const r of replaced) {
    const d = docOf(r.meta?.source) as Doc;
    const a = arrivedAt(r);
    if (a && (!d.at || a < d.at)) d.at = a; // the document's import time: its records' first arrival
  }
  // The path the document was imported from (records this command wrote keep it too, for a rerun); never a bare file name.
  for (const r of records) { const d = docOf(r.meta?.source); if (d) d.file ??= r.meta?.source; }
  conv.sort((a, b) => Date.parse(ccdaDate(a.d.xml)) - Date.parse(ccdaDate(b.d.xml)));
  const sourceOf = (d: Doc): SourceInfo => ({ kind: 'ccda', file: d.file ?? `DocumentReference/${d.id}`, org: custodian(d.xml), date: ccdaDate(d.xml), writer: 'importer', local: true });

  // Each old record -> the converted record it continues (type and new C-CDA key), from its own source document.
  const pairs = new Map<R, { type: string; key: string } | undefined>();
  const made = new Map<string, string>(); // every converted record's key -> type (dry run: what would be created)
  for (const c of conv) {
    const { ordered, idOf } = batchKeys(c.resources, sourceOf(c.d), c.d.hash, pid);
    for (const r of ordered) made.set(idOf(r), r.resourceType);
    const olds = replaced.filter((r) => docOf(r.meta?.source) === c.d);
    const views = olds.map(asConverted);
    const m = matchEntries(views, ordered);
    olds.forEach((r, i) => { const n = m.get(views[i]); pairs.set(r, n && { type: n.resourceType, key: idOf(n) }); });
  }
  for (const r of merged) add(report.stripped, r.resourceType);
  // Records the Microsoft path stored with no patient (some Encounters, Devices) that old records point at: outside every
  // compartment, so no reader shows them; they may be shared with another patient's records, so they are named, never touched.
  const scanned = new Set(records.map(refOf));
  const outside = new Set<string>();
  for (const r of replaced) walkReferences(r, (x) => { if (!scanned.has(x) && COMPARTMENT[x.split('/')[0]]) outside.add(x); return undefined; });
  const left: Record<string, number> = {};
  for (const k of outside) {
    const [type, id] = k.split('/');
    const r = (await client.readResource(type as 'Observation', id).catch(() => undefined)) as R | undefined;
    if (r && idsOf(r).some((i) => i.system === CCDA) && !(r as unknown as Record<string, unknown>)[COMPARTMENT[type]]) add(left, type);
  }

  const hidden = new Set(replaced.map(refOf));
  let filled = 0;
  if (o.yes) {
    // 2. backup
    await (o.backup ?? composeBackup(cfg))();
    // 3. strip
    // A record C-CDA wrote last (src-ccda) holds a Microsoft-era body: its source date goes too, so the new path's body replaces it
    // (decide() would skip an equal date; the src-ccda tag tells the engine the visit is not the other source's to keep).
    // A visit merges field by field (mergeCopies), where a stale value would survive: one C-CDA wrote last keeps only its
    // bookkeeping and placeholders (which never win), and takes every value from the new path's copies of it.
    for (const r of merged) {
      const ext = hasTag(r, 'src-ccda') ? (r.extension ?? []).filter((e) => e.url !== SRC_DATE) : r.extension;
      const v = r as R & { subject?: unknown };
      const body = r.resourceType === 'Encounter' && hasTag(r, 'src-ccda')
        ? ({ resourceType: 'Encounter', id: r.id, meta: r.meta, subject: v.subject, status: 'unknown', class: { extension: [{ url: DATA_ABSENT, valueCode: 'unknown' }] } } as R) : r;
      await client.updateResource(retag({ ...withIds(body, idsOf(r).filter((i) => i.system !== CCDA)), ...(ext && { extension: ext }) }, STRIPPED));
      await o.after?.('stripped');
    }
    await o.after?.('strip');
    // 4. write
    let current: Doc | undefined;
    const view = hiding(client, hidden, () => current?.at, report.created);
    let invalid = 0;
    for (const c of conv) {
      current = c.d;
      invalid += (await importResources(view, c.resources, sourceOf(c.d), pid, c.d.hash)).invalid;
      await o.after?.('document');
    }
    if (invalid) throw new GaError(`stopped, no old record deleted: ${invalid} new-path records were refused as invalid. Fix that, then run ga ccda replace --yes again, on this same store (not after ga migrate-store)`);
    // A stripped record the new path did not link again may now have a separate copy beside it: never duplicates, so stop.
    const unlinked: Record<string, number> = {};
    for (const [type, field] of Object.entries(COMPARTMENT)) for (const r of await all(client, type, { _tag: `${TAG}|${STRIPPED}`, [field]: `Patient/${pid}` })) add(unlinked, type);
    if (sum(unlinked)) throw new GaError(`stopped, no old record deleted, flag not set: ${sum(unlinked)} records another source also holds were not linked again by the new converter (${byType(unlinked)}), so a copy may sit beside each: restore the backup made before the first ga ccda replace --yes (a rerun backs up again, after the strip), and report this`);
    await o.after?.('write');
  } else {
    // New: a converted record no old one continues and no stored record already holds (a link to another source's record by
    // Epic id still counts as new here).
    const continued = new Set([...pairs.values()].map((p) => p?.key));
    for (const [key, type] of made) {
      if (continued.has(key)) continue;
      const field = COMPARTMENT[type];
      const held = await all(client, type, { identifier: `${CCDA}|${key}`, ...(field && { [field]: `Patient/${pid}` }) });
      if (!held.some((x) => !hidden.has(refOf(x)))) add(report.created, type);
    }
  }

  // 5. match: the stored counterpart (a dry run's is a placeholder of the right type)
  const counterpart = new Map<R, R>();
  for (const [r, p] of pairs) {
    if (!p) continue;
    const field = COMPARTMENT[p.type];
    const n = !o.yes ? ({ resourceType: p.type, id: `new:${p.key}` } as R)
      : (await all(client, p.type, { identifier: `${CCDA}|${p.key}`, ...(field && { [field]: `Patient/${pid}` }) })).find((x) => !hidden.has(refOf(x)));
    if (n) counterpart.set(r, n);
  }
  if (o.yes) {
    // A new record takes the earliest arrival of the old ones it continues (another source's record keeps its own).
    const first = new Map<string, { n: R; at: string }>();
    for (const [r, n] of counterpart) {
      const a = arrivedAt(r);
      const f = first.get(refOf(n));
      if (a && !otherSource(n) && (!f || a < f.at)) first.set(refOf(n), { n, at: a });
    }
    for (const { n, at } of first.values()) {
      if (arrivedAt(n) === at) continue;
      await client.updateResource({ ...n, extension: [...(n.extension ?? []).filter((e) => e.url !== ARRIVED), { url: ARRIVED, valueInstant: at }] } as Resource);
    }
    await o.after?.('arrival');
  }

  // 6. protected: keep, with the new C-CDA identifier when the counterpart is a C-CDA-only copy (that copy then goes)
  const next = new Map<string, string>(); // a record that goes -> the record that continues it
  const doomed = new Set<string>();
  for (const r of replaced.filter(isProtected)) {
    add(report.kept, r.resourceType);
    const n = counterpart.get(r);
    const copy = !!n && !otherSource(n);
    if (o.yes && n) { // none: it keeps its C-CDA identifier
      const ids = [...idsOf(r).filter((i) => i.system !== CCDA), ...(copy ? idsOf(n).filter((i) => i.system === CCDA) : [])];
      if (JSON.stringify(ids) !== JSON.stringify(idsOf(r))) await client.updateResource(withIds(r, ids));
    }
    if (copy) {
      next.set(refOf(n), refOf(r));
      doomed.add(refOf(n));
    }
  }
  if (o.yes) await o.after?.('protected');
  for (const r of replaced.filter((x) => !isProtected(x))) {
    const n = counterpart.get(r);
    if (!n) continue;
    next.set(refOf(r), next.get(refOf(n)) ?? refOf(n));
    doomed.add(refOf(r));
  }
  // An old record continued by another source's record (the new path linked to it): any top-level field only the old record
  // held is added to that record before the old one goes (never less); references in it are repointed below.
  if (o.yes) {
    for (const [r, n] of counterpart) {
      if (isProtected(r) || !otherSource(n)) continue;
      const cur = (await client.readResource(n.resourceType as 'Observation', n.id as string)) as R;
      const have = new Set(Object.keys(cur).map(choiceBase));
      const only = Object.entries(asConverted(r)).filter(([k]) => !['resourceType', 'id', 'meta', 'identifier', 'extension', 'text'].includes(k) && !have.has(choiceBase(k)));
      if (!only.length) continue;
      await client.updateResource({ ...cur, ...Object.fromEntries(only) } as Resource);
      filled++;
    }
  }

  // 7. repoint: every record that stays and points at one that goes (old records from memory: the import never saw them)
  const repointAll = async (keys: Set<string>) => {
    for (const k of keys) {
      report.repointed++;
      if (!o.yes) continue;
      const [type, id] = k.split('/');
      const r = (await client.readResource(type as 'Observation', id)) as R;
      walkReferences(r, (ref) => next.get(ref));
      // A possible-duplicate pointer that now repeats another (the import re-flagged the pair) is kept once; one that now points at
      // the record itself (the new path merged the old record into the very record it was flagged against) goes, and with the
      // last one the possible-duplicate tag.
      const seen = new Set<string>([k]);
      r.extension = r.extension?.filter((e) => e.url !== DUP_OF || !seen.has(e.valueReference?.reference ?? '') && !!seen.add(e.valueReference?.reference ?? ''));
      await client.updateResource(r.extension?.some((e) => e.url === DUP_OF) ? r : untag(r, 'possible-duplicate'));
    }
  };
  // Records outside the old set (scanned) and old ones that stay (from memory) pointing at any of `refs`.
  const pointing = async (refs: Set<string>): Promise<Set<string>> => {
    const out = new Set<string>();
    await scan(client, pid, (r) => { if (!hidden.has(refOf(r)) && !doomed.has(refOf(r)) && pointsAt(r, refs).length) out.add(refOf(r)); });
    for (const r of replaced) if (!doomed.has(refOf(r)) && pointsAt(r, refs).length) out.add(refOf(r));
    return out;
  };
  await repointAll(await pointing(doomed));
  if (o.yes) await o.after?.('repoint');

  // 8-9. delete, then check nothing points at what went: everything else first, the Compositions last, so a run that stops
  // before the end still finds a Microsoft-era Composition and runs again in full. Each batch is checked before (a reminder or
  // follow-up written meanwhile: they do not take the import lock) and after its deletes; what still points is repointed, and
  // only what cannot be stops the run. Then the flag.
  for (const r of replaced) if (!doomed.has(refOf(r)) && !isProtected(r)) add(report.kept, r.resourceType);
  const isComp = (k: string) => k.startsWith('Composition/');
  for (const gone of [[...doomed].filter((k) => !isComp(k)), [...doomed].filter(isComp)]) {
    const batch = new Set(gone);
    if (o.yes) await repointAll(await pointing(batch));
    for (const k of gone) {
      const [type, id] = k.split('/');
      if (hidden.has(k)) add(report.deleted, type);
      if (!o.yes) continue;
      await client.deleteResource(type as 'Observation', id);
      await o.after?.('deleted');
    }
    if (!o.yes) continue;
    await repointAll(await pointing(batch));
    report.dangling = 0;
    await scan(client, pid, (r) => { report.dangling += pointsAt(r, batch).length; });
    if (report.dangling) throw new GaError(`stopped: ${report.dangling} references still point at deleted records; the flag is not set. Run ga ccda replace --yes again, on this same store (not after ga migrate-store)`);
  }
  if (o.yes) setCcdaConverter(configFile);
  o.log(`${o.yes ? 'replaced' : 'dry run, nothing changed'}: ${report.documents} documents; deleted ${sum(report.deleted)} (${byType(report.deleted)}); stripped ${sum(report.stripped)} (${byType(report.stripped)}); kept ${sum(report.kept)} (${byType(report.kept)}); ${o.yes ? 'created' : 'new'} ${sum(report.created)} (${byType(report.created)}); repointed ${report.repointed}${sum(left) ? `; left alone (no patient, outside every check): ${byType(left)}` : ''}${filled ? `; ${filled} old records continued by another source's record (their fields it lacked were added to it)` : ''}${o.yes ? `; dangling ${report.dangling}; ${configFile}: "ccdaConverter": "medplum"` : '. Run ga ccda replace --yes to replace (it backs up first)'}`);
  return report;
}
