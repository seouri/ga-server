// Fetch every patient-scoped resource a SMART FHIR R4 server offers, and map it for GA's import engine (no writes).
import type { Attachment, Bundle, CapabilityStatement, DocumentReference, Identifier, Resource } from '@medplum/fhirtypes';
import { GaError } from '../config.ts';
import { rtfToText } from '../ehi/rtf.ts';
import { COMPARTMENT } from '../engine.ts';
import { SINGULAR_ID } from '../identity.ts';
import type { SourceRec } from './store.ts';

export const OBS_CATEGORIES = ['laboratory', 'vital-signs', 'social-history', 'survey', 'exam', 'imaging', 'procedure', 'activity', 'therapy'];
const COND_CATEGORIES = ['problem-list-item', 'encounter-diagnosis', 'health-concern'];
const CATEGORIES: Record<string, string[]> = { Observation: OBS_CATEGORIES, Condition: COND_CATEGORIES };

// A PDF or image a DocumentReference points at. Task 5 uploads `data` with client.createBinary and replaces the
// attachment url equal to `ref` with `Binary/<new id>`. Never inlined: Medplum's max JSON size is 1 MB.
export type PendingBinary = { ref: string; contentType: string; data: Buffer };

type R = Resource & { identifier?: Identifier[] | Identifier };
const keyOf = (r: Resource): string => `${r.resourceType}/${r.id}`;

export async function fetchAll(
  fhirBase: string,
  token: string,
  patient: string,
  types?: string[],
): Promise<{ resources: Resource[]; byType: Record<string, number>; skipped: Record<string, string> }> {
  const base = fhirBase.replace(/\/+$/, '');
  const skipped: Record<string, string> = {};
  const got = new Map<string, Resource>(); // by Type/id: category searches overlap
  const add = (r: Resource) => r.id && !got.has(keyOf(r)) && got.set(keyOf(r), r);

  // The token goes only to URLs under the FHIR base. 401 and 5xx abort the fetch; other 4xx are the caller's to skip.
  const get = async (url: string, what: string, accept = 'application/fhir+json'): Promise<Response> => {
    const u = new URL(url, `${base}/`).href;
    if (!u.startsWith(`${base}/`)) throw new GaError(`${what}: URL outside the FHIR base`);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}`, accept }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 401 || r.status >= 500) throw new GaError(`${what}: HTTP ${r.status}`);
    return r;
  };
  const search = async (first: string, what: string): Promise<Resource[] | string> => {
    const out: Resource[] = [];
    const seen = new Set<string>();
    for (let url: string | undefined = first; url && !seen.has(url); ) {
      seen.add(url);
      if (!new URL(url, `${base}/`).href.startsWith(`${base}/`)) throw new GaError(`${what}: next link outside the FHIR base`);
      const r = await get(url, what);
      if (!r.ok) {
        await r.body?.cancel();
        return `HTTP ${r.status}`;
      }
      const b = (await r.json()) as Bundle;
      for (const e of b.entry ?? []) if (e.resource && e.search?.mode !== 'outcome' && e.resource.resourceType !== 'OperationOutcome') out.push(e.resource);
      url = b.link?.find((l) => l.relation === 'next')?.url;
    }
    return out;
  };

  const meta = await get(`${base}/metadata`, 'metadata');
  if (!meta.ok) throw new GaError(`metadata: HTTP ${meta.status}`);
  const cap = (await meta.json()) as CapabilityStatement;
  const offered = (cap.rest ?? [])
    .flatMap((x) => x.resource ?? [])
    .filter((x) => Object.hasOwn(COMPARTMENT, x.type) && x.interaction?.some((i) => i.code === 'search-type'))
    .map((x) => x.type)
    .filter((t) => !types || types.includes(t));

  const pr = await get(`${base}/Patient/${encodeURIComponent(patient)}`, 'Patient');
  if (!pr.ok) throw new GaError(`Patient: HTTP ${pr.status}`);
  add((await pr.json()) as Resource);

  for (const type of new Set(offered)) {
    const q = `${base}/${type}?patient=${encodeURIComponent(patient)}`;
    for (const cat of CATEGORIES[type] ?? [undefined]) {
      const what = cat ? `${type}:${cat}` : type;
      const res = await search(cat ? `${q}&category=${cat}` : q, what);
      if (typeof res === 'string') skipped[what] = res;
      else res.forEach(add);
    }
  }

  // Medications referenced by id: read them so their RxNorm coding comes along (the engine links Medication as shared).
  for (const r of [...got.values()]) {
    const ref = (r as { medicationReference?: { reference?: string } }).medicationReference?.reference;
    const m = ref && /^Medication\/[^/]+$/.exec(ref.startsWith(`${base}/`) ? ref.slice(base.length + 1) : ref)?.[0];
    if (!m || got.has(m)) continue;
    const res = await get(`${base}/${m}`, 'Medication');
    if (res.ok) add((await res.json()) as Resource);
    else {
      await res.body?.cancel();
      skipped.Medication = `HTTP ${res.status}`;
    }
  }

  // Note bodies: Binary/<id> attachments are fetched into attachment.data (base64); mapForGa decides what they become.
  for (const r of got.values()) {
    if (r.resourceType !== 'DocumentReference') continue;
    for (const { attachment: a } of (r as DocumentReference).content ?? []) {
      if (!a.url || a.data || !/(^|\/)Binary\/[^/]+$/.test(a.url) || !new URL(a.url, `${base}/`).href.startsWith(`${base}/Binary/`)) continue;
      const res = await get(a.url, 'Binary', a.contentType ?? '*/*');
      if (!res.ok) {
        await res.body?.cancel();
        skipped.Binary = `HTTP ${res.status}`;
        continue;
      }
      const type = res.headers.get('content-type') ?? '';
      const buf = Buffer.from(await res.arrayBuffer());
      // Some servers answer with a FHIR Binary resource whatever the Accept header says.
      const fhir = /json/.test(type) ? (JSON.parse(buf.toString('utf8')) as { resourceType?: string; data?: string; contentType?: string }) : undefined;
      if (fhir?.resourceType === 'Binary') {
        a.data = fhir.data;
        a.contentType ??= fhir.contentType;
      } else {
        a.data = buf.toString('base64');
        a.contentType ??= type || undefined;
      }
    }
  }

  const resources = [...got.values()];
  const byType: Record<string, number> = {};
  for (const r of resources) byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1;
  return { resources, byType, skipped };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const entity = (m: string, e: string): string => {
  const n = e[0] === '#' ? (e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NaN;
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
};

// Plain text of an HTML note: scripts, styles and head dropped, block ends become line breaks, entities decoded.
// shortcut: only the common named entities are decoded; upgrade if notes show others.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(br|p|div|li|tr|h[1-6]|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, entity)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// References outside the batch become display-only (or go), so nothing dangles. Empty arrays and objects left behind go too.
function fixRefs(v: unknown, keep: (ref: string) => string | undefined): unknown {
  if (Array.isArray(v)) {
    const out = v.map((x) => fixRefs(x, keep)).filter((x) => x !== undefined);
    return out.length || !v.length ? out : undefined;
  }
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (typeof o.reference === 'string') {
    const ref = keep(o.reference);
    if (ref) return { ...o, reference: ref };
    return typeof o.display === 'string' ? { display: o.display } : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    const y = fixRefs(x, keep);
    if (y !== undefined) out[k] = y;
  }
  return Object.keys(out).length || !Object.keys(o).length ? out : undefined;
}

// Resources from fetchAll, ready for importResources (kind 'smart'). Ids stay the server ids so batch references
// resolve; meta keeps only lastUpdated (the per-resource source date). PDFs and images come back as `binaries`.
export function mapForGa(rs: Resource[], src: SourceRec): { resources: Resource[]; binaries: PendingBinary[] } {
  const base = src.fhirBase.replace(/\/+$/, '');
  const system = `urn:ga-server:id:smart:${src.key}`;
  const inBatch = new Set(rs.map(keyOf));
  const keep = (ref: string): string | undefined => {
    if (ref.startsWith('#')) return ref;
    const local = (ref.startsWith(`${base}/`) ? ref.slice(base.length + 1) : ref).replace(/\/_history\/.*$/, '');
    return inBatch.has(local) ? local : undefined;
  };
  const binaries: PendingBinary[] = [];

  const note = (a: Attachment, ref: string): Attachment => {
    if (!a.data) return a.url && !/^[a-z][a-z0-9+.-]*:/i.test(a.url) ? { ...a, url: `${base}/${a.url}` } : a; // never a bare Binary/<server id>
    const type = (a.contentType ?? '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(a.data, 'base64');
    const text =
      type === 'text/html' ? htmlToText(buf.toString('utf8'))
      : type === 'text/rtf' || type === 'application/rtf' ? rtfToText(buf.toString('latin1'))
      : type === 'text/plain' ? buf.toString('utf8') // shortcut: assumes UTF-8; upgrade if a server sends another charset
      : undefined;
    const { data: _d, url: _u, size: _s, hash: _h, ...rest } = a;
    if (text === undefined) {
      binaries.push({ ref, contentType: a.contentType ?? 'application/octet-stream', data: buf });
      return { ...rest, url: ref };
    }
    return { ...rest, contentType: 'text/plain; charset=utf-8', data: Buffer.from(text, 'utf8').toString('base64'), title: `${a.title ?? 'Document'} (original: ${type})` };
  };

  const resources = rs.map((orig) => {
    const r = fixRefs(structuredClone(orig), keep) as R;
    const ours = { system, value: keyOf(orig) };
    if (SINGULAR_ID.has(r.resourceType)) r.identifier = ours;
    else r.identifier = [ours, ...[r.identifier ?? []].flat().filter((i) => i.system !== system)];
    const lastUpdated = orig.meta?.lastUpdated;
    if (lastUpdated) r.meta = { lastUpdated };
    else delete r.meta;
    if (r.resourceType === 'DocumentReference') {
      const d = r as DocumentReference;
      d.content = d.content.map((c, i) => ({ ...c, attachment: note(c.attachment, `urn:ga-server:pending-binary:${keyOf(orig)}/${i}`) }));
    }
    return r as Resource;
  });
  return { resources, binaries };
}
