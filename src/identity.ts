import { createHash } from 'node:crypto';
import type { Identifier, Observation, Resource } from '@medplum/fhirtypes';
import { GaError } from './config.ts';

export type SourceInfo = {
  kind: 'ccda' | 'pdf' | 'ehi';
  file: string;
  date: string;
  writer: 'importer' | 'agent';
  llm?: boolean;
};

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const TAG = 'urn:ga-server:tag';
const SRC_DATE = 'urn:ga-server:ext:source-date';

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

const sorted = (_k: string, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v;

// Content hash for identity: ignores id, meta and references (which point at per-document converter ids).
// Patient-scoped resources (subject/patient) include the GA patient id, because identifier search is global.
export function contentHash(r: Resource, patientId = ''): string {
  const { id: _id, meta: _meta, ...rest } = r;
  const scope = 'subject' in r || 'patient' in r ? patientId : '';
  return sha256(`${r.resourceType}|${scope}|${JSON.stringify(rest, (k, v) => (k === 'reference' ? undefined : sorted(k, v)))}`);
}

// Epic docs reuse one entry <id> for several different Observations/Encounters within a single document (real-data
// diagnostic: 32 Observation and 6 Encounter groups), so for these types the source id alone is not unique.
const SRC_ID_NOT_UNIQUE = new Set(['Observation', 'Encounter']);

// Converter ids change between documents; the C-CDA entry <id> the converter copies into identifier[0] doesn't.
function ccdaKey(r: Resource, patientId: string): string {
  const src = [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat()[0];
  if (!src?.value) return `${r.resourceType}|${contentHash(r, patientId)}`;
  const key = `${r.resourceType}|${src.system ?? ''}|${src.value}`;
  return SRC_ID_NOT_UNIQUE.has(r.resourceType) ? `${key}|${contentHash(r, patientId)}` : key;
}

// Epic OIDs (any org root): the Epic-native ids C-CDA and EHI records share, used to link records across sources.
export const EPIC_OID = 'urn:oid:1.2.840.114350.';

export function stableIdentifier(r: Resource, s: SourceInfo, fileHash: string, patientId = ''): Identifier {
  if (s.kind === 'ehi') {
    // EHI mappers put the GA identifier (urn:ga-server:id:ehi:<org> | <TABLE>|<pk>) first.
    const id = [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat()[0];
    if (!id?.system?.startsWith('urn:ga-server:id:ehi:') || !id.value) throw new GaError(`${r.resourceType} has no EHI identifier`);
    return { system: id.system, value: id.value };
  }
  if (s.kind === 'ccda') return { system: 'urn:ga-server:id:ccda', value: ccdaKey(r, patientId) };
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
  out.extension = [...(out.extension ?? []).filter((e) => e.url !== SRC_DATE), { url: SRC_DATE, valueDateTime: s.date }];
  return out;
}
