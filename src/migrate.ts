// ga migrate: one-off move of an install created before GA had its own Medplum project (its client and record lived in
// Medplum's Super Admin project, whose logins are super admins). Re-imports from the original sources into the new
// project, verifies, then switches config. ga migrate --delete-old removes the old copy. Prints counts and file names only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { AuditEvent, Binary, Bundle, BundleEntry, DocumentReference, Extension, Resource, ResourceType } from '@medplum/fhirtypes';
import { importAppleHealth } from './apple/import.ts';
import { manifestHash } from './archive.ts';
import { importPath } from './ccda.ts';
import { defaultConfigPath, GaError, type GaConfig, getClient, loadConfig } from './config.ts';
import { importEhi } from './ehi/import.ts';
import { exportInfo } from './ehi/read.ts';
import { SRC_DATE, TAG } from './identity.ts';
import { importExtracted } from './mcp.ts';
import { walkReferences } from './patient.ts';
import { setup } from './setup.ts';
import { PATIENT_COMPARTMENT } from './share/scope.ts';
import { listShares, type Share, shareDir } from './share/store.ts';
import { writeAtomic } from './smart/store.ts';
import { vaccineGaps } from './vaccines.ts';

const SHARED = ['Medication', 'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Device'] as ResourceType[];
const COMPARTMENT = PATIENT_COMPARTMENT.filter((t) => t !== 'Patient');
const SRC_TAGS = ['src-ccda', 'src-ehi', 'src-apple-health', 'src-pdf', 'src-smart'].map((c) => `${TAG}|${c}`).join(',');
const TAG_ROWS = ['possible-duplicate', 'source-conflict', 'extracted-by-llm', 'writer-agent', 'src-ccda', 'src-ehi', 'src-apple-health', 'src-pdf'];
const GA_LOG = 'urn:ga-server:share|,urn:ga-server:remote|'; // share and chat-app access logs (AuditEvent)
const FILE = 'urn:ga-server:id:file';
const ARCHIVE = { ehi: 'urn:ga-server:id:ehi-archive', apple: 'urn:ga-server:id:apple-health-archive' };
const EXTRACT_TYPES = ['Observation', 'Condition', 'MedicationStatement', 'MedicationRequest', 'DiagnosticReport', 'Procedure', 'Encounter', 'AllergyIntolerance', 'Immunization'] as ResourceType[];
const EXTRACTED_NOTE = /^Extracted from DocumentReference\/(\S+)$/;

const paths = () => {
  const cfg = defaultConfigPath();
  return { cfg, next: join(dirname(cfg), 'config.next.json'), backup: join(dirname(cfg), 'config.super-admin.json') };
};

// _sort=_lastUpdated pages by cursor: Medplum caps _offset at 10000.
async function all(c: MedplumClient, type: ResourceType, q: Record<string, string>): Promise<Resource[]> {
  const out: Resource[] = [];
  for await (const page of c.searchResourcePages(type, { ...q, _sort: '_lastUpdated', _count: '1000' }, { cache: 'no-cache' })) out.push(...page);
  return out;
}
const count = async (c: MedplumClient, type: ResourceType, q: Record<string, string>) =>
  (await c.search(type, { ...q, _summary: 'count' }, { cache: 'no-cache' })).total ?? 0;
const projectOf = async (c: MedplumClient) => ((await c.get('auth/me', { cache: 'no-cache' })) as { project: { id: string } }).project.id;
const srcDate = (r: Resource) => (r as { extension?: Extension[] }).extension?.find((e) => e.url === SRC_DATE)?.valueDateTime;

// ---- pure parts (unit-tested) ----

// shortcut: a reference from an extracted record to a record outside its document keeps the old id; none exist today
// (ga_import batches are per document), revisit if extraction ever links to existing records.
// What importExtracted adds on top of the agent's output: the patient, the link to the stored file. id is kept so the
// engine maps references between records of one document; untrusted() in importExtracted drops meta and GA identifiers.
export function stripExtracted(r: Resource): Resource {
  const { meta: _m, subject: _s, patient: _p, ...out } = structuredClone(r) as Resource & Record<string, unknown>;
  const keep = <T>(k: string, f: (x: T) => boolean) => {
    const v = (out[k] as T[] | undefined)?.filter(f);
    if (v?.length) out[k] = v;
    else delete out[k];
  };
  keep<{ reference?: string }>('derivedFrom', (x) => !x.reference?.startsWith('DocumentReference/'));
  keep<{ text?: string }>('note', (x) => !EXTRACTED_NOTE.test(x.text ?? ''));
  return out as Resource;
}

// The source document of an extracted record: Observation.derivedFrom, the "Extracted from" note, else (Encounter,
// DiagnosticReport have neither) the one file document named like meta.source.
export function sourceDoc(r: Resource, docsByTitle: Map<string, string[]>): string | undefined {
  const ref = (r as { derivedFrom?: { reference?: string }[] }).derivedFrom?.find((x) => x.reference?.startsWith('DocumentReference/'))?.reference;
  if (ref) return ref.split('/')[1];
  for (const n of (r as { note?: { text?: string }[] }).note ?? []) {
    const m = EXTRACTED_NOTE.exec(n.text ?? '');
    if (m) return m[1];
  }
  const ids = r.meta?.source ? docsByTitle.get(basename(r.meta.source)) : undefined;
  return ids?.length === 1 ? ids[0] : undefined;
}

export type Row = { type: string; old: number; new: number };
// exact: migrate (new must equal old); otherwise delete-old (new may have grown since, old may be partly deleted).
export const mismatches = (rows: Row[], exact: boolean) => rows.filter((r) => (exact ? r.new !== r.old : r.new < r.old));

export const rewriteShares = (shares: Share[], from: string, to: string): Share[] =>
  shares.map((s) => (s.patientId === from ? { ...s, patientId: to } : s));

// vaccine_gaps output with server ids blanked and arrays in a fixed order, so old and new compare equal.
export const normalise = (v: unknown): string => {
  const canon = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(canon).map((y) => JSON.stringify(y)).sort().map((y) => JSON.parse(y))
      : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, canon(y)])) : x;
  return JSON.stringify(canon(JSON.parse(JSON.stringify(v ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID'))));
};

// An access log event's identity (R4 AuditEvent has no identifier): when, which log, about what.
export const auditKey = (e: AuditEvent) => JSON.stringify([Date.parse(e.recorded), e.meta?.tag?.map((t) => `${t.system}|${t.code}`).sort(), e.entity]);

// Transaction bundles of about 200 entries; an entry group (a record and its Binaries) never spans two.
async function inChunks(c: MedplumClient, groups: BundleEntry[][], done?: (n: number) => void): Promise<void> {
  let chunk: BundleEntry[] = [];
  const flush = async () => {
    if (chunk.length) await c.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: chunk } as Bundle);
    done?.(chunk.length);
    chunk = [];
  };
  for (const g of groups) {
    if (chunk.length + g.length > 200) await flush();
    chunk.push(...g);
  }
  await flush();
}

export const binaryIds = (rs: Resource[]): string[] =>
  [...new Set([...JSON.stringify(rs).matchAll(/(?:Binary\/|\/storage\/)([0-9a-f]{8}-[0-9a-f-]{27})/g)].map((m) => m[1]))];

// ---- old project reads ----

type Job = { at: string; label: string; run: () => Promise<unknown> };

// Distinct meta.source per GA source tag, over every type, scoped to the old project. Also the first source date seen.
async function sourcePaths(old: MedplumClient, project: string): Promise<Map<string, { tag: string; date?: string }>> {
  const found = new Map<string, { tag: string; date?: string }>();
  for (const tag of ['src-ccda', 'src-ehi', 'src-apple-health', 'src-smart']) {
    for (const type of [...COMPARTMENT, ...SHARED]) {
      for (;;) {
        const seen = [...found].filter(([, v]) => v.tag === tag).map(([k]) => k.replace(/[\\,$|]/g, '\\$&'));
        const q: Record<string, string> = { _project: project, _tag: `${TAG}|${tag}`, _count: '1', _elements: 'meta,extension' };
        if (seen.length) q['_source:not'] = seen.join(',');
        const r = (await old.search(type, q, { cache: 'no-cache' })).entry?.[0]?.resource;
        if (!r) break;
        const src = r.meta?.source;
        if (!src || found.has(src)) throw new GaError(`cannot list the sources of ${type} records`);
        found.set(src, { tag, date: srcDate(r) });
      }
    }
  }
  return found;
}

async function plan(old: MedplumClient, project: string, oldPid: string, newClient: () => Promise<[MedplumClient, GaConfig]>, tmp: string): Promise<Job[]> {
  const files = (await all(old, 'DocumentReference', { identifier: `${FILE}|`, subject: `Patient/${oldPid}`, _project: project })) as DocumentReference[];
  const byId = (system: string, value: string) => files.find((d) => d.identifier?.some((i) => i.system === system && i.value === value));
  const sources = await sourcePaths(old, project);
  if ([...sources.values()].some((s) => s.tag === 'src-smart')) throw new GaError('hospital portal (SMART) records are not migrated: disconnect the portals (ga disconnect) first, or migrate by hand');
  const problems: string[] = [];
  const jobs: Job[] = [];
  const ccdaDocs = new Set<DocumentReference>();
  for (const [path, { tag, date }] of sources) {
    if (!existsSync(path)) {
      // A C-CDA file may have been imported from two places; the count check below catches one really missing.
      if (tag === 'src-ccda') console.log(`not on disk, covered if the C-CDA count matches: ${basename(path)}`);
      else problems.push(`missing: ${path}`);
      continue;
    }
    const kind = tag === 'src-ccda' ? 'ccda' : tag === 'src-ehi' ? 'ehi' : 'apple';
    const doc = kind === 'ccda' ? byId(FILE, createHash('sha256').update(readFileSync(path)).digest('hex')) : byId(ARCHIVE[kind], await manifestHash(path));
    if (!doc) {
      problems.push(`changed since it was imported: ${path}`);
      continue;
    }
    if (kind === 'ccda') ccdaDocs.add(doc);
    // R17: the zone is not stored, but the source date carries its offset.
    if (kind === 'ehi' && exportInfo(path).date !== date) {
      problems.push(`imported in another time zone (source date ${date}): set GA_EHI_TZ to that zone and re-run: ${path}`);
      continue;
    }
    jobs.push({
      at: doc.meta?.lastUpdated as string,
      label: `${kind} ${basename(path)}`,
      run: async () => {
        const [c, cfg] = await newClient();
        return kind === 'ccda' ? importPath(c, cfg, path) : kind === 'ehi' ? importEhi(c, cfg, path) : importAppleHealth(c, cfg, path);
      },
    });
  }
  const xml = files.filter((d) => d.content?.[0]?.attachment?.contentType === 'application/xml').length;
  if (xml !== ccdaDocs.size) problems.push(`${xml} C-CDA files were imported but only ${ccdaDocs.size} were found on disk`);

  // LLM-extracted records: re-imported from the stored original file, values as extracted, never through an LLM.
  const docsByTitle = new Map<string, string[]>();
  for (const d of files) {
    const t = d.content?.[0]?.attachment?.title;
    if (t) docsByTitle.set(t, [...(docsByTitle.get(t) ?? []), d.id as string]);
  }
  const groups = new Map<string, Resource[]>();
  const orphans = new Map<string, number>();
  for (const type of EXTRACT_TYPES) {
    for (const r of await all(old, type, { _tag: `${TAG}|extracted-by-llm`, _compartment: `Patient/${oldPid}`, _project: project })) {
      const id = sourceDoc(r, docsByTitle);
      const name = basename(r.meta?.source ?? '(no file name)');
      if (!id) orphans.set(name, (orphans.get(name) ?? 0) + 1);
      else groups.set(id, [...(groups.get(id) ?? []), r]);
    }
  }
  // E.g. two uploads with one file name. Not migrated automatically: the user re-imports the file afterwards.
  for (const [name, n] of orphans) problems.push(`${n} records extracted from ${name} cannot be matched to one stored file: delete them in the old copy (admin app) and re-import ${name} after migrating, then re-run`);
  for (const [id, rs] of groups) {
    const doc = files.find((d) => d.id === id);
    const att = doc?.content?.[0]?.attachment;
    if (!doc || !att?.url || !att.title) {
      const name = basename(rs[0].meta?.source ?? '(no file name)');
      problems.push(`the stored file behind ${rs.length} records extracted from ${name} is missing: delete them in the old copy (admin app) and re-import ${name} after migrating, then re-run`);
      continue;
    }
    const name = basename(att.title);
    const own = rs.find((r) => r.meta?.source && basename(r.meta.source) === name) ?? rs[0];
    jobs.push({
      at: doc.meta?.lastUpdated as string,
      label: `pdf ${name}`,
      run: async () => {
        const dir = mkdtempSync(join(tmp, 'pdf-'));
        const file = join(dir, name);
        writeFileSync(file, Buffer.from(await (await old.download(att.url as string)).arrayBuffer()), { mode: 0o600 });
        const [c, cfg] = await newClient();
        try {
          return await importExtracted(c, cfg, rs.map(stripExtracted), file, srcDate(own));
        } catch (e) {
          const docId = e instanceof GaError && e.message.startsWith('already imported') ? /DocumentReference\/([^\s)]+)/.exec(e.message)?.[1] : undefined;
          if (!docId) throw e;
          // Done on an earlier run only if its records made it too; a failed run left the file alone (importExtracted's hint).
          const mine = new Map([[name, [docId]]]);
          for (const type of EXTRACT_TYPES) {
            const rs = await all(c, type, { _tag: `${TAG}|extracted-by-llm`, _compartment: `Patient/${cfg.patientId}` });
            if (rs.some((r) => sourceDoc(r, mine) === docId)) return 'already imported';
          }
          throw new GaError(`${name}: stored in the GA project by an earlier run, but none of its records (${(e as Error).message})`);
        }
      },
    });
  }
  if (problems.length) throw new GaError(`cannot migrate:\n${problems.join('\n')}`);
  return jobs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

async function countRows(old: MedplumClient, project: string, oldPid: string, nc: MedplumClient, newPid: string): Promise<Row[]> {
  const rows: Row[] = [];
  const add = async (type: string, rt: ResourceType, oq: Record<string, string>, nq: Record<string, string>) => {
    const r = { type, old: await count(old, rt, { ...oq, _project: project }), new: await count(nc, rt, nq) };
    if (r.old || r.new) rows.push(r);
  };
  for (const t of COMPARTMENT) await add(t, t, { _compartment: `Patient/${oldPid}` }, { _compartment: `Patient/${newPid}` });
  for (const t of SHARED) await add(t, t, { _tag: SRC_TAGS }, { _tag: SRC_TAGS });
  await add('AuditEvent (GA logs)', 'AuditEvent', { _tag: GA_LOG }, { _tag: GA_LOG });
  // Per GA tag (review flags, provenance), over the types that hold records.
  for (const tag of TAG_ROWS) {
    for (const t of rows.map((r) => r.type).filter((t): t is ResourceType => !t.includes(' '))) {
      await add(`${t} ${tag}`, t, { _tag: `${TAG}|${tag}` }, { _tag: `${TAG}|${tag}` });
    }
  }
  return rows;
}

const table = (rows: Row[]) => rows.map((r) => `${r.type.padEnd(40)} ${String(r.old).padStart(8)} ${String(r.new).padStart(8)}${r.old === r.new ? '' : '  <>'}`).join('\n');

// An error (e.g. no birthDate) fails verification rather than comparing equal.
const vaccines = async (c: MedplumClient, pid: string, asOf: string) => {
  try {
    return normalise(await vaccineGaps(c, pid, asOf));
  } catch (e) {
    console.log(`vaccine_gaps failed: ${(e as Error).message}`);
    return undefined;
  }
};

export async function migrate({ projectName }: { projectName?: string } = {}): Promise<{ rows: Row[] }> {
  const p = paths();
  if (existsSync(p.backup)) throw new GaError(`already migrated (${basename(p.backup)} exists): next step is ga migrate --delete-old`);
  const oldCfg = loadConfig(p.cfg);
  if (oldCfg.projectId) throw new GaError('GA already runs in its own Medplum project: nothing to migrate');
  const old = await getClient(oldCfg);
  const project = await projectOf(old);
  const tmpRoot = join(dirname(p.cfg), 'tmp');
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(tmpRoot, 'migrate-'));
  try {
    let fresh: [MedplumClient, GaConfig] | undefined;
    // A fresh login per job: an Apple Health import can outlast the access token.
    const newClient = async (): Promise<[MedplumClient, GaConfig]> => {
      const cfg = fresh?.[1] ?? loadConfig(p.next);
      fresh = [await getClient(cfg), cfg];
      return fresh;
    };
    console.log('stop ga-gateway and ga-sync before migrating (docker compose stop ga-gateway ga-sync): their writes would go to the old copy.\nchecking the original sources...');
    const jobs = await plan(old, project, oldCfg.patientId, newClient, tmp);
    const newCfg = await setup(oldCfg.baseUrl, oldCfg.converterUrl, { out: p.next, projectName });
    if (newCfg.projectId === project || newCfg.patientId === oldCfg.patientId) throw new GaError('the new project is the old one: refusing');
    for (const [n, job] of jobs.entries()) {
      console.log(`[${n + 1}/${jobs.length}] ${job.label}`);
      const r = (await job.run()) as Record<string, unknown> | string;
      console.log(`  ${typeof r === 'string' ? r : ['created', 'updated', 'skipped', 'merged', 'invalid'].map((k) => `${k} ${r[k] ?? 0}`).join(', ')}`);
    }
    const [nc] = await newClient();

    // Access logs, patient references rewritten; only those not copied yet, so a re-run picks up late events.
    const have = new Set(((await all(nc, 'AuditEvent', { _tag: GA_LOG })) as AuditEvent[]).map(auditKey));
    const copies = ((await all(old, 'AuditEvent', { _tag: GA_LOG, _project: project })) as AuditEvent[])
      .map(({ id: _id, meta, ...e }) => {
        walkReferences(e, (ref) => (ref === `Patient/${oldCfg.patientId}` ? `Patient/${newCfg.patientId}` : undefined));
        return { ...e, meta: { tag: meta?.tag } } as AuditEvent;
      })
      .filter((e) => !have.has(auditKey(e)));
    await inChunks(nc, copies.map((resource) => [{ request: { method: 'POST' as const, url: 'AuditEvent' }, resource }]));
    console.log(`access log events copied: ${copies.length}`);

    console.log('verifying...');
    const rows = await countRows(old, project, oldCfg.patientId, nc, newCfg.patientId);
    console.log(`${'type'.padEnd(40)} ${'old'.padStart(8)} ${'new'.padStart(8)}\n${table(rows)}`);
    const asOf = new Date().toLocaleDateString('en-CA');
    const vOld = await vaccines(old, oldCfg.patientId, asOf);
    const sameVaccines = vOld !== undefined && vOld === (await vaccines(nc, newCfg.patientId, asOf));
    console.log(`vaccine_gaps: ${sameVaccines ? 'same' : 'DIFFERENT'}`);
    if (mismatches(rows, true).length || !sameVaccines) throw new GaError(`verification failed: config not switched (the new copy is in ${basename(p.next)}'s project)`);

    // Switch: shares follow the new patient (tokens unchanged, links keep working), then the config.
    const sd = shareDir(p.cfg);
    const shares = listShares(sd);
    const moved = rewriteShares(shares, oldCfg.patientId, newCfg.patientId);
    if (JSON.stringify(moved) !== JSON.stringify(shares)) writeAtomic(join(sd, 'shares.json'), JSON.stringify(moved, null, 2), 0o600);
    writeAtomic(p.backup, readFileSync(p.cfg), 0o600);
    renameSync(p.next, p.cfg);
    console.log(`switched: ${basename(p.cfg)} now uses the GA project; the old one is in ${basename(p.backup)}.\nStart ga-gateway and ga-sync again (docker compose start ga-gateway ga-sync), check GA, then: ga migrate --delete-old`);
    return { rows };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Deletes the old copy with the old (Super Admin) client. Every query is scoped to the old project and every record is
// checked against it: that client can see every project, including the new one.
export async function deleteOld(): Promise<Record<string, number>> {
  const p = paths();
  const cfg = loadConfig(p.cfg);
  if (!existsSync(p.backup)) throw new GaError(`${basename(p.backup)} not found: run ga migrate first`);
  if (!cfg.projectId) throw new GaError(`${basename(p.cfg)} does not point at the GA project: run ga migrate first`);
  const oldCfg = loadConfig(p.backup);
  if (oldCfg.patientId === cfg.patientId || oldCfg.clientId === cfg.clientId) throw new GaError('the old and new configs are the same: refusing');
  const nc = await getClient(cfg);
  const old = await getClient(oldCfg);
  const project = await projectOf(old);
  if (project === cfg.projectId || (await projectOf(nc)) !== cfg.projectId) throw new GaError('the old project is the GA project: refusing');
  const rows = await countRows(old, project, oldCfg.patientId, nc, cfg.patientId);
  const short = mismatches(rows, false);
  if (short.length) throw new GaError(`the GA project holds fewer records than the old copy (${short.map((r) => r.type).join(', ')}): refusing`);

  console.log('listing the old copy...');
  const doomed = new Map<string, Resource>();
  const add = (rs: Resource[]) => rs.forEach((r) => doomed.set(`${r.resourceType}/${r.id}`, r));
  for (const t of COMPARTMENT) add(await all(old, t, { _compartment: `Patient/${oldCfg.patientId}`, _project: project }));
  for (const t of SHARED) add(await all(old, t, { _tag: SRC_TAGS, _project: project }));
  add(await all(old, 'Endpoint', { identifier: 'urn:ga-server:id:smart-source|', _project: project }));
  add(await all(old, 'AuditEvent', { _tag: GA_LOG, _project: project }));
  const patient = await old.searchOne('Patient', { _id: oldCfg.patientId, _project: project }, { cache: 'no-cache' });
  if ([...doomed.values(), ...(patient ? [patient] : [])].some((r) => r.meta?.project !== project)) throw new GaError('a record outside the old project was selected: refusing');
  // Each record goes with its Binaries in one transaction: an interrupted run strands none (they are found only through records).
  const seen = new Set<string>(); // already placed, or already gone (an earlier interrupted run)
  for (const id of binaryIds([...doomed.values()])) {
    const b = await old.readResource('Binary', id, { cache: 'no-cache' }).catch(() => undefined);
    if (!b) seen.add(id);
    else if ((b as Binary).meta?.project !== project) throw new GaError('a file outside the old project was selected: refusing');
  }
  const groups: string[][] = [];
  for (const [url, r] of doomed) {
    const bins = binaryIds([r]).filter((id) => !seen.has(id)).map((id) => (seen.add(id), `Binary/${id}`));
    groups.push([...bins, url]);
  }
  if (patient) groups.push([`Patient/${patient.id}`]);

  const counts: Record<string, number> = {};
  for (const u of groups.flat()) counts[u.split('/')[0]] = (counts[u.split('/')[0]] ?? 0) + 1;
  const total = groups.flat().length;
  let n = 0;
  await inChunks(old, groups.map((g) => g.map((url) => ({ request: { method: 'DELETE', url } }))), (k) => console.log(`deleted ${(n += k)}/${total}`));
  await old.deleteResource('ClientApplication', oldCfg.clientId);
  counts.ClientApplication = 1;
  console.log(Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('\n'));
  console.log(`done. ${basename(p.backup)} no longer works and can be deleted.`);
  return counts;
}
