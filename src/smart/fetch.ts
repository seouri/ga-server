// Fetch every patient-scoped resource a SMART FHIR R4 server offers, and map it for GA's import engine (no writes).
import { createHash } from 'node:crypto';
import type { Attachment, Bundle, CapabilityStatement, DocumentReference, Identifier, Resource } from '@medplum/fhirtypes';
import { GaError } from '../config.ts';
import { rtfToText } from '../ehi/rtf.ts';
import { COMPARTMENT } from '../engine.ts';
import { SINGULAR_ID } from '../identity.ts';
import { walkReferences } from '../patient.ts';
import type { SourceRec } from './store.ts';

const CATEGORIES: Record<string, string[]> = {
  Observation: ['laboratory', 'vital-signs', 'social-history', 'survey', 'exam', 'imaging', 'procedure', 'activity', 'therapy'],
  Condition: ['problem-list-item', 'encounter-diagnosis', 'health-concern'],
};

// A PDF or image a DocumentReference points at; uploadBinaries (sync.ts) stores it. Never inlined: Medplum's max JSON size is 1 MB.
export type PendingBinary = { ref: string; contentType: string; data: Buffer };

type R = Resource & { identifier?: Identifier[] | Identifier };
const keyOf = (r: Resource): string => `${r.resourceType}/${r.id}`;
// Upper-case host, default port etc. normalised, so the outside-base check compares like with like.
const normBase = (u: string): string => new URL(u).href.replace(/\/+$/, '');

// Node's SyntaxError quotes the input: never let a note body reach an error message.
async function parse<T>(body: Response | string, what: string): Promise<T> {
  try {
    return JSON.parse(typeof body === 'string' ? body : await body.text()) as T;
  } catch {
    throw new GaError(`${what}: invalid JSON`);
  }
}

export async function fetchAll(
  fhirBase: string,
  token: string,
  patient: string,
  types?: string[],
): Promise<{ resources: Resource[]; byType: Record<string, number>; skipped: Record<string, string> }> {
  const base = normBase(fhirBase);
  const skipped: Record<string, string> = {};
  const failures: Record<string, number> = {};
  const fail = async (what: string, r: Response) => {
    await r.body?.cancel();
    failures[what] = (failures[what] ?? 0) + 1;
    skipped[what] = `${failures[what]} failed, last HTTP ${r.status}`;
  };
  const got = new Map<string, Resource>(); // by Type/id: category searches overlap
  const add = (r: Resource) => r.id && !got.has(keyOf(r)) && got.set(keyOf(r), r);

  // The token goes only to URLs under the FHIR base (or the base itself with a query: HAPI pages as <base>?_getpages=).
  const inside = (u: string): boolean => u.startsWith(`${base}/`) || u.startsWith(`${base}?`);
  // 401 and 5xx abort the fetch; other 4xx are the caller's to skip.
  const get = async (url: string, what: string, accept = 'application/fhir+json'): Promise<Response> => {
    const u = new URL(url, `${base}/`).href;
    if (!inside(u)) throw new GaError(`${what}: URL outside the FHIR base`);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}`, accept }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 401 || r.status >= 500) throw new GaError(`${what}: HTTP ${r.status}`);
    return r;
  };
  const search = async (first: string, what: string): Promise<Resource[] | string> => {
    const out: Resource[] = [];
    const seen = new Set<string>();
    for (let url: string | undefined = first; url && !seen.has(url); ) {
      seen.add(url);
      if (!inside(new URL(url, `${base}/`).href)) throw new GaError(`${what}: next link outside the FHIR base`);
      const r = await get(url, what);
      if (!r.ok) {
        await r.body?.cancel();
        return `HTTP ${r.status}`;
      }
      const b = await parse<Bundle>(r, what);
      for (const e of b.entry ?? []) if (e.resource && e.search?.mode !== 'outcome' && e.resource.resourceType !== 'OperationOutcome') out.push(e.resource);
      url = b.link?.find((l) => l.relation === 'next')?.url;
    }
    return out;
  };

  const meta = await get(`${base}/metadata`, 'metadata');
  if (!meta.ok) throw new GaError(`metadata: HTTP ${meta.status}`);
  const cap = await parse<CapabilityStatement>(meta, 'metadata');
  const offered = (cap.rest ?? [])
    .flatMap((x) => x.resource ?? [])
    .filter((x) => Object.hasOwn(COMPARTMENT, x.type) && x.interaction?.some((i) => i.code === 'search-type'))
    .map((x) => x.type)
    .filter((t) => !types || types.includes(t));

  const pr = await get(`${base}/Patient/${encodeURIComponent(patient)}`, 'Patient');
  if (!pr.ok) throw new GaError(`Patient: HTTP ${pr.status}`);
  add(await parse<Resource>(pr, 'Patient'));

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
    if (res.ok) add(await parse<Resource>(res, 'Medication'));
    else await fail('Medication', res);
  }

  // Note bodies: Binary/<id> attachments are fetched into attachment.data (base64); mapForGa decides what they become.
  for (const r of got.values()) {
    if (r.resourceType !== 'DocumentReference') continue;
    for (const { attachment: a } of (r as DocumentReference).content ?? []) {
      if (!a.url || a.data || !/(^|\/)Binary\/[^/]+$/.test(a.url) || !URL.canParse(a.url, `${base}/`) || !new URL(a.url, `${base}/`).href.startsWith(`${base}/Binary/`)) continue;
      const res = await get(a.url, 'Binary', a.contentType ?? '*/*');
      if (!res.ok) {
        await fail('Binary', res);
        continue;
      }
      const type = res.headers.get('content-type') ?? '';
      const buf = Buffer.from(await res.arrayBuffer());
      // Some servers answer with a FHIR Binary resource whatever the Accept header says.
      const fhir = /json/.test(type) ? await parse<{ resourceType?: string; data?: string; contentType?: string }>(buf.toString('utf8'), 'Binary') : undefined;
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
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
};

// Plain text of an HTML note: scripts, styles and head dropped, block ends become line breaks, entities decoded.
// shortcut: only the common named entities are decoded; upgrade if notes show others.
function htmlToText(html: string): string {
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
  const base = normBase(src.fhirBase);
  const system = `urn:ga-server:id:smart:${src.key}`;
  const inBatch = new Set(rs.map(keyOf));
  const keep = (ref: string): string | undefined => {
    if (ref.startsWith('#')) return ref;
    if (/^https?:/i.test(ref)) {
      try {
        ref = new URL(ref).href;
      } catch {
        return undefined; // malformed absolute reference: unresolvable, so display-only or dropped
      }
    }
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
    const { data: _d, url: _u, ...rest } = a;
    // hash (base64 SHA-1, as FHIR defines it) and size of the stored bytes: uploadBinaries reuses an existing Binary when the hash matches.
    const sum = (b: Buffer) => ({ size: b.length, hash: createHash('sha1').update(b).digest('base64') });
    if (text === undefined) {
      binaries.push({ ref, contentType: a.contentType ?? 'application/octet-stream', data: buf });
      return { ...rest, url: ref, ...sum(buf) };
    }
    const out = Buffer.from(text, 'utf8');
    return { ...rest, contentType: 'text/plain; charset=utf-8', data: out.toString('base64'), ...sum(out), title: `${a.title ?? 'Document'} (original: ${type})` };
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
  return { resources: breakCycles(resources), binaries };
}

// Parent types: their references down to children (Encounter.diagnosis.condition, reasonReference) are the ones given up
// when a cycle forms, so child -> parent references (Condition.encounter, Observation.encounter) survive.
const PARENT = new Set(['Encounter', 'EpisodeOfCare']);

// The engine refuses a batch with a reference cycle (topoSort), so break each one: references are already Type/id here.
// Pass 1 keeps child -> parent edges, dropping DFS back-edges among them; pass 2 adds parent -> child edges one by one,
// each only if it closes no cycle. A broken reference becomes display-only (or goes) as for one outside the batch.
function breakCycles(rs: Resource[]): Resource[] {
  const byKey = new Map(rs.map((r) => [keyOf(r), r]));
  const out = new Map<string, Set<string>>(rs.map((r) => [keyOf(r), new Set<string>()])); // kept edges
  const broken = new Map<string, Set<string>>();
  const later: [string, string][] = [];
  const brk = (from: string, to: string) => broken.set(from, (broken.get(from) ?? new Set()).add(to));
  const edges = (r: Resource): string[] => {
    const to = new Set<string>();
    walkReferences(r, (ref) => void (byKey.has(ref) && ref !== keyOf(r) && to.add(ref)));
    return [...to];
  };
  const pending = new Map<string, string[]>();
  for (const r of rs) {
    const e = edges(r);
    if (PARENT.has(r.resourceType)) e.forEach((to) => later.push([keyOf(r), to]));
    else pending.set(keyOf(r), e);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (k: string) => {
    state.set(k, 'visiting');
    for (const to of pending.get(k) ?? []) {
      if (state.get(to) === 'visiting') brk(k, to);
      else {
        out.get(k)?.add(to);
        if (!state.has(to)) visit(to);
      }
    }
    state.set(k, 'done');
  };
  for (const k of pending.keys()) if (!state.has(k)) visit(k);
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const k = stack.pop() as string;
      if (k === target) return true;
      for (const n of out.get(k) ?? []) if (!seen.has(n)) seen.add(n) && stack.push(n);
    }
    return false;
  };
  for (const [from, to] of later) {
    if (reaches(to, from)) brk(from, to);
    else out.get(from)?.add(to);
  }
  return rs.map((r) => {
    const b = broken.get(keyOf(r));
    return b ? (fixRefs(r, (ref) => (b.has(ref) ? undefined : ref)) as Resource) : r;
  });
}
