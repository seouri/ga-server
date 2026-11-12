// Medication currency rule (AGENTS.md "Hospital portals (SMART)"), also for problems and allergies.
import type { Endpoint, Resource } from '@medplum/fhirtypes';
import { DATED, LAST_SEEN, SRC_DATE, TAG } from './identity.ts';
import { ENABLED_TYPES, LAST_SUCCESS, SOURCE_ID } from './smart/sync.ts';

type Currency = 'current' | 'unconfirmed';
// newestImport: newest C-CDA or EHI import (every type). portal: per type, the newest sync of a portal with that type enabled.
export type Ctx = { lastSuccess: Map<string, number>; newestImport: number; portal: Map<string, number> };

const SMART_ID = 'urn:ga-server:id:smart:';
// Whole-record Epic imports. A portal sync raises the cutoff only for the types it syncs (Ctx.portal), never through its records.
export const EPIC_TAGS = new Set(['src-ccda', 'src-ehi', 'src-fhir-export']);
// A portal's medication list confirms (or not) medications of either type: C-CDA writes MedicationStatement, EHI and portals MedicationRequest.
const kind = (type: string) => (type === 'MedicationStatement' ? 'MedicationRequest' : type);

type R = Resource & { status?: string; clinicalStatus?: { coding?: { code?: string }[] }; verificationStatus?: { coding?: { code?: string }[] } };
const extDate = (r: Resource, url: string): number | undefined => {
  const v = (r as { extension?: { url: string; valueDateTime?: string }[] }).extension?.find((e) => e.url === url)?.valueDateTime;
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

// newestImport: when given (a share's whole-record value), it replaces the scan of `resources`, which may be a narrow slice.
export function currencyContext(resources: Resource[], endpoints: Endpoint[], newestImport = -Infinity): Ctx {
  const lastSuccess = new Map<string, number>();
  const portal = new Map<string, number>();
  const scan = newestImport === -Infinity;
  for (const e of endpoints) {
    const t = extDate(e, LAST_SUCCESS);
    if (t === undefined) continue;
    const key = e.identifier?.find((i) => i.system === SOURCE_ID)?.value;
    if (key) lastSuccess.set(key, t);
    for (const type of e.extension?.find((x) => x.url === ENABLED_TYPES)?.valueString?.split(',') ?? []) portal.set(kind(type), Math.max(portal.get(kind(type)) ?? -Infinity, t));
  }
  for (const r of scan ? resources : []) {
    if (!r.meta?.tag?.some((t) => t.system === TAG && t.code && EPIC_TAGS.has(t.code))) continue;
    newestImport = Math.max(newestImport, extDate(r, SRC_DATE) ?? -Infinity);
  }
  return { lastSuccess, newestImport, portal };
}

// A planned or proposed medication from a C-CDA Plan of Treatment (moodCode INT/PRP → intent plan/proposal): not something the
// patient takes yet. C-CDA only: a portal passes its own intent through, whose meaning is not verified.
const NOT_TAKEN = new Set(['plan', 'proposal']);
export const isPlanned = (r: Resource): boolean =>
  r.resourceType === 'MedicationRequest' && NOT_TAKEN.has(r.intent) && !!r.meta?.tag?.some((t) => t.system === TAG && t.code === 'src-ccda');
// Active medication, problem or allergy: the records the currency rule covers. A refuted or entered-in-error problem or allergy
// ("not allergic to penicillin") is never active, whatever its clinical status, from any source.
const NOT_SO = new Set(['refuted', 'entered-in-error']);
export function isActive(r: Resource): boolean {
  const a = r as R;
  if (isPlanned(r)) return false;
  if (a.verificationStatus?.coding?.some((c) => NOT_SO.has(c.code as string))) return false;
  return DATED.has(r.resourceType) && (a.status === 'active' || !!a.clinicalStatus?.coding?.some((c) => c.code === 'active'));
}

// The <key>s of a record's urn:ga-server:id:smart:<key> identifiers.
export const smartKeys = (r: Resource): string[] =>
  ((r as { identifier?: { system?: string }[] }).identifier ?? []).filter((i) => i.system?.startsWith(SMART_ID)).map((i) => i.system!.slice(SMART_ID.length));

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// currency plus the reason in plain words.
export function explain(r: Resource, ctx: Ctx): { currency: Currency; reason: string } | undefined {
  if (!isActive(r)) return undefined;
  const seen = extDate(r, LAST_SEEN);
  if (seen !== undefined) {
    // At or after: sync stamps records before it writes the Endpoint, so a sync dying in between leaves last-seen newer.
    const k = smartKeys(r).find((k) => (ctx.lastSuccess.get(k) ?? Infinity) <= seen);
    return k
      ? { currency: 'current', reason: `on the list at the latest ${k} portal sync` }
      : { currency: 'unconfirmed', reason: `the hospital portal stopped returning it (last returned ${day(seen)}); it may have been stopped` };
  }
  const d = extDate(r, SRC_DATE);
  const cutoff = Math.max(ctx.newestImport, ctx.portal.get(kind(r.resourceType)) ?? -Infinity);
  // Calendar days: a list exported hours before the import on the same day is not older.
  return d !== undefined && Number.isFinite(cutoff) && day(d) < day(cutoff)
    ? { currency: 'unconfirmed', reason: `last listed ${day(d)}, before the newest hospital record (${day(cutoff)}); it may have been stopped` }
    : { currency: 'current', reason: 'no newer hospital record leaves it out' };
}

export const currency = (r: Resource, ctx: Ctx): Currency | undefined => explain(r, ctx)?.currency;
