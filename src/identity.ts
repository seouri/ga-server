import { createHash } from 'node:crypto';
import type { Identifier, Observation, Resource } from '@medplum/fhirtypes';

export type SourceInfo = {
  kind: 'ccda' | 'pdf';
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

const effective = (o: Observation): string | undefined => o.effectiveDateTime ?? o.effectivePeriod?.start;

function firstCode(o: Observation): string | undefined {
  const c = o.code?.coding?.[0];
  return c?.code ? `${c.system ?? ''}|${c.code}` : undefined;
}

export function contentKey(o: Observation): string | undefined {
  const code = firstCode(o);
  const day = effective(o)?.slice(0, 10);
  return code && day ? `${code}|${day}` : undefined;
}

export function stableIdentifier(r: Resource, s: SourceInfo, fileHash: string): Identifier {
  if (s.kind === 'ccda') return { system: 'urn:ga-server:id:ccda', value: r.id };
  let key: string;
  if (r.resourceType === 'Observation') {
    const o = r as Observation;
    const v = o.valueQuantity ? `${o.valueQuantity.value}|${o.valueQuantity.unit ?? ''}` : `${o.valueString ?? ''}|`;
    key = [fileHash, firstCode(o) ?? o.code?.text ?? '', effective(o) ?? '', v].join('|');
  } else {
    const { id: _id, meta: _meta, ...rest } = r;
    key = `${fileHash}|${r.resourceType}|${JSON.stringify(rest, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
    )}`;
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
