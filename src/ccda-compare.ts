import type { MedplumClient } from '@medplum/core';
import type { Composition, Identifier, Medication, Resource } from '@medplum/fhirtypes';
import { CVX_URL, convertXmlToCcda, mapFhirSystemToCcda } from '../vendor/medplum-ccda/index.ts';
import { sanitizeNullFlavors } from '../vendor/medplum-ccda/sanitize.ts';
import { addNotImported, convertCcdaLocal, convertCcdaMs, fhirKey, isCcda, sectionName, statementCount } from './ccda.ts';
import type { NotImported } from './engine.ts';

// `ga ccda compare`: each stored C-CDA document converted both ways, compared entry by entry. Read-only. The report holds
// counts, resource types, element paths, section names and template ids, never values.
export type Loss = { type: string; path: string; count: number; explained?: string };
export type CompareReport = { documents: number; skipped: number; failed: number; losses: Loss[]; gains: Record<string, number>; unaccounted: NotImported[]; notImported: NotImported[] };

type R = Record<string, unknown>;
// Classes matched across resource types (taking vs ordered; organizer as report vs panel): the type change is a loss at `resourceType`.
const FAMILY: Record<string, string> = { MedicationRequest: 'MedicationStatement', Observation: 'DiagnosticReport' };
const family = (t: string) => FAMILY[t] ?? t;

// One spelling per system: the library's own OID table both ways (http://loinc.org = urn:oid:2.16.840.1.113883.6.1). Except
// http://nucc.org/cvx, which GA's readers do not know (vaccines.ts, concept-apply.ts): kept apart so it shows as a loss (Task 8).
const system = (s?: string) => (!s || s === CVX_URL ? (s ?? '') : (mapFhirSystemToCcda(s) ?? s));
const idKey = (i: Identifier) => fhirKey(i.system === 'urn:ietf:rfc:3986' ? i : { ...i, system: system(i.system) });
const keys = (r: Resource): string[] =>
  [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat().map(idKey).filter((k): k is string => !!k);

const CODING = new Set(['system', 'version', 'code', 'display', 'userSelected', 'extension']);
const isCoding = (o: R) => typeof o.code === 'string' && Object.keys(o).every((k) => CODING.has(k));
const norm = (s: string) => s.replace(/^urn:(oid|uuid):/i, '').toLowerCase();
// AdministrativeGender: the library's own table maps the v3 OID to the FHIR system, whose codes spell the same genders out.
const GENDER_SYSTEM = '2.16.840.1.113883.5.1';
const GENDER: Record<string, string> = { M: 'male', F: 'female', UN: 'unknown' };
const codingKey = (o: R) => {
  const s = system(o.system as string).toLowerCase();
  return `${s}|${s === GENDER_SYSTEM ? (GENDER[o.code as string] ?? o.code) : o.code}`;
};
// Labels, present or not: a narrative div, and a display beside the code or reference that carries the identity. A display that
// is the element's only content (a Coding without code, a Reference without reference) is compared as text.
const PRESENCE = new Set(['display', 'div']);
const LABEL = '#display'; // key under which such a display is compared
// Elements holding a date, dateTime or instant (choice ones read as `start`): only these get the date-precision rule.
const DATED = /^(start|end|date|issued|authoredOn|recorded|asserted|lastOccurrence|\w+Date|\w+DateTime|\w+Instant)$/;
// Choice elements [x] (FHIR R4 prefixes and data types): one name whatever the type; a date or time reads as a Period's start.
const CHOICE = new RegExp(`^(value|effective|onset|abatement|occurrence|performed|medication|deceased|multipleBirth|asNeeded|serviced|timing|born|age|dose|rate|reported|product|item|answer|allowed|used|defaultValue|location|subject|scheduled|collected|fasting|substance|onBehalfOf)(${
  'Base64Binary|Boolean|Canonical|Code|Date|DateTime|Decimal|Id|Instant|Integer|Markdown|Oid|PositiveInt|String|Time|UnsignedInt|Uri|Url|Uuid|Address|Age|Annotation|Attachment|CodeableConcept|Coding|ContactPoint|Count|Distance|Duration|HumanName|Identifier|Money|Period|Quantity|Range|Ratio|Reference|SampledData|Signature|Timing|Dosage'})$`);
const TIME = new Set(['Date', 'DateTime', 'Instant']);

// The comparable form of a record: no id or meta; choice elements renamed `name[x]` (a dateTime as `name[x].start`, so it equals a
// Period's start; a choice Period that is one moment, end = start, as its start: the Microsoft path writes a panel's low = high so;
// its bornString is the raw CDA birth time, YYYYMMDD, read as that date). Unset keys are skipped: one never hides a set choice.
const CDA_DATE = /^(\d{4})(\d{2})?(\d{2})?$/;
function prep(n: unknown): unknown {
  if (Array.isArray(n)) return n.map(prep);
  if (!n || typeof n !== 'object') return n;
  const out: R = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'id' || k === 'meta' || v === undefined) continue;
    const m = CHOICE.exec(k);
    const moment = m?.[2] === 'Period' && !!v && (v as R).start !== undefined && (v as R).start === (v as R).end;
    const born = k === 'bornString' && typeof v === 'string' ? CDA_DATE.exec(v) : null;
    out[m ? `${m[1]}[x]` : k] = born ? { start: born.slice(1).filter(Boolean).join('-') } : m && TIME.has(m[2]) ? { start: v } : moment ? { start: (v as R).start } : prep(v);
  }
  return out;
}

const DATE = /^\d{4}(-\d{2}(-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?)?)?$/;
// Same meaning: numbers and booleans only as equal JSON values; strings equal after collapsing whitespace, or a date the new path
// gives as precisely or more (same year/month/day prefix, or the same instant in another zone).
function same(a: unknown, b: unknown, dated = false): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return a === b;
  const [x, y] = [a.replace(/\s+/g, ' ').trim(), b.replace(/\s+/g, ' ').trim()];
  return x === y || (dated && DATE.test(x) && DATE.test(y) && (y.startsWith(x) || (x.length > 10 && y.length > 10 && Date.parse(x) === Date.parse(y))));
}

// A reference's expected new target: the new counterpart of the old target; null when that has none; undefined when unknown
// (presence only). root: comparing the document Compositions (the root-id rule below).
type Ref = ((oldRef: string) => string | null | undefined) & { root?: boolean };

// Element paths (array indices dropped) the old value holds that the new one lacks or holds with another meaning; one per lost leaf.
// A Coding is one unit (system|code) and an Identifier one (its key); a reference must point at the new counterpart of its target.
function diff(o: unknown, n: unknown, path: string, key: string, ref: Ref, out: string[]): string[] {
  if (o === undefined || o === null || o === '') return out;
  if (Array.isArray(o)) return pair(o, n === undefined ? [] : [n].flat(), path, key, ref, out);
  const at = (k: string) => (path ? `${path}.${k}` : k);
  if (typeof o !== 'object') {
    // GA's repair writes status 'unknown' when the source has none: any new status holds as much, except entered-in-error.
    const any = PRESENCE.has(key) || (key === 'status' && o === 'unknown' && n !== 'entered-in-error');
    if (any ? n === undefined || n === '' : !same(o, n, DATED.test(key))) out.push(path);
    return out;
  }
  const a = o as R;
  const b = n && typeof n === 'object' && !Array.isArray(n) ? (n as R) : undefined;
  if (isCoding(a)) {
    if (!b || !isCoding(b) || codingKey(a) !== codingKey(b)) out.push(path);
    else for (const k of ['display', 'extension']) diff(a[k], b[k], at(k), k, ref, out);
    return out;
  }
  if (key === 'identifier') {
    // The Microsoft path gives the document id as {value: <root OID>} with no system: the same id as the new path's system.
    const root = ref.root && path === 'identifier' && !a.system && b?.system && same(norm(String(a.value)), norm(system(b.system as string)));
    if (!b || (idKey(a as Identifier) !== idKey(b as Identifier) && !root)) out.push(path);
    return out;
  }
  for (const [k, v] of Object.entries(a)) {
    if (k === 'reference' && typeof v === 'string') {
      const want = ref(v);
      if (typeof b?.reference !== 'string' || want === null || (want !== undefined && b.reference !== want)) out.push(at(k));
    } else diff(v, b?.[k], at(k), k === 'display' && typeof a.code !== 'string' && typeof a.reference !== 'string' ? LABEL : k, ref, out);
  }
  return out;
}

// Array elements paired one to one, each old element with the unused new one it loses least to (a different `code` loses most:
// it is the element's identity, as a component's); duplicates count; an old element left over loses all its leaves.
function pair(os: unknown[], ns: unknown[], path: string, key: string, ref: Ref, out: string[]): string[] {
  const used = new Set<number>();
  for (const o of os) {
    let best: string[] | undefined;
    let bi = -1;
    let bc = Infinity;
    for (let i = 0; i < ns.length && bc > 0; i++) {
      if (used.has(i)) continue;
      const l = diff(o, ns[i], path, key, ref, []);
      const c = l.length + (l.some((p) => p === `${path}.code` || p.startsWith(`${path}.code.`)) ? 1000 : 0);
      if (c < bc) [best, bi, bc] = [l, i, c];
    }
    if (bi >= 0) used.add(bi);
    out.push(...(best ?? diff(o, undefined, path, key, ref, [])));
  }
  return out;
}

const lenient: Ref = () => undefined;
const cost = (o: Resource, n: Resource) => diff(prep(o), prep(n), '', '', lenient, []).length;

// The Microsoft path names the drug in a Medication it points at: when that Medication holds nothing but its code, the code is the
// statement's medication[x], as the new path has it. A Medication with more (form, batch, ingredient) stays a record of its own.
function inlineMedications(rs: Resource[]): Resource[] {
  const meds = new Map(rs.filter((r) => r.resourceType === 'Medication' && Object.keys(r).every((k) => ['resourceType', 'id', 'meta', 'code'].includes(k)))
    .map((r) => [`Medication/${r.id}`, r as Medication]));
  const used = new Set<Resource>();
  const out = rs.map((r) => {
    const ref = (r as { medicationReference?: { reference?: string } }).medicationReference?.reference;
    const med = ref ? meds.get(ref) : undefined;
    if (!med) return r;
    used.add(med);
    const { medicationReference: _, ...rest } = r as unknown as R;
    return { ...rest, medicationCodeableConcept: med.code } as Resource;
  });
  return out.filter((r) => !used.has(r));
}

// Matching key for an id-less record: its codes (code, vaccine, drug) and names.
const sig = (r: Resource) => {
  const p = prep(r) as R & { code?: { coding?: R[] }; vaccineCode?: { coding?: R[] }; 'medication[x]'?: { coding?: R[] }; name?: unknown };
  const codes = [p.code, p.vaccineCode, p['medication[x]']].flatMap((c) => c?.coding ?? []).filter(isCoding).map(codingKey);
  const names = [p.name].flat().map((x) => (typeof x === 'string' ? x : (x as { family?: string } | undefined)?.family)).filter((x): x is string => !!x);
  return new Set([...codes, ...names]);
};

// Old record -> its new counterpart. 0) A document's one Composition pairs with the other's (the Microsoft path gives it
// no system, so no key matches). 1) The source CDA entry id: a new record of the same class sharing any identifier (the same
// resource type first, then the copy it loses least to: the new path repeats a practitioner per occurrence); several old records
// may share one. 2) Fallback for old records left over (the new path keeps no id on some entries: medications; Task 6):
// a new record of the same class with no identifier, sharing a code or name (any, when the old one has none), in document order, one to one.
export function matchEntries(old: Resource[], neu: Resource[]): Map<Resource, Resource | undefined> {
  const byKey = new Map<string, Resource[]>();
  for (const n of neu) for (const k of keys(n)) byKey.set(k, [...(byKey.get(k) ?? []), n]);
  const out = new Map<Resource, Resource | undefined>();
  const comps = [old, neu].map((rs) => rs.filter((r) => r.resourceType === 'Composition'));
  for (const o of old) {
    if (o.resourceType === 'Composition' && comps[0].length === 1 && comps[1].length === 1) {
      out.set(o, comps[1][0]);
      continue;
    }
    const hits = [...new Set(keys(o).flatMap((k) => byKey.get(k) ?? []))].filter((n) => family(n.resourceType) === family(o.resourceType) || fromDispense(o, n));
    const typed = hits.filter((n) => n.resourceType === o.resourceType);
    const pool = typed.length ? typed : hits;
    out.set(o, pool.length > 1 ? pool.reduce((x, y) => (cost(o, y) < cost(o, x) ? y : x)) : pool[0]);
  }
  const used = new Set(out.values());
  const idless = neu.filter((n) => !keys(n).length);
  for (const o of old) {
    if (out.get(o)) continue;
    const s = sig(o);
    const n = idless.find((c) => !used.has(c) && family(c.resourceType) === family(o.resourceType) && (!s.size || [...sig(c)].some((x) => s.has(x))));
    out.set(o, n);
    if (n) used.add(n);
  }
  return out;
}

// Explained only when an old record with no counterpart holds no information: an Observation holding nothing beyond these
// elements, with a code of text only (the Microsoft path's empty lab placeholders).
const PLACEHOLDER = 'no value and no code beyond text';
const PLACEHOLDER_KEYS = new Set(['resourceType', 'status', 'category', 'code', 'subject', 'identifier', 'effective[x]']);
const placeholder = (r: Resource) => {
  const p = prep(r) as R;
  return r.resourceType === 'Observation' && Object.keys(p).every((k) => PLACEHOLDER_KEYS.has(k)) && [undefined, 'final', 'unknown'].includes(p.status as string) && Object.keys((p.code as R | undefined) ?? {}).every((k) => k === 'text');
};

// One path equivalence: the Microsoft path files a Coverage's policy type (the Policy Activity code, e.g. PPO) under
// `relationship`; the new path under `type`, its FHIR field. The old `relationship` is compared as `type` only when the old
// record has no `type` and the new `type` carries every one of its codings (system|code); otherwise it stays a loss.
function policyType(o: Resource, n: Resource): Resource {
  const { relationship, ...rest } = o as unknown as R & { relationship?: { coding?: R[] } };
  const have = new Set(((n as unknown as { type?: { coding?: R[] } }).type?.coding ?? []).filter(isCoding).map(codingKey));
  const moved = o.resourceType === 'Coverage' && rest.type === undefined && !!relationship?.coding?.length && relationship.coding.every((c) => isCoding(c) && have.has(codingKey(c)));
  return moved ? ({ ...rest, type: relationship } as unknown as Resource) : o;
}

// One path equivalence: the Microsoft path makes a MedicationRequest from every supply in a medication, a Medication Dispense
// (22.4.18, EVN) too; the new path makes that one a MedicationDispense. The pair needs the same source id (no id-less fallback).
// The old record is read as a dispense: drug, status (the same statusCode in each type's word: active / in-progress, draft /
// preparation), quantity and the day (validityPeriod start or authoredOn as whenHandedOver); intent, an order's mood, is dropped.
// Its requester is the dispense's C-CDA author, which the new path keeps as a performer with function dataenterer: compared as
// that performer (the same practitioner, through the reference rule; another one, or a performer without the function, is a loss).
// Anything else it holds is compared as is.
const fromDispense = (o: Resource, n: Resource) => o.resourceType === 'MedicationRequest' && n.resourceType === 'MedicationDispense';
const DISPENSE_STATUS: Record<string, string> = { active: 'in-progress', draft: 'preparation' };
const DATA_ENTERER = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationdispense-performer-function', code: 'dataenterer' }] };
function asDispense(o: Resource, n: Resource): Resource {
  if (!fromDispense(o, n)) return o;
  const { resourceType: _t, intent: _i, status, dispenseRequest, authoredOn, requester, ...rest } = o as unknown as R & { status?: string; authoredOn?: string;
    dispenseRequest?: { quantity?: unknown; validityPeriod?: { start?: string } }; requester?: unknown };
  const { quantity, validityPeriod, ...more } = dispenseRequest ?? {};
  // The start is the day handed over; anything else in the period (an end) has no dispense field and stays a compared leaf.
  const { start: handed, ...period } = (validityPeriod ?? {}) as { start?: string };
  if (Object.keys(period).length) (more as R).validityPeriod = period;
  return { resourceType: 'MedicationDispense', ...rest, status: status && (DISPENSE_STATUS[status] ?? status), quantity,
    whenHandedOver: handed ?? authoredOn, ...(Object.keys(more).length && { dispenseRequest: more }),
    ...(requester ? { performer: [{ function: DATA_ENTERER, actor: requester }] } : {}) } as unknown as Resource;
}

// Reasons convertCcdaLocal gives for a section's own entries (the other rows name parts of entries).
const ENTRY_LEVEL = new Set(['section not supported by the converter', 'entry produced no record', 'section without template']);

export function compareCcda(xml: string, old: Resource[], neu: Resource[], notImported: NotImported[]): { losses: Loss[]; gains: Record<string, number>; unaccounted: NotImported[] } {
  const [o, n] = [inlineMedications(old), inlineMedications(neu)];
  const match = matchEntries(o, n);
  const losses = new Map<string, Loss>();
  const add = (type: string, path: string, explained?: string) => {
    const k = `${type}\0${path}\0${explained ?? ''}`;
    const l = losses.get(k) ?? { type, path, count: 0, ...(explained && { explained }) };
    l.count++;
    losses.set(k, l);
  };
  const byRef = new Map(o.map((r) => [`${r.resourceType}/${r.id}`, r]));
  const ref: Ref = (v) => {
    const t = byRef.get(v);
    if (!t) return undefined;
    const m = match.get(t);
    return m ? `${m.resourceType}/${m.id}` : null;
  };
  for (const [r, m] of match) {
    if (!m) add(r.resourceType, '(record)', placeholder(r) ? PLACEHOLDER : undefined);
    else for (const p of new Set(diff(prep(asDispense(policyType(r, m), m)), prep(m), '', '', r.resourceType === 'Composition' ? Object.assign((v: string) => ref(v), { root: true }) : ref, []))) add(r.resourceType, p);
  }
  // Gains: new records with no old counterpart, one per entity (the new path repeats a practitioner per occurrence).
  const matched = new Set(match.values());
  const seen = new Set([...matched].flatMap((m) => (m ? keys(m) : [])));
  const gains: Record<string, number> = {};
  for (const r of n) {
    const ks = keys(r);
    if (matched.has(r) || ks.some((k) => seen.has(k))) continue;
    for (const k of ks) seen.add(k);
    gains[r.resourceType] = (gains[r.resourceType] ?? 0) + 1;
  }
  // Accounting: each section's entries are records the Composition lists (and that exist) or named in notImported.
  const sections = (sanitizeNullFlavors(convertXmlToCcda(xml)).component?.structuredBody?.component ?? []).flatMap((c) => c.section ?? []);
  const comp = n.find((r): r is Composition => r.resourceType === 'Composition');
  const ids = new Set(n.map((r) => `${r.resourceType}/${r.id}`));
  const left = new Map<string, NotImported>();
  sections.forEach((s, i) => {
    const section = sectionName(s);
    const made = (comp?.section?.[i]?.entry ?? []).filter((e) => ids.has(e.reference ?? '')).length;
    const row = left.get(section) ?? { section, ...(s.templateId?.[0]?.['@_root'] && { templateId: s.templateId[0]['@_root'] }), entries: 0, reason: 'not imported and not named' };
    row.entries += statementCount(s) - made;
    left.set(section, row);
  });
  for (const r of notImported) if (ENTRY_LEVEL.has(r.reason) && left.has(r.section)) (left.get(r.section) as NotImported).entries -= r.entries;
  return { losses: [...losses.values()], gains, unaccounted: [...left.values()].filter((r) => r.entries > 0) };
}

export async function ccdaCompare(
  client: MedplumClient,
  patientId: string,
  converterUrl: string,
  convertMs: (xml: string, converterUrl: string) => Promise<Resource[]> = convertCcdaMs,
): Promise<CompareReport> {
  const report: CompareReport = { documents: 0, skipped: 0, failed: 0, losses: [], gains: {}, unaccounted: [], notImported: [] };
  const q = { subject: `Patient/${patientId}`, identifier: 'urn:ga-server:id:file|', contenttype: 'application/xml', _sort: '_lastUpdated', _count: '1000' };
  for await (const page of client.searchResourcePages('DocumentReference', q, { cache: 'no-cache' })) {
    for (const d of page) {
      const url = d.content?.[0]?.attachment?.url;
      const xml = url ? await (await client.download(url)).text() : '';
      if (!isCcda(xml)) {
        report.skipped++; // no file, or XML that is not a C-CDA
        continue;
      }
      const old = await convertMs(xml, converterUrl); // CONVERTER_DOWN when the Microsoft converter is not running
      report.documents++;
      let r: ReturnType<typeof compareCcda>;
      try {
        const local = convertCcdaLocal(xml);
        r = compareCcda(xml, old, local.resources, local.notImported);
        addNotImported(report.notImported, local.notImported);
      } catch {
        // Counted, never the message (it may quote the document). Every Microsoft record is a loss and the document is
        // unaccounted: a document the new path cannot convert or compare never passes the gate.
        report.failed++;
        const losses = new Map<string, Loss>();
        for (const x of old) {
          const l = losses.get(x.resourceType) ?? { type: x.resourceType, path: '(record)', count: 0 };
          l.count++;
          losses.set(x.resourceType, l);
        }
        r = { losses: [...losses.values()], gains: {}, unaccounted: [{ section: '(document)', entries: 1, reason: 'document could not be converted or compared' }] };
      }
      for (const l of r.losses) {
        const same = report.losses.find((x) => x.type === l.type && x.path === l.path && x.explained === l.explained);
        if (same) same.count += l.count;
        else report.losses.push({ ...l });
      }
      for (const [t, c] of Object.entries(r.gains)) report.gains[t] = (report.gains[t] ?? 0) + c;
      addNotImported(report.unaccounted, r.unaccounted);
    }
  }
  return report;
}
