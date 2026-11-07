import { getStatus, type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Extension, Identifier, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { addUnmapped, carryConcept, codeRecord, countUnmapped, gaCodings, learnable, onSource, sameConcept, stripConcept, type Unmapped } from './concept-apply.ts';
import { loadMaps, type MapEntry, type Maps, upsertEntries } from './conceptmap.ts';
import { GaError } from './config.ts';
import { APPLE, ARRIVED, NEWEST_IMPORT, contentHash, contentKey, DATED, EPIC_OID, effective, LAST_SEEN, sameDay, SINGULAR_ID, stableIdentifier, stamp, type SourceInfo } from './identity.ts';
import { collapsePatients, walkReferences } from './patient.ts';

export type Decision = 'create' | 'update' | 'skip' | 'conflict';
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
};
const COUNTS = ['created', 'updated', 'skipped', 'merged', 'conflicts', 'possibleDuplicates', 'invalid'] as const;
// Adds one importResources report into a running total (several files or batches of one import).
export function addReport(total: ImportReport, r: ImportReport): void {
  for (const k of COUNTS) total[k] += r[k];
  addUnmapped(total.unmapped, r.unmapped);
}
type TypeCounts = { created: number; linked: number; updated: number; flagged: number; seen: number };

type R = Resource & { identifier?: Identifier[]; extension?: Extension[] };
export const TAG = 'urn:ga-server:tag';
const SRC_DATE = 'urn:ga-server:ext:source-date';
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

export const hasTag = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);
const srcDate = (r: R) => r.extension?.find((e) => e.url === SRC_DATE)?.valueDateTime;
const idKey = (i: Identifier) => `${i.system}|${i.value}`;
const idList = (r: R): Identifier[] => [r.identifier ?? []].flat(); // singular on SINGULAR_ID types
const isApple = (r: R) => idList(r).some((i) => i.system === APPLE);
const hasNonApple = (r: R) => idList(r).some((i) => i.system !== APPLE);
const canon = (x: unknown) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );

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

// author: GA's own writer reference (ClientApplication/<id>); a record last changed by anyone else is a person's edit.
export function decide(existingRes: Resource | undefined, incomingRes: Resource, author?: string): Decision {
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
  const lastBy = existing.meta?.author?.reference;
  const importerOwned = hasTag(existing, 'writer-importer') && !hasTag(existing, 'source-conflict') && !(author && lastBy && lastBy !== author);
  // Portal-synced records are confirmed by last-seen instead (advanced separately), so only file imports need the refresh.
  const dated = DATED.has(incoming.resourceType) && !existing.extension?.some((e) => e.url === LAST_SEEN);
  if (subset && canon(body(existing)) === canon(body(incoming))) return id && importerOwned && dated ? 'update' : 'skip';
  // Only a write that would actually happen is a conflict. The source-conflict tag sticks: tagging it made GA the author.
  if ((author && lastBy && lastBy !== author) || hasTag(existing, 'source-conflict')) return 'conflict';
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
export function sameValue(a: Observation, b: Observation): boolean {
  if (a.valueQuantity && b.valueQuantity) return a.valueQuantity.value === b.valueQuantity.value && a.valueQuantity.unit === b.valueQuantity.unit;
  if (a.valueCodeableConcept && b.valueCodeableConcept) return !!firstCoding(a) && firstCoding(a) === firstCoding(b);
  if (a.valueBoolean !== undefined || b.valueBoolean !== undefined) return a.valueBoolean === b.valueBoolean;
  return a.valueString !== undefined && a.valueString === b.valueString;
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
  const { resources: collapsed, patientIdentifiers } = collapsePatients(resources, patientId);
  const ordered = topoSort(collapsed); // throws before any write
  const me = client.getProfile();
  const author = me ? `${me.resourceType}/${me.id}` : undefined;
  const byOther = (r: Resource): boolean => {
    const lastBy = r.meta?.author?.reference;
    return !!(author && lastBy && lastBy !== author);
  };
  // A GA write onto a record a person last changed makes GA its author: keep it protected with the sticky source-conflict tag.
  const protect = (r: Resource): Resource => (byOther(r) && !hasTag(r, 'source-conflict') ? withTag(r, 'source-conflict') : r);
  // A person (or the agent) last shaped this record: smart fill-only writes leave it alone (last-seen still advances).
  const personEdited = (r: Resource): boolean => byOther(r) || hasTag(r, 'source-conflict') || hasTag(r, 'writer-agent');
  // Writes a kept record when it changed or its last-seen is behind this import's seenAt (that extension only).
  const keep = async (r: R, changed: boolean): Promise<void> => {
    const { extension: ext = [], ...rest } = r;
    const seen = !!source.seenAt && DATED.has(r.resourceType) && ext.find((e) => e.url === LAST_SEEN)?.valueDateTime !== source.seenAt;
    if (!changed && !seen) return;
    const mark = { url: LAST_SEEN, valueDateTime: source.seenAt };
    const extension = !seen ? ext : ext.some((e) => e.url === LAST_SEEN) ? ext.map((e) => (e.url === LAST_SEEN ? mark : e)) : [...ext, mark];
    await client.updateResource(protect({ ...rest, ...(extension.length && { extension }) } as Resource));
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

  // Same stable identifier twice in one batch with different content would make the second a silent skip:
  // give every member of such a group source id + content hash (deterministic, order-independent).
  const keyOf = (r: Resource) => stableIdentifier(r, source, fileHash, patientId).value as string;
  const groups = new Map<string, Set<string>>();
  for (const r of ordered) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)?.add(contentHash(r, patientId));
  }
  const colliding = new Set([...groups].filter(([, h]) => h.size > 1).map(([k]) => k));
  for (const r of ordered) if (colliding.has(keyOf(r))) console.error(`source id collision: ${r.resourceType}`);

  // Link lookup by Epic id. A candidate that already has an identifier in the incoming stable system is a different
  // record from the same kind of source (Epic reuses entry ids; one batch must not merge into itself). One remaining
  // candidate is a link; several, or only same-source ones, are possible duplicates (C-CDA excepted: milestone 1 already
  // tells same-id entries apart by content, and real documents reuse ids across whole groups of entries).
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
    const found = all as R[];
    const free = open as R[];
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
    let ident = stableIdentifier(r, source, fileHash, patientId);
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
    const byStable = (await client.searchOne(type, { identifier: idKey(ident), ...(field && { [field]: `Patient/${patientId}` }) }, { cache: 'no-cache' }) ??
      (field ? await client.searchOne(type, { identifier: idKey(ident), [`${field}:missing`]: 'true' }, { cache: 'no-cache' }) : undefined)) as R | undefined;
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
          new URLSearchParams([['subject', `Patient/${patientId}`], ['code', key.split('|').slice(0, 2).join('|')], ['date', `ge${shift(-1)}`], ['date', `lt${shift(2)}`]]),
        ).then((ms) => ms.filter((m) => sameDay(when, effective(m) ?? '') && stripConcept(m).code?.coding?.some((c) => key.startsWith(`${c.system ?? ''}|${c.code}|`)))) // never on a GA-added code
      : [];
    // A kept record (skipped, linked, filled) re-coded by this import's maps, so an entry learned in this batch reaches it too.
    // Not a person's record, and never by a map other than its own: a record another GA source already coded keeps that coding,
    // and a coded record is never stripped to unmapped. Returns ex itself when nothing would change.
    const recode = (ex: R): R => {
      if (personEdited(ex)) return ex;
      const hasGa = gaCodings(ex).length > 0;
      const others = idList(ex).some((i) => i.system?.startsWith('urn:ga-server:id:') && i.system !== ident.system);
      if (hasGa && others) return ex;
      const out = codeRecord(ex, source, maps);
      return (hasGa && out.status === 'unmapped') || sameConcept(out.resource, ex) ? ex : (out.resource as R);
    };
    // Only top-level fields the record lacks (any choice variant counts as present), plus the incoming identifiers.
    const fillOnto = async (ex: R): Promise<R> => {
      if (personEdited(ex)) {
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
    const dayMatches = [...link.dups, ...contentMatches.filter((m) => !link.dups.some((d) => d.id === m.id))] as R[];
    const matches = fromApple ? [] : dayMatches.filter((m) => !isApple(m));
    try {
      let target: Resource;
      if (existing) {
        target = existing;
        const filled = fillFrom(existing, coded, source);
        const d = decide(existing, filled, author);
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
          const d = decide(same, filled, author);
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
            const tag = protect(hasTag(m, 'possible-duplicate') ? m : withTag(m, 'possible-duplicate'));
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
    const p = await client.readResource('Patient', patientId);
    const stored = Date.parse(p.extension?.find((e) => e.url === NEWEST_IMPORT)?.valueDateTime ?? '');
    if (newest > (stored || -Infinity)) await client.updateResource<Patient>({ ...p, extension: [...(p.extension ?? []).filter((e) => e.url !== NEWEST_IMPORT), { url: NEWEST_IMPORT, valueDateTime: new Date(newest).toISOString() }] });
  }
  return report;
}
