// What a share may show: the security core. Every share route and Ask tool reads only loadScoped's result.
import { getStatus, OperationOutcomeError, type MedplumClient } from '@medplum/core';
import type { Endpoint, Patient, Resource, ResourceType } from '@medplum/fhirtypes';
import { currencyContext, EPIC_TAGS, isActive } from '../current.ts';
import { hasTag, NEWEST_IMPORT, TAG } from '../identity.ts';
import { SOURCE_ID, forPatient } from '../smart/sync.ts';
import type { Group, Share } from './store.ts';

// newestImport: newest Epic import over the whole record (not just the share), for the medication currency rule.
// Apple readings are most of a record (73k readings ~160 MiB) and never kept: `apple` is their summary, one line per type,
// and `applePages` streams them for the FHIR download. `binaries`: the Binary ids the share may serve, read only when opened.
export type Scoped = {
  patient: Patient; resources: Resource[]; support: Resource[]; endpoints: Endpoint[]; newestImport?: number;
  apple?: AppleLine[]; applePages?: () => AsyncIterable<Resource[]>; binaries?: string[];
};
export type AppleLine = { n: number; first?: string; latest?: string; last: Resource };

// Patient goes out only through trimPatient; billing and contact records stay home like the Patient's own; Group lists other patients.
// Composition: the C-CDA narrative, every section including insurance (payer name, member ID).
const NEVER = new Set([
  'Endpoint', 'Provenance', 'AuditEvent', 'Patient', 'Coverage', 'RelatedPerson', 'Account', 'Claim', 'ExplanationOfBenefit', 'Person',
  'Basic', 'Group', 'ClaimResponse', 'Invoice', 'ChargeItem', 'CoverageEligibilityRequest', 'CoverageEligibilityResponse', 'EnrollmentRequest',
  'Composition',
]);
// FHIR R4 Patient CompartmentDefinition types with a compartment param (as in Medplum's definitions), never-shared ones not fetched.
export const PATIENT_COMPARTMENT = [
  'Account', 'AdverseEvent', 'AllergyIntolerance', 'Appointment', 'AppointmentResponse', 'AuditEvent', 'Basic', 'BodyStructure',
  'CarePlan', 'CareTeam', 'ChargeItem', 'Claim', 'ClaimResponse', 'ClinicalImpression', 'Communication', 'CommunicationRequest',
  'Composition', 'Condition', 'Consent', 'Coverage', 'CoverageEligibilityRequest', 'CoverageEligibilityResponse', 'DetectedIssue',
  'DeviceRequest', 'DeviceUseStatement', 'DiagnosticReport', 'DocumentManifest', 'DocumentReference', 'Encounter', 'EnrollmentRequest',
  'EpisodeOfCare', 'ExplanationOfBenefit', 'FamilyMemberHistory', 'Flag', 'Goal', 'Group', 'ImagingStudy', 'Immunization',
  'ImmunizationEvaluation', 'ImmunizationRecommendation', 'Invoice', 'List', 'MeasureReport', 'Media', 'MedicationAdministration',
  'MedicationDispense', 'MedicationRequest', 'MedicationStatement', 'MolecularSequence', 'NutritionOrder', 'Observation', 'Patient',
  'Person', 'Procedure', 'Provenance', 'QuestionnaireResponse', 'RelatedPerson', 'RequestGroup', 'ResearchSubject', 'RiskAssessment',
  'Schedule', 'ServiceRequest', 'Specimen', 'SupplyDelivery', 'SupplyRequest', 'Task', 'VisionPrescription',
] as ResourceType[];
export const COMPARTMENT_TYPES = PATIENT_COMPARTMENT.filter((t) => !NEVER.has(t));
// Archives and imported source files (C-CDA, EHI media, PDFs): untrimmed demographics, MRN, insurance and out-of-scope data.
// Only the records extracted from them are shared; their Binary is never followed, not even from another record that links it.
export const NEVER_DOCS = new Set(['urn:ga-server:id:ehi-archive', 'urn:ga-server:id:apple-health-archive', 'urn:ga-server:id:dicom-archive', 'urn:ga-server:id:file']);
const BY_TYPE: Record<string, Group> = {
  DiagnosticReport: 'labs',
  MedicationStatement: 'medications',
  MedicationRequest: 'medications',
  MedicationAdministration: 'medications',
  MedicationDispense: 'medications',
  Condition: 'problems',
  AllergyIntolerance: 'allergies',
  Immunization: 'immunizations',
  Encounter: 'visits',
  DocumentReference: 'notes',
  Procedure: 'procedures',
  FamilyMemberHistory: 'family',
  Communication: 'messages',
};
const DATE_PATHS = [
  'effectiveDateTime', 'effectivePeriod.start', 'issued', 'occurrenceDateTime', 'performedDateTime', 'performedPeriod.start',
  'period.start', 'date', 'authoredOn', 'sent', 'authored', 'recordedDate', 'onsetDateTime', 'dateAsserted', 'dispenseRequest.validityPeriod.start', 'whenHandedOver', 'context.period.start',
];
// Only these are followed from in-scope records, one hop; they are never searchable on their own.
const SUPPORT_REF = /^(Medication|Practitioner|PractitionerRole|Organization|Location|Binary)\/([A-Za-z0-9\-.]{1,64})(?:\/|$)/;
// Attachment urls: Medplum may answer with a presigned /storage/<binary id>/... URL instead of Binary/<id>.
export const BINARY_URL = /(?:^|\/)(?:Binary|storage)\/([0-9a-f-]{36})/;

type Any = Record<string, unknown>;
type Cc = { text?: string; coding?: { system?: string; code?: string; display?: string }[] };
export const cc = (c?: Cc): string | undefined => c?.text ?? c?.coding?.[0]?.display ?? c?.coding?.[0]?.code;
export const codeKey = (r: Resource): string => {
  const o = r as { code?: Cc; medicationCodeableConcept?: Cc; vaccineCode?: Cc };
  const c = (o.code ?? o.medicationCodeableConcept ?? o.vaccineCode)?.coding?.[0];
  const t = cc(o.code);
  return c?.code ? `${c.system ?? ''}|${c.code}` : t ? `text|${t}` : `type|${r.resourceType}`;
};
export const hasCategory = (r: Resource, code: string): boolean =>
  ((r as { category?: { coding?: { code?: string }[] }[] }).category ?? []).some((c) => c.coding?.some((x) => x.code === code));

export function groupOf(r: Resource): Group | undefined {
  if (hasTag(r, 'src-apple-health')) return 'apple';
  if (r.resourceType === 'Observation') {
    if (hasCategory(r, 'laboratory')) return 'labs';
    if (hasCategory(r, 'vital-signs')) return 'vitals';
    // GA's PDF extraction emits lab results without a category.
    const uncategorized = !(r as { category?: unknown[] }).category?.length;
    return uncategorized && (hasTag(r, 'extracted-by-llm') || hasTag(r, 'src-pdf')) ? 'labs' : undefined;
  }
  return BY_TYPE[r.resourceType];
}

export function dateOf(r: Resource): string | undefined {
  for (const p of DATE_PATHS) {
    const v = p.split('.').reduce<unknown>((o, k) => (o as Any | undefined)?.[k], r);
    if (typeof v === 'string' && v) return v.slice(0, 10);
  }
  return undefined;
}

const STANDING_CLINICAL = new Set(['recurrence', 'relapse']);
const isStanding = (r: Resource): boolean =>
  isActive(r) || (r.resourceType === 'Condition' && !!(r as { clinicalStatus?: { coding?: { code?: string }[] } }).clinicalStatus?.coding?.some((c) => !!c.code && STANDING_CLINICAL.has(c.code)));

const neverShared = (r: Resource): boolean =>
  NEVER.has(r.resourceType) ||
  (r.resourceType === 'DocumentReference' && !!r.identifier?.some((i) => i.system && NEVER_DOCS.has(i.system)));

export function inScope(r: Resource, share: Share): boolean {
  if (neverShared(r)) return false;
  if (share.groups !== 'all') {
    const g = groupOf(r);
    if (!g || !share.groups.includes(g)) return false;
  }
  if (isStanding(r)) return true;
  if (!share.since && !share.until) return true;
  const d = dateOf(r);
  return !!d && (!share.since || d >= share.since) && (!share.until || d <= share.until);
}

// Allowlist, never a delete list: a new Patient field must not leak.
export const trimPatient = (p: Patient): Patient => ({
  resourceType: 'Patient',
  id: p.id,
  ...(p.name && { name: p.name }),
  ...(p.birthDate && { birthDate: p.birthDate }),
  ...(p.gender && { gender: p.gender }),
});

function supportRefs(r: Resource, out: Set<string>): void {
  const walk = (v: unknown, key?: string): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === 'string' && key === 'reference') {
      const m = SUPPORT_REF.exec(v);
      if (m) out.add(`${m[1]}/${m[2]}`);
    } else if (typeof v === 'string' && key === 'url') {
      const m = BINARY_URL.exec(v);
      if (m) out.add(`Binary/${m[1]}`);
    }
  };
  walk(r);
}

// Pure part of loadScoped: compartment records in, the share's records and the support refs they need out.
// Membership is checked on Medplum's meta.compartment too, not trusted to the _compartment query alone.
export function selectScoped(compartment: Resource[], share: Share): { resources: Resource[]; refs: string[]; newestImport: number } {
  const mine = `Patient/${share.patientId}`;
  const own = compartment.filter((r) => !!r.meta?.compartment?.some((c) => c.reference === mine));
  const resources = own.filter((r) => inScope(r, share));
  const refs = new Set<string>();
  for (const r of resources) supportRefs(r, refs);
  const blocked = new Set<string>();
  for (const r of own) if (r.resourceType === 'DocumentReference' && neverShared(r)) supportRefs(r, blocked);
  return { resources, refs: [...refs].filter((x) => !(x.startsWith('Binary/') && blocked.has(x))), newestImport: currencyContext(own, []).newestImport };
}

// Newest Epic import over the whole record, as selectScoped computes it from a loaded compartment, for callers that don't load it:
// the date importResources stored on the Patient, else (installs that predate it) a scan of the Epic-tagged records, only the fields currencyContext reads.
export async function newestEpicImport(client: MedplumClient, patientId: string): Promise<number> {
  const stored = Date.parse((await client.readResource('Patient', patientId, { cache: 'no-cache' })).extension?.find((e) => e.url === NEWEST_IMPORT)?.valueDateTime ?? '');
  if (!Number.isNaN(stored)) return stored;
  let newest = -Infinity;
  const _tag = [...EPIC_TAGS].map((c) => `${TAG}|${c}`).join(',');
  for (const type of COMPARTMENT_TYPES) {
    const q = { _compartment: `Patient/${patientId}`, _tag, _elements: 'extension,meta', _sort: '_lastUpdated', _count: '1000' };
    for await (const page of client.searchResourcePages(type, q, { cache: 'no-cache' })) newest = Math.max(newest, currencyContext(page, []).newestImport);
  }
  // Seed it so the next call skips the scan.
  if (Number.isFinite(newest)) await storeNewestImport(client, patientId, newest);
  return newest;
}

// Versioned like conceptmap.upsertEntries: re-read fresh, never move the stored date back, If-Match on the version, one retry on a lost race.
export async function storeNewestImport(client: MedplumClient, patientId: string, value: number, retry = true): Promise<void> {
  const p = await client.readResource('Patient', patientId, { cache: 'no-cache' });
  const had = Date.parse(p.extension?.find((e) => e.url === NEWEST_IMPORT)?.valueDateTime ?? '');
  const next = Math.max(value, Number.isNaN(had) ? -Infinity : had);
  if (next === had || next === -Infinity) return;
  try {
    await client.updateResource<Patient>({ ...p, extension: [...(p.extension ?? []).filter((e) => e.url !== NEWEST_IMPORT), { url: NEWEST_IMPORT, valueDateTime: new Date(next).toISOString() }] },
      { headers: { 'If-Match': `W/"${p.meta?.versionId}"` } });
  } catch (e) {
    if (!retry || !(e instanceof OperationOutcomeError) || getStatus(e.outcome) !== 412) throw e;
    await storeNewestImport(client, patientId, value, false);
  }
}

// One summary line's numbers per type (codeKey), fed page by page: count, date range and the newest reading (first one on a tie).
export function appleLines(rs: Iterable<Resource>, into = new Map<string, AppleLine>()): Map<string, AppleLine> {
  for (const r of rs) {
    const k = codeKey(r);
    const d = dateOf(r);
    const a = into.get(k);
    if (!a) { into.set(k, { n: 1, first: d, latest: d, last: r }); continue; }
    a.n++;
    if (d && (!a.first || d < a.first)) a.first = d;
    if (d && (!a.latest || d > a.latest)) a.latest = d;
    if ((d ?? '') > (dateOf(a.last) ?? '')) a.last = r;
  }
  return into;
}

const APPLE_TAG = `${TAG}|src-apple-health`;
// What summarize reads of a reading; choice fields by base and concrete name (the store takes either, Medplum's handling unchecked).
const APPLE_FIELDS = 'code,effective,effectiveDateTime,effectivePeriod,issued,value,valueQuantity,valueString,valueCodeableConcept,valueBoolean,valueInteger,component';
const withApple = (share: Share): boolean => share.groups === 'all' || share.groups.includes('apple');
// This share's Apple readings (Observations; the rest of Apple's records load with the compartment), one page at a time.
async function* applePages(client: MedplumClient, share: Share, elements?: string): AsyncGenerator<Resource[]> {
  const q = { _compartment: `Patient/${share.patientId}`, _tag: APPLE_TAG, _sort: '_lastUpdated', _count: '1000', ...(elements && { _elements: elements }) };
  for await (const page of client.searchResourcePages('Observation', q, { cache: 'no-cache' })) yield selectScoped(page, share).resources;
}

export async function loadScoped(client: MedplumClient, share: Share): Promise<Scoped> {
  const opts = { cache: 'no-cache' as const };
  const p = await client.readResource('Patient', share.patientId, opts);
  // Per type, not $everything: Medplum caps _offset at 10000. _sort=_lastUpdated with _count >= 20 makes it page by _cursor.
  const compartment: Resource[] = [];
  // Apple readings (Observations) are never loaded here (below: summarized page by page); a share without Apple fetches no
  // Apple record at all (an ECG CSV is ~330 KB inline). Never-shared archives are written untagged, so they still load and block their Binary.
  const apple = withApple(share);
  for (const type of COMPARTMENT_TYPES) {
    const q = { _compartment: `Patient/${share.patientId}`, _sort: '_lastUpdated', _count: '1000', ...((!apple || type === 'Observation') && { '_tag:not': APPLE_TAG }) };
    for await (const page of client.searchResourcePages(type, q, opts)) compartment.push(...page);
  }
  const { resources, refs, newestImport } = selectScoped(compartment, share);
  let lines: AppleLine[] | undefined;
  if (apple) {
    const acc = appleLines(resources.filter((r) => groupOf(r) === 'apple'));
    for await (const page of applePages(client, share, APPLE_FIELDS)) appleLines(page, acc);
    lines = [...acc.values()];
  }
  const ids = new Map<string, string[]>();
  for (const ref of refs) {
    const [type, id] = ref.split('/');
    ids.set(type, [...(ids.get(type) ?? []), id]);
  }
  const support: Resource[] = [];
  for (const [type, list] of ids) {
    if (type === 'Binary') continue; // read only when opened (binaryFetcher checks it is this patient's)
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      support.push(...(await client.searchResources(type as ResourceType, { _id: chunk.join(','), _count: '1000' }, opts)));
    }
  }
  const eps = await client.searchResources('Endpoint', { identifier: `${SOURCE_ID}|`, _count: '1000' }, opts);
  return {
    patient: trimPatient(p), resources, support, endpoints: eps.filter(forPatient(share.patientId)), newestImport, binaries: ids.get('Binary') ?? [],
    ...(lines && { apple: lines, applePages: () => applePages(client, share) }),
  };
}

export function scopedCache(load: typeof loadScoped, ttlMs = 300_000): typeof loadScoped {
  const cache = new Map<string, { at: number; p: Promise<Scoped> }>();
  return (client, share) => {
    const key = `${share.id}:${share.tokenHash}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p;
    for (const [k, v] of cache) if (Date.now() - v.at >= ttlMs) cache.delete(k); // expired loads hold a whole record each
    const p = load(client, share);
    cache.set(key, { at: Date.now(), p });
    p.catch(() => cache.get(key)?.p === p && cache.delete(key));
    return p;
  };
}
