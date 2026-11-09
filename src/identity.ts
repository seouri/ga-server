import { createHash } from 'node:crypto';
import type { Extension, Identifier, Observation, Resource } from '@medplum/fhirtypes';
import { GaError } from './config.ts';

export type SourceInfo = {
  kind: 'ccda' | 'pdf' | 'ehi' | 'apple-health' | 'smart';
  file: string;
  org?: string; // C-CDA custodian organisation name; keys the source's ConceptMap (src/conceptmap.ts)
  date: string;
  writer: 'importer' | 'agent';
  llm?: boolean;
  dateOf?: (r: Resource) => string | undefined; // per-resource source date; falls back to `date`
  fillOnly?: (r: Resource) => boolean; // true: may only add fields an existing other-source record lacks
  seenAt?: string; // stamp/refresh LAST_SEEN on every DATED record this import touches or skips
};
// On the Patient: the newest source date of any C-CDA or EHI import, so list reads need not scan every Epic record (src/share/scope.ts newestEpicImport).
export const NEWEST_IMPORT = 'urn:ga-server:ext:newest-epic-import';
export const LAST_SEEN = 'urn:ga-server:ext:last-seen';
// Medications, problems and allergies: the records the currency rule (src/current.ts) dates, and the only ones that carry LAST_SEEN.
export const DATED = new Set(['MedicationStatement', 'MedicationRequest', 'Condition', 'AllergyIntolerance']);
// The instant GA first stored a record; set on create only and kept by every later write.
export const ARRIVED = 'urn:ga-server:ext:arrived';
export const arrivedAt = (r: Resource): string | undefined => (r as Resource & { extension?: Extension[] }).extension?.find((e) => e.url === ARRIVED)?.valueInstant;

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export const APPLE = 'urn:ga-server:id:apple-health';
export const TAG = 'urn:ga-server:tag';
export const SRC_DATE = 'urn:ga-server:ext:source-date';
export const hasTag = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);
// From a hospital source (EHI export, C-CDA, portal sync). A PDF or photo does not say where a reading was taken.
export const isClinic = (r: Resource) => ['src-ehi', 'src-ccda', 'src-smart'].some((c) => hasTag(r, c));

// R4 types whose identifier is 0..1: the stable identifier replaces the source one (the source file keeps it).
export const SINGULAR_ID = new Set(['Composition', 'Bundle', 'QuestionnaireResponse']);

export const effective = (o: Observation): string | undefined => o.effectiveDateTime ?? o.effectivePeriod?.start;

function firstCode(o: Observation): string | undefined {
  const c = o.code?.coding?.[0];
  return c?.code ? `${c.system ?? ''}|${c.code}` : undefined;
}

export function contentKey(o: Observation): string | undefined {
  const code = firstCode(o);
  const day = effective(o)?.slice(0, 10);
  return code && day ? `${code}|${day}` : undefined;
}

// Same calendar day, read in a's own offset: 2024-03-01T19:30-05:00 and 2024-03-02T00:30Z are one day. A side without a time
// or offset compares as written.
export function sameDay(a: string, b: string): boolean {
  const off = /(Z|([+-])(\d\d):(\d\d))$/.exec(a);
  const t = Date.parse(b);
  if (a.length <= 10 || b.length <= 10 || !off || Number.isNaN(t)) return a.slice(0, 10) === b.slice(0, 10);
  const mins = off[1] === 'Z' ? 0 : (off[2] === '-' ? -1 : 1) * (Number(off[3]) * 60 + Number(off[4]));
  return new Date(t + mins * 60_000).toISOString().slice(0, 10) === a.slice(0, 10);
}

// JSON.stringify replacer: object keys in sorted order, so equal content stringifies equally.
export const sorted = (_k: string, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v;

// Content hash for identity: ignores id, meta, references (which point at per-document converter ids) and the in-process
// converter's narrative anchors (a "#id" each Epic export numbers anew: the same entry in two summaries must key alike).
// Patient-scoped resources (subject/patient) include the GA patient id, because identifier search is global.
// refs: a reference read as its target's own key (for a record that is its links); without it references are left out.
// shortcut: entries of one document that differ only in the narrative row their anchor points at now key alike (one record):
// id-less entries, an entry whose only name is its own text reference (not resolved into code.text), and Observations
// sharing a source id (keyed id + content hash). None in the owner's 8 documents (Task 12). Upgrade, if that
// case appears: key on the narrative text the anchor resolves to (convertCcdaLocal has the XML).
const NARRATIVE_REF = 'https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference';
export function contentHash(r: Resource, patientId = '', refs?: (ref: string) => string | undefined): string {
  const { id: _id, meta: _meta, ...rest } = r;
  const scope = 'subject' in r || 'patient' in r ? patientId : '';
  return sha256(`${r.resourceType}|${scope}|${JSON.stringify(rest, (k, v) => {
    if (k === 'reference') return refs && typeof v === 'string' ? refs(v) : undefined;
    if (k === 'extension' && Array.isArray(v)) { const kept = v.filter((e: { url?: string }) => e?.url !== NARRATIVE_REF); return kept.length ? kept : undefined; }
    return sorted(k, v);
  })}`);
}

const LINKED = new Set(['PractitionerRole', 'CareTeam']);
// Converter ids change between documents; the C-CDA entry <id> the converter copies into identifier[0] doesn't.
function ccdaKey(r: Resource, patientId: string, resolve?: (ref: string) => string | undefined): string {
  const src = [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat()[0];
  // A PractitionerRole or CareTeam is mostly its links (practitioner, organization, members): without them id-less ones hash
  // alike and merge into one. Each link reads as its target's own source key (resolve: the batch's converter id -> that key),
  // never a stored or converter id, so the key holds across imports even when a target is refused.
  if (!src?.value) return `${r.resourceType}|${contentHash(r, patientId, LINKED.has(r.resourceType) ? (resolve ?? (() => undefined)) : undefined)}`;
  const key = `${r.resourceType}|${src.system ?? ''}|${src.value}`;
  // Epic docs reuse one entry <id> for several different Observations within a single document, so an Observation's source id
  // alone is not unique. A visit is: the converter makes one Encounter per visit id in a document (an entry, the header's visit
  // and a panel's visit merge), so it is keyed by its id alone and documents merge into it (engine mergeCopies).
  return r.resourceType === 'Observation' ? `${key}|${contentHash(r, patientId)}` : key;
}

// Epic OIDs (any org root): the Epic-native ids C-CDA and EHI records share, used to link records across sources.
export const EPIC_OID = 'urn:oid:1.2.840.114350.';

const OWN_ID: Partial<Record<SourceInfo['kind'], { name: string; ok: (system: string) => boolean }>> = {
  ehi: { name: 'EHI', ok: (x) => x.startsWith('urn:ga-server:id:ehi:') },
  'apple-health': { name: 'Apple Health', ok: (x) => x === APPLE },
  smart: { name: 'SMART', ok: (x) => x.startsWith('urn:ga-server:id:smart:') },
};

export function stableIdentifier(r: Resource, s: SourceInfo, fileHash: string, patientId = '', resolve?: (ref: string) => string | undefined): Identifier {
  const own = OWN_ID[s.kind];
  if (own) {
    // EHI, Apple and SMART mappers put the GA identifier (urn:ga-server:id:ehi:<org> | <TABLE>|<pk>, APPLE, or
    // urn:ga-server:id:smart:<host> | <Type>/<id>) first.
    const id = [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat()[0];
    if (!id?.system || !own.ok(id.system) || !id.value) throw new GaError(`${r.resourceType} has no ${own.name} identifier`);
    return { system: id.system, value: id.value };
  }
  if (s.kind === 'ccda') return { system: 'urn:ga-server:id:ccda', value: ccdaKey(r, patientId, resolve) };
  let key: string;
  if (r.resourceType === 'Observation') {
    const o = r as Observation;
    const v = o.valueQuantity ? `${o.valueQuantity.value}|${o.valueQuantity.unit ?? ''}` : `${o.valueString ?? ''}|`;
    key = [fileHash, firstCode(o) ?? o.code?.text ?? '', effective(o) ?? '', v].join('|');
  } else {
    const { id: _id, meta: _meta, ...rest } = r;
    key = `${fileHash}|${r.resourceType}|${JSON.stringify(rest, sorted)}`;
  }
  return { system: 'urn:ga-server:id:pdf', value: sha256(key) };
}

export function stamp(r: Resource, s: SourceInfo, id: Identifier): Resource {
  const out = structuredClone(r) as Resource & { identifier?: Identifier[]; extension?: { url: string; valueDateTime?: string }[] };
  if (SINGULAR_ID.has(r.resourceType)) (out as { identifier?: unknown }).identifier = id;
  else if (!out.identifier?.some((i) => i.system === id.system && i.value === id.value)) out.identifier = [...(out.identifier ?? []), id];
  const meta = (out.meta ??= {});
  const codes = [`writer-${s.writer}`, `src-${s.kind}`, ...(s.llm ? ['extracted-by-llm'] : [])];
  const tags = (meta.tag ??= []);
  for (const code of codes) if (!tags.some((t) => t.system === TAG && t.code === code)) tags.push({ system: TAG, code });
  meta.source = s.file;
  out.extension = [
    ...(out.extension ?? []).filter((e) => e.url !== SRC_DATE && e.url !== LAST_SEEN),
    { url: SRC_DATE, valueDateTime: s.dateOf?.(r) ?? s.date },
    ...(s.seenAt && DATED.has(r.resourceType) ? [{ url: LAST_SEEN, valueDateTime: s.seenAt }] : []),
  ];
  return out;
}

// Same numbers in order, ignoring unit spelling: the value (or text value), then a panel's components. Two empty readings are not the same.
const nums = (o: Observation) => JSON.stringify([o.valueQuantity?.value ?? o.valueString, ...(o.component ?? []).map((c) => c.valueQuantity?.value)]);
export const sameNumbers = (a: Observation, b: Observation): boolean => nums(a) !== JSON.stringify([null]) && nums(a) === nums(b);
