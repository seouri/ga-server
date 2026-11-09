import { getStatus, type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Extension, Identifier, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { addUnmapped, carryConcept, codeRecord, countUnmapped, gaCodings, learnable, onSource, sameConcept, stripConcept, type Unmapped } from './concept-apply.ts';
import { loadMaps, type MapEntry, type Maps, upsertEntries } from './conceptmap.ts';
import { GaError } from './config.ts';
import { APPLE, ARRIVED, hasTag, sorted, SRC_DATE, TAG, contentHash, contentKey, DATED, EPIC_OID, effective, LAST_SEEN, sameDay, sameNumbers, SINGULAR_ID, stableIdentifier, stamp, type SourceInfo } from './identity.ts';
import { collapsePatients, walkReferences } from './patient.ts';
import { newestEpicImport, storeNewestImport } from './share/scope.ts';

export type Decision = 'create' | 'update' | 'skip' | 'conflict';
// A C-CDA section, or part of one, the in-process converter turned into no record (src/ccda.ts convertCcdaLocal). Names and counts only.
export type NotImported = { section: string; templateId?: string; entries: number; reason: string };
export type ImportReport = {
  created: number;
  updated: number;
  skipped: number;
  merged: number;
  conflicts: number;
  possibleDuplicates: number;
  invalid: number;
  seen?: number; // kept records whose last-seen advanced (only when SourceInfo.seenAt is set)
  byType?: Record<string, TypeCounts>; // only for kind 'smart'
  unmapped: Unmapped[]; // in-scope terms of this batch with no standard code, for review (src/concept-apply.ts)
  notImported?: NotImported[]; // C-CDA only: what became no record
};
const COUNTS = ['created', 'updated', 'skipped', 'merged', 'conflicts', 'possibleDuplicates', 'invalid'] as const;
// Adds one importResources report into a running total (several files or batches of one import).
export function addReport(total: ImportReport, r: ImportReport): void {
  for (const k of COUNTS) total[k] += r[k];
  addUnmapped(total.unmapped, r.unmapped);
}
type TypeCounts = { created: number; linked: number; updated: number; flagged: number; seen: number };

type R = Resource & { identifier?: Identifier[]; extension?: Extension[] };
export const DUP_OF = 'urn:ga-server:ext:possible-duplicate-of';
const KEPT_TAGS = ['possible-duplicate', 'source-conflict'];
// Identifier systems of GA's other sources: a record carrying one is never replaced by a fill-only SMART copy.
// Apple is left out: on an Apple-only record the hospital body wins (otherOntoApple).
const OTHER_SOURCE = (system: string) => system.startsWith('urn:ga-server:id:ehi:') || ['urn:ga-server:id:ccda', 'urn:ga-server:id:pdf'].includes(system);
// Patient-compartment types and the field (= Medplum search param) naming the patient; link lookups are scoped by it.
export const COMPARTMENT: Record<string, string> = {
  ...Object.fromEntries(
    ['Observation', 'DiagnosticReport', 'Encounter', 'Condition', 'MedicationRequest', 'MedicationStatement', 'MedicationAdministration',
      'MedicationDispense', 'Procedure', 'DocumentReference', 'Communication', 'QuestionnaireResponse', 'ServiceRequest', 'CarePlan', 'Goal',
      'Composition', 'Specimen', 'ImagingStudy', 'Media', 'List', 'CareTeam', 'ClinicalImpression', 'RiskAssessment', 'Flag', 'DeviceRequest',
      'DeviceUseStatement'].map((t) => [t, 'subject']),
  ),
  ...Object.fromEntries(['Immunization', 'AllergyIntolerance', 'FamilyMemberHistory', 'Device', 'EpisodeOfCare', 'Consent'].map((t) => [t, 'patient'])),
  Coverage: 'beneficiary',
};
// Epic's note id (HNO) under an org root: the id of a clinical note, the EHI export's HNO_INFO NOTE_ID.
const EPIC_NOTE = /^urn:oid:1\.2\.840\.114350\.1\.13\.\d+\.2\.7\.2\.727879$/;
const EPIC_ORG = /^urn:oid:1\.2\.840\.114350\.1\.13\.(\d+)\./;
// Not patient data: linked globally. Any other type is not linked.
const SHARED = new Set(['Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication']);
// Medplum's validator reports 400 with structure/invariant issues carrying an element path. Generic 'invalid'
// (badRequest, e.g. bad search params), server errors and anything without a path are not per-resource validation.
const VALIDATION = ['structure', 'invariant', 'value', 'required'];
const isValidationFailure = (e: unknown): e is OperationOutcomeError => {
  if (!(e instanceof OperationOutcomeError)) return false;
  const issues = e.outcome.issue ?? [];
  return getStatus(e.outcome) === 400 && issues.length > 0 && issues.every((i) => VALIDATION.includes(i.code) && !!i.expression?.length);
};

// Sticky protection: source-conflict (a newer source differed), or person-edited (set in the Medplum era on a record a person had edited; no longer set).
const shielded = (r: Resource) => hasTag(r, 'source-conflict') || hasTag(r, 'person-edited');
const srcDate = (r: R) => r.extension?.find((e) => e.url === SRC_DATE)?.valueDateTime;
const idKey = (i: Identifier) => `${i.system}|${i.value}`;
const idList = (r: R): Identifier[] => [r.identifier ?? []].flat(); // singular on SINGULAR_ID types
const isApple = (r: R) => idList(r).some((i) => i.system === APPLE);
const hasNonApple = (r: R) => idList(r).some((i) => i.system !== APPLE);
const canon = (x: unknown) => JSON.stringify(x, sorted);

// Equality ignores id, meta, our bookkeeping extensions, identifiers and GA-added codings; identifiers only need
// incoming ⊆ existing, because existing accumulates extra identifiers from merges.
function body(r: R): unknown {
  const { id: _i, meta: _m, identifier: _id, extension, ...rest } = stripConcept(r);
  const ext = (extension ?? []).filter((e) => e.url !== SRC_DATE && e.url !== DUP_OF && e.url !== LAST_SEEN && e.url !== ARRIVED);
  return ext.length ? { ...rest, extension: ext } : rest;
}

// R11: an EHI export leaves out what it doesn't know, so its update keeps the existing top-level fields it lacks
// (its own fields win). Never kept: a field contradicting the incoming record, or the old narrative.
// C-CDA bodies are complete documents and replace as before.
const BOOKKEEPING = new Set(['id', 'meta', 'identifier', 'extension', 'text']);
// Choice-type element base (onsetDateTime -> onset), so an incoming onsetX replaces any existing onsetY.
const choiceBase = (k: string) => k.replace(/(DateTime|Date|Period|Age|Range|String|Quantity|CodeableConcept|Reference|Boolean|Integer|Instant|Time|Timing|Ratio|SampledData|Attachment|Duration)$/, '');
const code0 = (c: unknown) => (c as { coding?: { code?: string }[] } | undefined)?.coding?.[0]?.code;
type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
const coded = (x: unknown) => isObj(x) && Array.isArray(x.coding) && x.coding.some((c) => (c as { code?: string }).code);
const concept = (x: unknown) => isObj(x) && ('coding' in x || 'text' in x) && !('reference' in x);
const day = (x: unknown) => (typeof x === 'string' ? x.slice(0, 10) : undefined);
// C1/I1: incoming adds nothing more specific than existing: equal; a text-only concept (or 'unknown' code) over a coded one;
// a display-only reference over a resolved one; 'unknown' over a known code; a start-only period on the same day; or an
// object whose every field is equal or less specific (so a Quantity without system/code keeps its UCUM coding).
function weaker(ex: unknown, inc: unknown): boolean {
  if (canon(ex) === canon(inc)) return true;
  if (inc === 'unknown' && typeof ex === 'string') return true;
  if (Array.isArray(ex) && Array.isArray(inc)) {
    return ex.length === inc.length ? inc.every((x, i) => weaker(ex[i], x)) : inc.every((x) => ex.some((e) => weaker(e, x)));
  }
  if (!isObj(ex) || !isObj(inc)) return false;
  if (coded(ex) && concept(inc) && (!coded(inc) || code0(inc) === 'unknown')) return true;
  if (ex.reference && !inc.reference && 'display' in inc) return true;
  if (typeof ex.start === 'string' && !inc.end && day(ex.start) === day(inc.start) && Object.keys(inc).every((k) => k === 'start')) return true;
  return Object.keys(inc).every((k) => weaker(ex[k], inc[k]));
}
// Same-length arrays merge element-wise; a weaker value keeps the existing one (a coded concept takes the incoming text if it has none).
function merge(ex: unknown, inc: unknown): unknown {
  if (ex === undefined) return inc;
  if (Array.isArray(ex) && Array.isArray(inc) && ex.length === inc.length) return inc.map((x, i) => merge(ex[i], x));
  if (!weaker(ex, inc)) return inc;
  return isObj(ex) && isObj(inc) && coded(ex) && !ex.text && inc.text ? { ...ex, text: inc.text } : ex;
}
export function fillFrom<T extends Resource>(existing: T, incomingRes: T, s: SourceInfo): T {
  if (s.kind !== 'ehi' && s.kind !== 'smart') return incomingRes;
  return onSource(existing, incomingRes, fillSource);
}
function fillSource<T extends Resource>(existing: T, incomingRes: T): T {
  // R21: a text-only medication never replaces a coded one (a Medication reference, or a concept with codings).
  const ex = existing as unknown as Record<string, { coding?: unknown[] } | undefined>;
  const med = (incomingRes as unknown as Record<string, { coding?: unknown[] } | undefined>).medicationCodeableConcept;
  const incoming = { ...incomingRes };
  if (med && !med.coding?.length && (ex.medicationReference || ex.medicationCodeableConcept?.coding?.length)) {
    delete (incoming as unknown as Record<string, unknown>).medicationCodeableConcept;
  }
  const inc = incoming as unknown as Record<string, unknown>;
  const exr = existing as unknown as O;
  // A single time never replaces an existing period of the same choice element starting that day.
  for (const k of Object.keys(inc)) {
    const p = exr[`${choiceBase(k)}Period`] as { start?: string } | undefined;
    if (k !== `${choiceBase(k)}Period` && choiceBase(k) !== k && p?.start && day(p.start) === day(inc[k])) delete inc[k];
  }
  const incBases = new Set(Object.keys(inc).filter((k) => inc[k] !== undefined).map(choiceBase));
  const drop = (k: string): boolean => {
    if (BOOKKEEPING.has(k) || inc[k] !== undefined || incBases.has(choiceBase(k))) return true;
    if (incoming.resourceType !== 'Condition') return false;
    // An open problem has no abatement; an entered-in-error one has neither clinical status nor abatement (con-3, con-4).
    if (code0(inc.verificationStatus) === 'entered-in-error') return k === 'clinicalStatus' || k.startsWith('abatement');
    return k.startsWith('abatement') && !!inc.clinicalStatus && !['resolved', 'inactive', 'remission'].includes(code0(inc.clinicalStatus) ?? '');
  };
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !drop(k)));
  const out = { ...kept, ...incoming } as unknown as O;
  for (const k of Object.keys(inc)) if (!BOOKKEEPING.has(k)) out[k] = merge(exr[k], inc[k]);
  // A report keeps the existing results the export didn't match (existing first: stable order for re-import equality).
  const res = exr.result as { reference?: string }[] | undefined;
  if (incoming.resourceType === 'DiagnosticReport' && res && Array.isArray(inc.result)) {
    const have = new Set(res.map((r) => r.reference));
    out.result = [...res, ...(inc.result as { reference?: string }[]).filter((r) => !have.has(r.reference))];
  }
  return out as unknown as T;
}

// Records carrying any of these Epic ids (scoped to the patient for compartment types), and those of them not yet
// holding an identifier in the incoming stable system. Exactly one free candidate is a link; shared with the EHI pre-pass.
export async function linkCandidates(
  client: MedplumClient,
  type: string,
  epic: Identifier[],
  patientId: string,
  stableSystem: string,
): Promise<{ found: Resource[]; free: Resource[] }> {
  const field = COMPARTMENT[type];
  const found = new Map<string, R>();
  for (const i of epic) {
    const q = new URLSearchParams([['identifier', idKey(i)], ...(field ? [[field, `Patient/${patientId}`]] : [])]);
    for (const c of (await client.searchResources(type as Resource['resourceType'], q, { cache: 'no-cache' })) as R[]) found.set(c.id as string, c);
  }
  const free = [...found.values()].filter((c) => !idList(c).some((x) => x.system === stableSystem));
  return { found: [...found.values()], free };
}

// Who wrote a record comes from GA's writer tags (writer-importer, writer-agent): the store has no logins, so no meta.author.
export function decide(existingRes: Resource | undefined, incomingRes: Resource): Decision {
  if (!existingRes) return 'create';
  const existing = existingRes as R;
  const incoming = incomingRes as R;
  const ed = srcDate(existing);
  const id = srcDate(incoming);
  if (ed && id && Date.parse(id) <= Date.parse(ed)) return 'skip';
  const have = new Set(idList(existing).map(idKey));
  const subset = idList(incoming).every((i) => have.has(idKey(i)));
  // Unchanged content skips, except that a newer source re-confirms an importer-owned medication, problem or allergy: the currency rule
  // reads its source date, and a stale one would call an item still on the latest list "unconfirmed".
  const importerOwned = hasTag(existing, 'writer-importer') && !shielded(existing);
  // Portal-synced records are confirmed by last-seen instead (advanced separately), so only file imports need the refresh.
  const dated = DATED.has(incoming.resourceType) && !existing.extension?.some((e) => e.url === LAST_SEEN);
  if (subset && canon(body(existing)) === canon(body(incoming))) return id && importerOwned && dated ? 'update' : 'skip';
  // Only a write that would actually happen is a conflict. The protection tags stick.
  if (shielded(existing)) return 'conflict';
  return hasTag(existing, 'writer-agent') && hasTag(incoming, 'writer-importer') ? 'conflict' : 'update';
}

const sourceKeys = (r: Resource) => (r.id ? [`${r.resourceType}/${r.id}`, `urn:uuid:${r.id}`] : []);

function topoSort(rs: Resource[]): Resource[] {
  const byKey = new Map<string, Resource>();
  for (const r of rs) for (const k of sourceKeys(r)) byKey.set(k, r);
  const out: Resource[] = [];
  const state = new Map<Resource, 'visiting' | 'done'>();
  const visit = (r: Resource, path: Resource[]) => {
    if (state.get(r) === 'done') return;
    if (state.get(r) === 'visiting') {
      const cycle = path.slice(path.indexOf(r)).map((x) => `${x.resourceType}/${x.id}`);
      throw new GaError(`reference cycle: ${cycle.join(', ')}`);
    }
    state.set(r, 'visiting');
    walkReferences(r, (ref) => {
      const dep = byKey.get(ref);
      if (dep && dep !== r) visit(dep, [...path, r]);
      return undefined;
    });
    state.set(r, 'done');
    out.push(r);
  };
  for (const r of rs) visit(r, []);
  return out;
}

const withTag = (r: Resource, code: string): Resource => ({ ...r, meta: { ...r.meta, tag: [...(r.meta?.tag ?? []), { system: TAG, code }] } });

// R19: coded values compare by their first coding (system|code); a coding-less concept never matches.
const firstCoding = (o: Observation) => {
  const c = o.valueCodeableConcept?.coding?.[0];
  return c?.code ? `${c.system ?? ''}|${c.code}` : undefined;
};
// The same numbers, ignoring units (sources spell them differently: K/uL vs 10*3/uL) and including a panel's components (BP).

export function sameValue(a: Observation, b: Observation): boolean {
  if (a.valueQuantity && b.valueQuantity) return a.valueQuantity.value === b.valueQuantity.value && a.valueQuantity.unit === b.valueQuantity.unit;
  if (a.valueCodeableConcept && b.valueCodeableConcept) return !!firstCoding(a) && firstCoding(a) === firstCoding(b);
  if (a.valueBoolean !== undefined || b.valueBoolean !== undefined) return a.valueBoolean === b.valueBoolean;
  return a.valueString !== undefined && a.valueString === b.valueString;
}

// Copies of one record from the in-process converter: a visit (one Encounter per visit id), or an id-less record keyed by its
// content (references aside, so a second copy may link elsewhere: a collection procedure reporting in two panels). The stored
// record and the incoming copy merge field by field, whatever their dates: a field only one holds is kept, arrays are unioned (equal elements once), and where both hold a
// single value the newer source wins. A later document that says less never wipes what a fuller one added. Identifiers are
// unionUpdate's; meta and GA's bookkeeping extensions are picked below.
// keepExisting: the stored record is another source's (EHI, portal) that a C-CDA copy links to: its values win every leaf.
export function mergeCopies(existing: R, incoming: R, keepExisting = false): R {
  const newer = !keepExisting && (!srcDate(existing) || !srcDate(incoming) || Date.parse(srcDate(incoming) as string) > Date.parse(srcDate(existing) as string));
  const out = mergeValue(existing, incoming, newer, '') as O;
  // Extensions by url: a source's own extensions are unioned (the newer wins one url); GA's bookkeeping follows its rules: the
  // newer copy's source date and last-seen, and the stored arrival and possible-duplicate links (unionUpdate re-adds them).
  const book = new Set([SRC_DATE, LAST_SEEN, ARRIVED, DUP_OF]);
  const byUrl = new Map<string, Extension>();
  for (const e of [...(newer ? [] : incoming.extension ?? []), ...(existing.extension ?? []), ...(newer ? incoming.extension ?? [] : [])]) {
    if (!book.has(e.url)) byUrl.set(e.url, e);
  }
  const ga = ((newer ? incoming : existing).extension ?? []).filter((e) => e.url === SRC_DATE || e.url === LAST_SEEN);
  out.extension = [...byUrl.values(), ...ga];
  // meta is never merged: another source's visit keeps its own tags and meta.source (the currency rule and migrate read them).
  out.meta = (keepExisting || !newer ? existing : incoming).meta;
  return out as unknown as R;
}

// A converter placeholder (status unknown, a data-absent value) never wins over a real value.
const DATA_ABSENT = 'http://hl7.org/fhir/StructureDefinition/data-absent-reason';
const placeholderValue = (k: string, v: unknown) =>
  (k === 'status' && v === 'unknown') ||
  (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((x) => x === 'extension') &&
    ((v as O).extension as Extension[] | undefined)?.every((e) => e.url === DATA_ABSENT) === true);
// A Coding, CodeableConcept, Quantity or Reference is one value (its parts belong together); other objects (a period) merge field by field.
const codeable = (v: O) => ('coding' in v || 'text' in v) && Object.keys(v).every((x) => ['coding', 'text', 'id', 'extension'].includes(x));
const atomic = (v: O) => 'code' in v || 'system' in v || 'reference' in v || 'value' in v || codeable(v);
const DATE = /^\d{4}(-\d\d(-\d\d(T.+)?)?)?$/;
// Of two dates where one contains the other (the same day, month or year), the more precise.
const precise = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && DATE.test(a) && DATE.test(b) ? (a.startsWith(b) ? a : b.startsWith(a) ? b : undefined) : undefined;
// Field by field: a field only one copy has is kept, arrays are unioned (the stored order first, equal elements once), plain
// objects merge recursively, and where both hold a leaf the newer source wins, except that a placeholder never wins.
function mergeValue(a: unknown, b: unknown, newer: boolean, k: string): unknown {
  if (b === undefined) return a;
  if (a === undefined) return b;
  if (placeholderValue(k, b) && !placeholderValue(k, a)) return a;
  if (placeholderValue(k, a) && !placeholderValue(k, b)) return b;
  const p = precise(a, b);
  if (p) return p;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (k === 'identifier') return b; // unionUpdate unions the stored and incoming identifiers
    if (k === 'extension') return a; // mergeCopies' own
    const seen = new Set(a.map((e) => JSON.stringify(e, sorted)));
    return [...a, ...b.filter((e) => !seen.has(JSON.stringify(e, sorted)))];
  }
  const plain = (v: unknown): v is O => !!v && typeof v === 'object' && !Array.isArray(v);
  if (plain(a) && plain(b) && (k === '' || (!atomic(a) && !atomic(b)))) {
    const out: O = { ...a };
    for (const [key, v] of Object.entries(b)) out[key] = mergeValue(a[key], v, newer, key);
    return out;
  }
  return newer ? b : a;
}

// Incoming body wins; keeps identifiers from merges, review tags and possible-duplicate pointers.
async function unionUpdate(client: MedplumClient, existing: R, coded: R): Promise<Resource> {
  const incoming = carryConcept(existing, coded);
  const ids = idList(existing);
  for (const i of idList(incoming)) if (!ids.some((x) => idKey(x) === idKey(i))) ids.push(i);
  const kept = (existing.meta?.tag ?? []).filter((t) => t.system === TAG && KEPT_TAGS.includes(t.code as string) && !hasTag(incoming, t.code as string));
  const dupOf = (existing.extension ?? []).filter((e) => e.url === DUP_OF || e.url === ARRIVED);
  return client.updateResource({
    ...incoming,
    id: existing.id,
    identifier: SINGULAR_ID.has(incoming.resourceType) ? incoming.identifier : ids,
    meta: { ...incoming.meta, tag: [...(incoming.meta?.tag ?? []), ...kept] },
    extension: [...(incoming.extension ?? []), ...dupOf],
  } as Resource);
}

// One batch as importResources keys it: Patients collapsed, records in reference order, each record's stable identifier value
// (keyOf) and the values held by two different records (colliding: each gets its content hash).
function batchKeys(resources: Resource[], source: SourceInfo, fileHash: string, patientId: string) {
  const { resources: collapsed, patientIdentifiers } = collapsePatients(resources, patientId);
  const ordered = topoSort(collapsed);
  // Same stable identifier twice in one batch with different content would make the second a silent skip:
  // give every member of such a group source id + content hash (deterministic, order-independent).
  // A reference in the batch reads as its target's key (C-CDA links: identity.ts), computed from the batch as the source sent it.
  const bySource = new Map(ordered.flatMap((r) => sourceKeys(r).map((k) => [k, r] as const)));
  const keys = new Map<Resource, string>();
  const resolve = (ref: string): string | undefined => {
    const t = bySource.get(ref);
    return t && keyOf(t);
  };
  const keyOf = (r: Resource): string => {
    if (!keys.has(r)) keys.set(r, stableIdentifier(r, source, fileHash, patientId, resolve).value as string);
    return keys.get(r) as string;
  };
  const groups = new Map<string, Set<string>>();
  for (const r of ordered) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)?.add(contentHash(r, patientId));
  }
  // A C-CDA visit is one record per id: its copies in one batch merge (mergeCopies), never split by content.
  const oneVisit = (r: Resource) => source.kind === 'ccda' && r.resourceType === 'Encounter';
  const colliding = new Set([...groups].filter(([k, h]) => h.size > 1 && !ordered.some((r) => oneVisit(r) && keyOf(r) === k)).map(([k]) => k));
  return { ordered, patientIdentifiers, keyOf, colliding };
}

export async function importResources(
  client: MedplumClient,
  resources: Resource[],
  source: SourceInfo,
  patientId: string,
  fileHash: string,
): Promise<ImportReport> {
  const report: ImportReport = {
    created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0,
    ...(source.seenAt && { seen: 0 }),
    ...(source.kind === 'smart' && { byType: {} }),
    unmapped: [],
  };
  // Stamped at each create, not once per import: a whats_new markSeen during a long import must not hide its later records.
  const arrived = (): Extension => ({ url: ARRIVED, valueInstant: new Date().toISOString() });
  const { ordered, patientIdentifiers, keyOf, colliding } = batchKeys(resources, source, fileHash, patientId); // throws before any write
  // The agent wrote this record (or it is protected): smart fill-only writes leave it alone (last-seen still advances).
  const agentOrShielded = (r: Resource): boolean => shielded(r) || hasTag(r, 'writer-agent');
  // Writes a kept record when it changed or its last-seen is behind this import's seenAt (that extension only).
  const keep = async (r: R, changed: boolean): Promise<void> => {
    const { extension: ext = [], ...rest } = r;
    const seen = !!source.seenAt && DATED.has(r.resourceType) && ext.find((e) => e.url === LAST_SEEN)?.valueDateTime !== source.seenAt;
    if (!changed && !seen) return;
    const mark = { url: LAST_SEEN, valueDateTime: source.seenAt };
    const extension = !seen ? ext : ext.some((e) => e.url === LAST_SEEN) ? ext.map((e) => (e.url === LAST_SEEN ? mark : e)) : [...ext, mark];
    await client.updateResource({ ...rest, ...(extension.length && { extension }) } as Resource);
    if (seen) report.seen = (report.seen ?? 0) + 1;
  };

  const patient = await client.readResource('Patient', patientId);
  const have = new Set((patient.identifier ?? []).map(idKey));
  const missing: Identifier[] = [];
  for (const i of patientIdentifiers) {
    if (have.has(idKey(i))) continue;
    have.add(idKey(i));
    missing.push(i);
  }
  // Demographics fill only what the GA Patient lacks; a differing source value is logged (field name only), never applied.
  const next: Patient = { ...patient };
  for (const sp of resources.filter((r): r is Patient => r.resourceType === 'Patient')) {
    for (const f of ['birthDate', 'gender', 'name'] as const) {
      const v = sp[f];
      if (v === undefined || (Array.isArray(v) && !v.length)) continue;
      if (next[f] === undefined || (Array.isArray(next[f]) && !(next[f] as unknown[]).length)) Object.assign(next, { [f]: v });
      else if (JSON.stringify(next[f]) !== JSON.stringify(v)) console.error(`patient demographic conflict: ${f}`);
    }
  }
  const filled = (['birthDate', 'gender', 'name'] as const).some((f) => next[f] !== patient[f]);
  if (missing.length || filled) await client.updateResource<Patient>({ ...next, identifier: [...(patient.identifier ?? []), ...missing] });

  for (const r of ordered) if (colliding.has(keyOf(r))) console.error(`source id collision: ${r.resourceType}`);

  // Link lookup by Epic id. A candidate that already has an identifier in the incoming stable system is a different
  // record from the same kind of source (Epic reuses entry ids; one batch must not merge into itself). One remaining
  // candidate is a link; several, or only same-source ones, are possible duplicates (C-CDA excepted: milestone 1 already
  // tells same-id entries apart by content, and real documents reuse ids across whole groups of entries).
  // The EHI note systems (one per export) of the patient, each with the Epic org numbers its export's records carry (EHI visits
  // hold Epic CSN ids under the org root), read once per import when a note carries an Epic note id.
  let noteSystems: Promise<Map<string, Set<string>>> | undefined;
  const orgOf = (ids: Identifier[]) => ids.map((i) => EPIC_ORG.exec(i.system ?? '')?.[1]).filter((n): n is string => !!n);
  const readNoteSystems = async () => {
    const systems = new Map<string, Set<string>>();
    for await (const page of client.searchResourcePages('DocumentReference', { subject: `Patient/${patientId}`, _sort: '_lastUpdated', _count: '1000' }, { cache: 'no-cache' })) {
      for (const d of page) for (const i of d.identifier ?? []) if (i.system?.startsWith('urn:ga-server:id:ehi:') && i.value?.startsWith('HNO_INFO|')) systems.set(i.system, new Set());
    }
    for (const [system, orgs] of systems) {
      for (const e of await client.searchResources('Encounter', { identifier: `${system}|`, subject: `Patient/${patientId}`, _count: '100' }, { cache: 'no-cache' })) {
        for (const n of orgOf(e.identifier ?? [])) orgs.add(n);
      }
    }
    return systems;
  };
  // EHI notes (known by their EHI identifier: another source's update drops the src-ehi tag) with one of these Epic note ids,
  // from an export of the same Epic org only (an unknown org never links).
  const ehiNotes = async (ids: Identifier[]): Promise<R[]> => {
    if (!ids.length) return [];
    noteSystems ??= readNoteSystems();
    const out: R[] = [];
    for (const [system, orgs] of await noteSystems) for (const i of ids) {
      if (!orgOf([i]).some((n) => orgs.has(n))) continue;
      out.push(...((await client.searchResources('DocumentReference', { identifier: `${system}|HNO_INFO|${i.value}`, subject: `Patient/${patientId}` }, { cache: 'no-cache' })) as R[]));
    }
    return out;
  };
  const linkHit = async (incoming: R, ident: Identifier): Promise<{ hit?: R; dups: R[] }> => {
    const type = incoming.resourceType;
    const field = COMPARTMENT[type];
    if (!field && !SHARED.has(type)) return { dups: [] };
    const ref = field && (incoming as unknown as Record<string, { reference?: string } | undefined>)[field]?.reference;
    const epic = idList(incoming).filter((x) => x.system?.startsWith(EPIC_OID) && x.value);
    if (!epic.length) return { dups: [] };
    if (field && ref !== `Patient/${patientId}`) {
      console.error(`link skipped, no patient: ${type}`);
      return { dups: [] };
    }
    const { found: all, free: open } = await linkCandidates(client, type, epic, patientId, ident.system as string);
    // Note linking by Epic note id is C-CDA <-> EHI only: a portal note stays apart from EHI and C-CDA notes (a merge would replace the text).
    const fileNote = (x: string) => x.startsWith('urn:ga-server:id:ehi:') || x === 'urn:ga-server:id:ccda';
    const other = source.kind === 'smart' ? fileNote : source.kind === 'ehi' || source.kind === 'ccda' ? (x: string) => x.startsWith('urn:ga-server:id:smart:') : undefined;
    const allowed = (c: Resource) => type !== 'DocumentReference' || !other || !idList(c as R).some((x) => other(x.system ?? ''));
    const found = (all as R[]).filter(allowed);
    const free = (open as R[]).filter(allowed);
    // A note's Epic id (HNO note id) is the NOTE_ID of the EHI note GA may already hold (identifier <ehi system>|HNO_INFO|<id>,
    // with no Epic-OID identifier of its own): such a note is a candidate too.
    if (type === 'DocumentReference' && source.kind === 'ccda') {
      for (const n of await ehiNotes(epic.filter((i) => EPIC_NOTE.test(i.system ?? '')))) {
        if (found.some((f) => f.id === n.id)) continue;
        found.push(n);
        if (!idList(n).some((x) => x.system === ident.system)) free.push(n);
      }
    }
    if (free.length === 1) return { hit: free[0], dups: [] };
    if (free.length) return { dups: free };
    return { dups: source.kind === 'ccda' ? [] : found };
  };

  // Concepts: the batch's own codes teach the source maps first, so learning doesn't depend on record order. Learned
  // entries are only added, never replacing one (upsertEntries re-checks the map it reads): a source never overrides an
  // agent's mapping. Maps are read fresh: another process (an agent's map_concept) may have written since this one cached.
  // An install whose access policy predates ConceptMap (ga setup re-run) still imports, uncoded, and learns nothing.
  let mapsRead = true;
  let maps = await loadMaps(client, true).catch((e: Error): Maps => {
    console.error(`concept maps not read: ${e.message}`);
    mapsRead = false;
    return new Map();
  });
  const learned = mapsRead ? learnable(ordered, source, maps) : new Map<string, MapEntry[]>();
  for (const [key, entries] of learned) {
    // One read-modify-write per source, serially; a failed map write never fails the import.
    await upsertEntries(client, key, entries).catch((e: Error) => console.error(`concept map ${key} not updated: ${e.message}`));
  }
  if (learned.size) maps = await loadMaps(client, true).catch(() => maps);

  const idMap = new Map<string, string>();
  for (const src of ordered) {
    const before = { ...report };
    const r = structuredClone(src) as R;
    walkReferences(r, (ref) => idMap.get(ref));
    // A record pointing at a Patient other than this import's would sit outside every compartment GA reads and cleans up.
    const patientRef = COMPARTMENT[r.resourceType] && (r as unknown as Record<string, { reference?: string } | undefined>)[COMPARTMENT[r.resourceType]]?.reference;
    if (patientRef && /^(Patient\/|urn:)/.test(patientRef) && patientRef !== `Patient/${patientId}`) {
      console.error(`invalid ${r.resourceType}: its patient is not the one being imported`);
      report.invalid++;
      continue;
    }
    // C-CDA keys come from the record as the source sent it (its links resolve in the batch); they ignore what the rewrite changes.
    let ident = source.kind === 'ccda' ? { ...stableIdentifier(r, source, fileHash, patientId), value: keyOf(src) } : stableIdentifier(r, source, fileHash, patientId);
    if (!ident.value) throw new GaError(`${r.resourceType} has no source id`);
    if (colliding.has(keyOf(src))) ident = { ...ident, value: `${ident.value}|${contentHash(r, patientId)}` };
    const incoming = stamp(r, source, ident) as R;
    // Last-seen goes only on a record already linked to this source: on any other it would read "no longer returned".
    const carries = (ex: R) => idList(ex).some((i) => idKey(i) === idKey(ident));
    delete incoming.id;
    const type = incoming.resourceType;
    // Identity and matching use the record as the source sent it; what is written carries GA's coding.
    const concept = codeRecord(incoming, source, maps);
    const coded = concept.resource as R;
    // Searches stay outside the try: only a write's validation failure is tolerated.
    // Scoped to the patient: Apple (and some C-CDA) identifiers carry no patient, so a global search crosses patients.
    const field = COMPARTMENT[type];
    // A record stored without a patient (the converter emits some C-CDA Encounters/Devices so) belongs to no other patient: match it too.
    // Only C-CDA stores such records, and the stable identifier is per source kind, so other sources skip this search.
    const byStable = (await client.searchOne(type, { identifier: idKey(ident), ...(field && { [field]: `Patient/${patientId}` }) }, { cache: 'no-cache' }) ??
      (field && source.kind === 'ccda' ? await client.searchOne(type, { identifier: idKey(ident), [`${field}:missing`]: 'true' }, { cache: 'no-cache' }) : undefined)) as R | undefined;
    const link = byStable ? { dups: [] } : await linkHit(incoming, ident);
    const linked = link.hit;
    const existing = byStable ?? linked;
    const key = !existing && type === 'Observation' ? contentKey(incoming as Observation) : undefined;
    // Medplum's date=<day> matches only date-only values; a ge/lt range finds every time. One day wider each side, as UTC
    // and the record's own offset can disagree on the day; sameDay then keeps those on the incoming record's day.
    const day = key?.split('|')[2];
    const shift = (n: number) => day && new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
    const when = effective(incoming as Observation) ?? '';
    const contentMatches = key
      ? await client.searchResources(
          'Observation',
          new URLSearchParams([['subject', `Patient/${patientId}`], ['code', key.split('|').slice(0, 2).join('|')], ['date', `ge${shift(-1)}`], ['date', `lt${shift(2)}`], ['_count', '1000']]), // Apple readings under one code fill the default page
        ).then((ms) => ms.filter((m) => sameDay(when, effective(m) ?? '') && stripConcept(m).code?.coding?.some((c) => key.startsWith(`${c.system ?? ''}|${c.code}|`)))) // never on a GA-added code
      : [];
    // A kept record (skipped, linked, filled) re-coded by this import's maps, so an entry learned in this batch reaches it too.
    // Not an agent-written or protected record, and never by a map other than its own: a record another GA source already coded keeps that coding,
    // and a coded record is never stripped to unmapped. Returns ex itself when nothing would change.
    const recode = (ex: R): R => {
      if (agentOrShielded(ex)) return ex;
      const hasGa = gaCodings(ex).length > 0;
      const others = idList(ex).some((i) => i.system?.startsWith('urn:ga-server:id:') && i.system !== ident.system);
      if (hasGa && others) return ex;
      const out = codeRecord(ex, source, maps);
      return (hasGa && out.status === 'unmapped') || sameConcept(out.resource, ex) ? ex : (out.resource as R);
    };
    // Only top-level fields the record lacks (any choice variant counts as present), plus the incoming identifiers.
    const fillOnto = async (ex: R): Promise<R> => {
      if (agentOrShielded(ex)) {
        if (carries(ex)) await keep(ex, false);
        report.skipped++;
        return ex;
      }
      const bases = new Set(Object.keys(ex).map(choiceBase));
      const add = Object.entries(coded).filter(([k, v]) => v !== undefined && !BOOKKEEPING.has(k) && !bases.has(choiceBase(k)));
      const have = new Set(idList(ex).map(idKey));
      const ids = idList(incoming).filter((i) => !have.has(idKey(i)));
      const added = add.length + ids.length > 0;
      const filled = { ...ex, ...Object.fromEntries(add), identifier: [...idList(ex), ...ids] } as R;
      const out = recode(filled);
      await keep(out, added || out !== filled);
      if (added) report.merged++;
      else report.skipped++;
      return out;
    };
    // A portal copy marked fill-only never replaces a record another GA source (EHI, C-CDA, PDF) wrote, on every sync.
    const fillOnly = (ex: R) => source.kind === 'smart' && !!source.fillOnly?.(incoming) && idList(ex).some((i) => OTHER_SOURCE(i.system ?? ''));
    // Apple readings are many per day and never day-level duplicates of (or by) hospital records; only an exact match merges.
    const fromApple = source.kind === 'apple-health';
    // A same-day content match at another time of day is a possible duplicate only with the same value (one lab, collected vs resulted
    // time in two sources); different values at different times are separate readings (a retaken BP, a home log).
    const timed = (v?: string) => !!v && /T\d/.test(v);
    const sameMoment = (m: R) => !timed(when) || !timed(effective(m as Observation)) || Date.parse(when) === Date.parse(effective(m as Observation)!)
      || sameNumbers(m as Observation, incoming as Observation);
    const dayMatches = [...link.dups, ...contentMatches.filter((m) => !link.dups.some((d) => d.id === m.id) && sameMoment(m as R))] as R[];
    const matches = fromApple ? [] : dayMatches.filter((m) => !isApple(m));
    try {
      let target: Resource;
      const idless = ![(src as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat()[0]?.value;
      // A copy of this source's own record (found by its C-CDA key, or carrying one), or a visit it links to by Epic id. A visit
      // another source wrote (EHI, portal) keeps its values for this and every later document; the copy adds what it lacks.
      const own = !!existing && (existing === byStable || idList(existing).some((i) => i.system === 'urn:ga-server:id:ccda'));
      const copies = !!existing && source.kind === 'ccda' && (type === 'Encounter' || (own && idless)) && !agentOrShielded(existing as R);
      if (copies) {
        // Another source's visit keeps its values only while that source wrote it last: a C-CDA body on an EHI visit (src-ccda tag)
        // takes the new document's values.
        const theirs = idList(existing as R).some((i) => i.system?.startsWith('urn:ga-server:id:') && i.system !== 'urn:ga-server:id:ccda') && !hasTag(existing as R, 'src-ccda');
        const merged = mergeCopies(existing as R, coded, theirs);
        const body = (x: R) => JSON.stringify({ ...x, id: undefined, meta: undefined, extension: undefined, identifier: undefined }, sorted);
        const have = new Set(idList(existing as R).map(idKey));
        const ids = idList(incoming).some((i) => !have.has(idKey(i)));
        if (body(merged) !== body(existing as R) || ids) {
          target = await unionUpdate(client, existing as R, merged);
          report.updated++;
        } else {
          await keep(existing as R, false);
          target = existing as Resource;
          report.skipped++;
        }
      } else if (existing) {
        target = existing;
        const filled = fillFrom(existing, coded, source);
        const d = decide(existing, filled);
        // An Apple reading already merged into a hospital record: the hospital body stays, whatever the dates say.
        // Hospital ids the Apple copy itself carries (Health Records allergies) don't count.
        const inc = new Set(idList(incoming).map(idKey));
        if (fromApple && idList(existing).some((i) => i.system !== APPLE && !inc.has(idKey(i)))) {
          await keep(existing, false);
          report.skipped++;
        } else if (d === 'conflict') {
          // The tag and last-seen in one write: a person's edit must not make a portal medication read "may have been stopped".
          const tagged = (hasTag(existing, 'source-conflict') ? existing : withTag(existing, 'source-conflict')) as R;
          if (carries(existing)) await keep(tagged, tagged !== existing);
          else if (tagged !== existing) await client.updateResource(tagged);
          report.conflicts++;
        } else if (fillOnly(existing)) target = await fillOnto(existing);
        else if (d === 'update') {
          target = await unionUpdate(client, existing, filled);
          report.updated++;
        } else if (linked) {
          // Equal or older source: only record its identifiers, so the next import finds it by stable identifier.
          const have = new Set(idList(existing).map(idKey));
          target = recode({ ...existing, identifier: [...idList(existing), ...idList(incoming).filter((i) => !have.has(idKey(i)))] });
          await keep(target as R, true);
          report.merged++;
        } else {
          const out = recode(existing);
          await keep(out, out !== existing); // a concept write only: still a skip
          target = out;
          report.skipped++;
        }
      } else {
        // Spec §5: only an exact effective time merges; a day-only match is a possible duplicate.
        // Instants when both carry a time (offsets may differ); a date-only value matches only the same date-only value.
        const exact = (a = '', b = '') => (a.length > 10 && b.length > 10 ? Date.parse(a) === Date.parse(b) : a === b); // NaN never equals
        const same = contentMatches.find((m) => sameValue(m, incoming as Observation) && exact(effective(m), effective(incoming as Observation))) as R | undefined;
        if (same) {
          target = same;
          const filled = fillFrom(same, coded, source);
          const d = decide(same, filled);
          // conflict: equal value already recorded by the agent; don't attach an importer identifier (it would conflict on every re-import).
          const appleOntoOther = fromApple && !isApple(same);
          const otherOntoApple = !fromApple && isApple(same) && !hasNonApple(same); // hospital body beats an Apple-only one
          if (d === 'conflict') report.skipped++;
          else if (fillOnly(same)) await fillOnto(same);
          else {
            // Different writers (hospital record vs PDF extraction): keep the existing body, only record the second source.
            if (otherOntoApple || (d === 'update' && !appleOntoOther && hasTag(same, 'writer-agent') === hasTag(incoming, 'writer-agent'))) target = await unionUpdate(client, same, filled);
            else await keep({ ...same, identifier: [...(same.identifier ?? []), ident] }, true);
            report.merged++;
          }
        } else if (matches.length) {
          const dupExt = (o: Resource): Extension => ({ url: DUP_OF, valueReference: { reference: `${o.resourceType}/${o.id}` } });
          target = await client.createResource(
            withTag({ ...coded, extension: [...(coded.extension ?? []), arrived(), ...matches.map(dupExt)] } as Resource, 'possible-duplicate'),
          );
          for (const m of matches) {
            const tag = hasTag(m, 'possible-duplicate') ? m : withTag(m, 'possible-duplicate');
            await client.updateResource({ ...tag, extension: [...(m.extension ?? []), dupExt(target)] } as Resource);
          }
          report.possibleDuplicates++;
        } else {
          target = await client.createResource({ ...coded, extension: [...(coded.extension ?? []), arrived()] } as Resource);
          report.created++;
        }
      }
      for (const k of sourceKeys(src)) idMap.set(k, `${type}/${target.id}`);
      // Review lines: only records stored (written or kept) still unmapped.
      if (concept.status === 'unmapped' && hasTag(target, 'concept-unmapped')) countUnmapped(report.unmapped, coded, source);
    } catch (e) {
      if (!isValidationFailure(e)) throw e;
      // Element paths only: server diagnostics can echo values. References to this resource stay unresolved.
      console.error(`invalid ${(e.outcome.issue ?? []).map((i) => `${type}/${i.expression?.join(',')}`).join(' ')}`);
      report.invalid++;
    }
    if (report.byType) {
      const t = (report.byType[type] ??= { created: 0, linked: 0, updated: 0, flagged: 0, seen: 0 });
      t.created += report.created - before.created;
      t.linked += report.merged - before.merged;
      t.updated += report.updated - before.updated;
      t.flagged += report.possibleDuplicates - before.possibleDuplicates + report.conflicts - before.conflicts;
      t.seen += (report.seen ?? 0) - (before.seen ?? 0);
    }
  }
  if (source.kind === 'ccda' || source.kind === 'ehi') {
    const newest = Math.max(...ordered.map((r) => Date.parse(source.dateOf?.(r) ?? source.date)).filter((t) => !Number.isNaN(t)));
    // newestEpicImport seeds the stored date from a scan when there is none, so an older import never hides a newer one.
    await storeNewestImport(client, patientId, Math.max(newest, await newestEpicImport(client, patientId)));
  }
  return report;
}
