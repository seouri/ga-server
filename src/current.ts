// Medication currency rule (AGENTS.md "Hospital portals (SMART)"), also for problems and allergies.
import type { Endpoint, Resource } from '@medplum/fhirtypes';
import { LAST_SEEN, SRC_DATE, TAG } from './identity.ts';
import { LAST_SUCCESS, SOURCE_ID } from './smart/sync.ts';

type Currency = 'current' | 'unconfirmed';
export type Ctx = { lastSuccess: Map<string, number>; newestImport: number };

const COVERED = new Set(['MedicationStatement', 'MedicationRequest', 'Condition', 'AllergyIntolerance']);
export const SMART_ID = 'urn:ga-server:id:smart:';
export const EPIC_TAGS = new Set(['src-ccda', 'src-ehi', 'src-smart']);

type R = Resource & { status?: string; clinicalStatus?: { coding?: { code?: string }[] } };
const extDate = (r: Resource, url: string): number | undefined => {
  const v = (r as { extension?: { url: string; valueDateTime?: string }[] }).extension?.find((e) => e.url === url)?.valueDateTime;
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

// newestImport: when given (a share's whole-record value), it replaces the scan of `resources`, which may be a narrow slice.
export function currencyContext(resources: Resource[], endpoints: Endpoint[], newestImport = -Infinity): Ctx {
  const lastSuccess = new Map<string, number>();
  const scan = newestImport === -Infinity;
  for (const e of endpoints) {
    const t = extDate(e, LAST_SUCCESS);
    if (t === undefined) continue;
    const key = e.identifier?.find((i) => i.system === SOURCE_ID)?.value;
    if (key) lastSuccess.set(key, t);
    newestImport = Math.max(newestImport, t);
  }
  for (const r of scan ? resources : []) {
    if (!r.meta?.tag?.some((t) => t.system === TAG && t.code && EPIC_TAGS.has(t.code))) continue;
    newestImport = Math.max(newestImport, extDate(r, SRC_DATE) ?? -Infinity);
  }
  return { lastSuccess, newestImport };
}

// Active medication, problem or allergy: the records the currency rule covers.
export function isActive(r: Resource): boolean {
  const a = r as R;
  return COVERED.has(r.resourceType) && (a.status === 'active' || !!a.clinicalStatus?.coding?.some((c) => c.code === 'active'));
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// currency plus the reason in plain words.
export function explain(r: Resource, ctx: Ctx): { currency: Currency; reason: string } | undefined {
  if (!isActive(r)) return undefined;
  const seen = extDate(r, LAST_SEEN);
  if (seen !== undefined) {
    const keys = ((r as { identifier?: { system?: string; value?: string }[] }).identifier ?? [])
      .filter((i) => i.system?.startsWith(SMART_ID))
      .map((i) => i.system!.slice(SMART_ID.length));
    const k = keys.find((k) => ctx.lastSuccess.get(k) === seen);
    return k
      ? { currency: 'current', reason: `on the list at the latest ${k} portal sync` }
      : { currency: 'unconfirmed', reason: `the hospital portal stopped returning it (last returned ${day(seen)}); it may have been stopped` };
  }
  const d = extDate(r, SRC_DATE);
  return d !== undefined && d < ctx.newestImport
    ? { currency: 'unconfirmed', reason: `last listed ${day(d)}, before the newest hospital record (${day(ctx.newestImport)}); it may have been stopped` }
    : { currency: 'current', reason: 'no newer hospital record leaves it out' };
}

export const currency = (r: Resource, ctx: Ctx): Currency | undefined => explain(r, ctx)?.currency;
