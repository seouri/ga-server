// What a share may show: the security core. Every share route and Ask tool reads only loadScoped's result.
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Endpoint, Patient, Resource } from '@medplum/fhirtypes';
import { GaError } from '../config.ts';
import { isActive } from '../current.ts';
import { TAG } from '../identity.ts';
import { SOURCE_ID, forPatient } from '../smart/sync.ts';
import type { Group, Share } from './store.ts';

export type Scoped = { patient: Patient; resources: Resource[]; support: Resource[]; endpoints: Endpoint[] };

const NEVER = new Set(['Endpoint', 'Provenance', 'AuditEvent', 'Patient']);
const ARCHIVES = new Set(['urn:ga-server:id:ehi-archive', 'urn:ga-server:id:apple-health-archive']);
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
  Composition: 'notes',
  Procedure: 'procedures',
  FamilyMemberHistory: 'family',
  Communication: 'messages',
};
const DATE_PATHS = [
  'effectiveDateTime', 'effectivePeriod.start', 'issued', 'occurrenceDateTime', 'performedDateTime', 'performedPeriod.start',
  'period.start', 'date', 'authoredOn', 'sent', 'authored', 'recordedDate', 'onsetDateTime', 'dateAsserted',
];
// Only these are followed from in-scope records, one hop; they are never searchable on their own.
const SUPPORT_REF = /^(Medication|Practitioner|Organization|Location|Binary)\/([^/]+)/;
// Attachment urls: Medplum may answer with a presigned /storage/<binary id>/... URL instead of Binary/<id>.
const BINARY_URL = /(?:^|\/)(?:Binary|storage)\/([0-9a-f-]{36})/;

type Any = Record<string, unknown>;
const hasCategory = (r: Resource, code: string): boolean =>
  ((r as { category?: { coding?: { code?: string }[] }[] }).category ?? []).some((c) => c.coding?.some((x) => x.code === code));

export function groupOf(r: Resource): Group | undefined {
  if (r.meta?.tag?.some((t) => t.system === TAG && t.code === 'src-apple-health')) return 'apple';
  if (r.resourceType === 'Observation') return hasCategory(r, 'laboratory') ? 'labs' : hasCategory(r, 'vital-signs') ? 'vitals' : undefined;
  return BY_TYPE[r.resourceType];
}

export function dateOf(r: Resource): string | undefined {
  for (const p of DATE_PATHS) {
    const v = p.split('.').reduce<unknown>((o, k) => (o as Any | undefined)?.[k], r);
    if (typeof v === 'string' && v) return v.slice(0, 10);
  }
  return undefined;
}

export const isStanding = (r: Resource): boolean => isActive(r);

const neverShared = (r: Resource): boolean =>
  NEVER.has(r.resourceType) ||
  (r.resourceType === 'DocumentReference' && !!r.identifier?.some((i) => i.system && ARCHIVES.has(i.system)));

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

// Pure part of loadScoped: compartment matches in, the share's records and the support refs they need out.
export function selectScoped(matches: Resource[], share: Share): { patient: Patient; resources: Resource[]; refs: string[] } {
  const p = matches.find((r): r is Patient => r.resourceType === 'Patient' && r.id === share.patientId);
  if (!p) throw new GaError(`share ${share.id}: patient ${share.patientId} not found`);
  const resources = matches.filter((r) => inScope(r, share));
  const refs = new Set<string>();
  for (const r of resources) supportRefs(r, refs);
  return { patient: trimPatient(p), resources, refs: [...refs] };
}

export async function loadScoped(client: MedplumClient, share: Share): Promise<Scoped> {
  const matches: Resource[] = [];
  const included = new Map<string, Resource>();
  let url: string | undefined = `fhir/R4/Patient/${share.patientId}/$everything?_count=1000`;
  while (url) {
    const b: Bundle = await client.get<Bundle>(url, { cache: 'no-cache' });
    for (const e of b.entry ?? []) {
      if (!e.resource) continue;
      if (e.search?.mode === 'match') matches.push(e.resource);
      else included.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
    }
    const next = b.link?.find((l) => l.relation === 'next')?.url;
    // Relative, so a next link carrying Medplum's own host still goes through the client's base URL.
    url = next ? (({ pathname, search }) => (pathname + search).replace(/^\//, ''))(new URL(next)) : undefined;
  }
  const { patient, resources, refs } = selectScoped(matches, share);
  const support: Resource[] = [];
  for (const ref of refs) {
    const [type, id] = ref.split('/');
    const r = included.get(ref) ?? (await client.readResource(type as 'Medication', id).catch(() => undefined));
    if (r) support.push(r);
  }
  const eps = await client.searchResources('Endpoint', { identifier: `${SOURCE_ID}|`, _count: '1000' }, { cache: 'no-cache' });
  return { patient, resources, support, endpoints: eps.filter(forPatient(share.patientId)) };
}

export function scopedCache(load: typeof loadScoped, ttlMs = 300_000): typeof loadScoped {
  const cache = new Map<string, { at: number; p: Promise<Scoped> }>();
  return (client, share) => {
    const hit = cache.get(share.id);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p;
    const p = load(client, share);
    cache.set(share.id, { at: Date.now(), p });
    p.catch(() => cache.get(share.id)?.p === p && cache.delete(share.id));
    return p;
  };
}
