// What a share shows: the summary, the per-group record rows and the FHIR bundle. Pure over Scoped.
import { basename } from 'node:path';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { currency, currencyContext, type Ctx } from '../current.ts';
import { hasTag } from '../identity.ts';
import { BINARY_URL, dateOf, groupOf, hasCategory, trimPatient } from './scope.ts';
import type { Scoped } from './scope.ts';

export type Item = { label: string; value?: string; date?: string; source?: string; note?: string; ref: string };
export type Summary = {
  patient: { name: string; birthDate?: string; gender?: string };
  problems: Item[]; medications: Item[]; allergies: Item[]; labs: Item[]; vitals: Item[]; immunizations: Item[]; apple: Item[];
};
export type Row = { group: string; items: Item[] };

type Any = Record<string, any>; // FHIR resources are read loosely here, every access is optional-chained.
const cc = (c?: Any): string | undefined => c?.text ?? c?.coding?.[0]?.display ?? c?.coding?.[0]?.code;
const codeKey = (r: Any): string => {
  const c = (r.code ?? r.medicationCodeableConcept ?? r.vaccineCode)?.coding?.[0];
  const t = cc(r.code);
  return c?.code ? `${c.system ?? ''}|${c.code}` : t ? `text|${t}` : `type|${r.resourceType}`;
};
const qty = (q?: Any): string | undefined => (q?.value === undefined ? undefined : [q.value, q.unit ?? q.code].filter((x) => x !== undefined).join(' '));
const val = (o: Any): string | undefined => qty(o.valueQuantity) ?? o.valueString ?? cc(o.valueCodeableConcept) ?? (o.valueBoolean === undefined ? undefined : String(o.valueBoolean)) ?? (o.valueInteger === undefined ? undefined : String(o.valueInteger));
const formatValue = (r: Resource): string | undefined => {
  const o = r as Any;
  const comps = (o.component ?? []).map((c: Any) => val(c)).filter(Boolean);
  return val(o) ?? (comps.length ? comps.join(' / ') : undefined);
};
const ref = (r: Resource): string => `${r.resourceType}/${r.id}`;

function toItem(r: Resource, s: Scoped, ctx: Ctx): Item {
  const o = r as Any;
  const med = o.medicationReference?.reference && s.support.find((x) => ref(x) === o.medicationReference.reference);
  const label = cc(o.code) ?? cc(o.medicationCodeableConcept) ?? cc(o.vaccineCode) ?? cc((med as Any)?.code) ?? o.medicationReference?.display
    ?? o.title ?? o.type?.[0]?.text ?? o.description ?? r.resourceType;
  const notes = [
    currency(r, ctx) === 'unconfirmed' && 'unconfirmed (not on the latest hospital list)',
    hasTag(r, 'extracted-by-llm') && 'read from a document by AI',
    hasTag(r, 'possible-duplicate') && 'possible duplicate',
  ].filter(Boolean);
  const source = r.meta?.source ? basename(r.meta.source) : undefined;
  return { label, value: formatValue(r), date: dateOf(r), source, note: notes.join('; ') || undefined, ref: ref(r) };
}

export const newestFirst = (a: Item, b: Item): number => (b.date ?? '').localeCompare(a.date ?? '');

export function summarize(s: Scoped): Summary {
  const ctx = currencyContext(s.resources, s.endpoints, s.newestImport);
  const item = (r: Resource): Item => toItem(r, s, ctx);
  const of = (pred: (r: Resource) => boolean): Resource[] => s.resources.filter(pred);
  const active = (r: Resource): boolean => currency(r, ctx) !== undefined;
  const latest = (rs: Resource[]): Item[] => {
    const best = new Map<string, Resource>();
    for (const r of rs) {
      const k = codeKey(r);
      if (k.startsWith('type|')) continue; // code-less: nothing to group by
      const cur = best.get(k);
      if (!cur || (dateOf(r) ?? '') > (dateOf(cur) ?? '')) best.set(k, r);
    }
    return [...best.values()].map(item).sort(newestFirst);
  };
  const p = trimPatient(s.patient);
  const n = p.name?.[0];
  const apple = new Map<string, Resource[]>();
  for (const r of of((x) => groupOf(x) === 'apple')) {
    const k = codeKey(r);
    const list = apple.get(k);
    if (list) list.push(r);
    else apple.set(k, [r]);
  }
  return {
    patient: { name: n?.text ?? [...(n?.given ?? []), n?.family].filter(Boolean).join(' '), birthDate: p.birthDate, gender: p.gender },
    problems: of((r) => r.resourceType === 'Condition' && active(r) && hasCategory(r, 'problem-list-item')).map(item),
    medications: of((r) => (r.resourceType === 'MedicationStatement' || r.resourceType === 'MedicationRequest') && active(r)).map(item),
    allergies: of((r) => r.resourceType === 'AllergyIntolerance' && active(r)).map(item),
    labs: latest(of((r) => r.resourceType === 'Observation' && groupOf(r) === 'labs')),
    vitals: latest(of((r) => r.resourceType === 'Observation' && groupOf(r) === 'vitals')),
    immunizations: of((r) => r.resourceType === 'Immunization' && (r as Any).status === 'completed').map(item).sort(newestFirst),
    // Apple readings are never listed one by one: one line per type.
    apple: [...apple.values()].map((rs) => {
      const dates = rs.map((r) => dateOf(r)).filter((d): d is string => !!d).sort();
      const last = rs.reduce((a, b) => ((dateOf(b) ?? '') > (dateOf(a) ?? '') ? b : a));
      const i = item(last);
      const v = i.value ? `${i.value}, latest; ` : '';
      return { ...i, value: `${v}${rs.length} readings, ${dates[0] ?? '?'} to ${dates.at(-1) ?? '?'}`, date: dates.at(-1), note: [i.note, 'home reading'].filter(Boolean).join('; ') };
    }),
  };
}

export function recordRows(s: Scoped): Row[] {
  const ctx = currencyContext(s.resources, s.endpoints, s.newestImport);
  const groups = new Map<string, Item[]>();
  for (const r of s.resources) {
    const g = groupOf(r) ?? 'other';
    if (g === 'apple') continue;
    const list = groups.get(g);
    if (list) list.push(toItem(r, s, ctx));
    else groups.set(g, [toItem(r, s, ctx)]);
  }
  return [...groups].map(([group, items]) => ({ group, items: items.sort(newestFirst) }));
}

// Attachment urls are useless outside: Medplum answers presigned storage URLs (a bearer link while valid), GA's store the
// relative Binary/<id> it was written with (stripped the same way; tests/share-export.test.ts covers both).
const dropStorageUrls = (r: Resource): Resource =>
  r.resourceType !== 'DocumentReference' || !r.content ? r : { ...r, content: r.content.map((c) => {
    if (!c.attachment?.url || !BINARY_URL.test(c.attachment.url)) return c;
    const { url: _, ...attachment } = c.attachment;
    return { ...c, attachment };
  }) };

export function toBundle(s: Scoped): Bundle {
  const clean = (r0: Resource): Resource => {
    const r = dropStorageUrls(r0);
    return r.meta?.source ? { ...r, meta: { ...r.meta, source: basename(r.meta.source) } } : r;
  };
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [trimPatient(s.patient), ...s.resources, ...s.support].map((r) => ({ resource: clean(r) })),
  };
}
