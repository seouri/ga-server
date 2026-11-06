// Medication currency rule (AGENTS.md "Hospital portals (SMART)"), also for problems and allergies.
import type { Endpoint, Resource } from '@medplum/fhirtypes';
import { LAST_SEEN, SRC_DATE, TAG } from './identity.ts';
import { LAST_SUCCESS, SOURCE_ID } from './smart/sync.ts';

export type Currency = 'current' | 'unconfirmed';
export type Ctx = { lastSuccess: Map<string, number>; newestImport: number };

const COVERED = new Set(['MedicationStatement', 'MedicationRequest', 'Condition', 'AllergyIntolerance']);
const SMART_ID = 'urn:ga-server:id:smart:';
const EPIC_TAGS = new Set(['src-ccda', 'src-ehi', 'src-smart']);

type R = Resource & { status?: string; clinicalStatus?: { coding?: { code?: string }[] } };
const extDate = (r: Resource, url: string): number | undefined => {
  const v = (r as { extension?: { url: string; valueDateTime?: string }[] }).extension?.find((e) => e.url === url)?.valueDateTime;
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

export function currencyContext(resources: Resource[], endpoints: Endpoint[]): Ctx {
  const lastSuccess = new Map<string, number>();
  let newestImport = -Infinity;
  for (const e of endpoints) {
    const t = extDate(e, LAST_SUCCESS);
    if (t === undefined) continue;
    const key = e.identifier?.find((i) => i.system === SOURCE_ID)?.value;
    if (key) lastSuccess.set(key, t);
    newestImport = Math.max(newestImport, t);
  }
  for (const r of resources) {
    if (!r.meta?.tag?.some((t) => t.system === TAG && t.code && EPIC_TAGS.has(t.code))) continue;
    newestImport = Math.max(newestImport, extDate(r, SRC_DATE) ?? -Infinity);
  }
  return { lastSuccess, newestImport };
}

export function currency(r: Resource, ctx: Ctx): Currency | undefined {
  if (!COVERED.has(r.resourceType)) return undefined;
  const a = r as R;
  if (a.status !== 'active' && !a.clinicalStatus?.coding?.some((c) => c.code === 'active')) return undefined;
  const seen = extDate(r, LAST_SEEN);
  if (seen !== undefined) {
    const keys = ((r as { identifier?: { system?: string; value?: string }[] }).identifier ?? [])
      .filter((i) => i.system?.startsWith(SMART_ID))
      .map((i) => i.system!.slice(SMART_ID.length));
    return keys.some((k) => ctx.lastSuccess.get(k) === seen) ? 'current' : 'unconfirmed';
  }
  const d = extDate(r, SRC_DATE);
  return d !== undefined && d < ctx.newestImport ? 'unconfirmed' : 'current';
}
