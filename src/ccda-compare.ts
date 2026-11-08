import type { MedplumClient } from '@medplum/core';
import type { Composition, Identifier, Medication, Resource } from '@medplum/fhirtypes';
import { CVX_URL, convertXmlToCcda, mapFhirSystemToCcda } from '../vendor/medplum-ccda/index.ts';
import { sanitizeNullFlavors } from '../vendor/medplum-ccda/sanitize.ts';
import { addNotImported, convertCcdaLocal, convertCcdaMs, fhirKey, isCcda, sectionName, statementCount } from './ccda.ts';
import type { NotImported } from './engine.ts';

// `ga ccda compare`: each stored C-CDA document converted both ways, compared entry by entry. Read-only. The report holds
// counts, resource types, element paths, section names and template ids, never values.
export type Loss = { type: string; path: string; count: number; explained?: string };
export type CompareReport = { documents: number; failed: number; losses: Loss[]; gains: Record<string, number>; unaccounted: NotImported[]; notImported: NotImported[] };

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

const CODING = new Set(['system', 'version', 'code', 'display', 'userSelected']);
const PRESENCE = new Set(['reference', 'display', 'div']); // labels and links: present or not (the linked record is matched on its own)
const CHOICE = /^(value|effective|onset|abatement|occurrence|performed|medication|deceased|multipleBirth|asNeeded)(Quantity|CodeableConcept|Coding|String|Boolean|Integer|Range|Ratio|DateTime|Period|Time|Instant|Date|Age|Reference)$/;

// shortcut: paths drop array indices, so a value moved between elements of one array (e.g. two components swapping values) is
// not seen; compare per element if Task 9 shows such a case.
// Leaves as [element path, normalised value]. Paths drop array indices; a Coding is one leaf (system|code), an Identifier one leaf
// (its key), an extension is named by its url, a choice element is `name[x]` (a Period's start at `name[x]`, its end at `name[x].end`).
function leaves(node: unknown, path = '', key = '', out: [string, string][] = []): [string, string][] {
  if (Array.isArray(node)) {
    for (const n of node) leaves(n, path, key, out);
    return out;
  }
  if (node === undefined || node === null || node === '') return out;
  if (typeof node !== 'object') {
    out.push([path, PRESENCE.has(key) ? '*' : String(node).replace(/\s+/g, ' ').trim()]);
    return out;
  }
  const o = node as R;
  const at = (k: string) => (path ? `${path}.${k}` : k);
  if (typeof o.code === 'string' && Object.keys(o).every((k) => CODING.has(k))) {
    out.push([path, `${system(o.system as string).toLowerCase()}|${o.code}`]);
    if (o.display) out.push([at('display'), '*']);
    return out;
  }
  if (key === 'identifier') {
    const k = idKey(o as Identifier);
    if (k) out.push([path, k]);
    return out;
  }
  if ((key === 'extension' || key === 'modifierExtension') && typeof o.url === 'string') path = `${path}(${o.url})`;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'id' || k === 'meta' || (k === 'url' && path.endsWith(')'))) continue;
    const m = CHOICE.exec(k);
    if (m?.[2] === 'Period') {
      leaves((v as R).start, at(`${m[1]}[x]`), k, out);
      leaves((v as R).end, at(`${m[1]}[x].end`), k, out);
    } else leaves(v, at(m ? `${m[1]}[x]` : k), k, out);
  }
  return out;
}

const DATE = /^\d{4}(-\d{2}(-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?)?)?$/;
// Same meaning: equal; a date the new path gives as precisely or more (same day, or the same instant in another zone); an equal number.
const same = (a: string, b: string) =>
  a === b || a === '*' ||
  (DATE.test(a) && DATE.test(b) && (b.startsWith(a) || (a.length > 10 && b.length > 10 && Date.parse(a) === Date.parse(b)))) ||
  (/^-?[\d.]+$/.test(a) && Number(a) === Number(b));

// Element paths present in the old record that the new one lacks or holds with another meaning.
function lossPaths(old: Resource, neu: Resource): Set<string> {
  const have = new Map<string, string[]>();
  for (const [p, v] of leaves(neu)) have.set(p, [...(have.get(p) ?? []), v]);
  return new Set(leaves(old).filter(([p, v]) => !(have.get(p) ?? []).some((w) => same(v, w))).map(([p]) => p));
}

// The Microsoft path names the drug in a Medication it points at: its code is the statement's medication[x], as the new path has it.
function inlineMedications(rs: Resource[]): Resource[] {
  const meds = new Map(rs.filter((r) => r.resourceType === 'Medication').map((r) => [`Medication/${r.id}`, r as Medication]));
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
const SIG = new Set(['code.coding', 'vaccineCode.coding', 'medication[x].coding', 'name', 'name.family']);
const sig = (r: Resource) => new Set(leaves(r).filter(([p]) => SIG.has(p)).map(([, v]) => v));

// Old record -> its new counterpart. 1) The source CDA entry id: a new record of the same class sharing any identifier
// (the same resource type first); several old records may share one (shared practitioners). 2) Fallback for old records left
// over (the new path keeps no id on some entries: medications, allergies; Task 6): a new record of the same class with no
// identifier, sharing a code or name (any, when the old one has none), in document order, one to one.
export function matchEntries(old: Resource[], neu: Resource[]): Map<Resource, Resource | undefined> {
  const byKey = new Map<string, Resource[]>();
  for (const n of neu) for (const k of keys(n)) byKey.set(k, [...(byKey.get(k) ?? []), n]);
  const out = new Map<Resource, Resource | undefined>();
  for (const o of old) {
    const hits = keys(o).flatMap((k) => byKey.get(k) ?? []).filter((n) => family(n.resourceType) === family(o.resourceType));
    out.set(o, hits.find((n) => n.resourceType === o.resourceType) ?? hits[0]);
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

// Explained only when the old record holds no information: an Observation with no value, component or member, and no code beyond text.
const PLACEHOLDER = 'no value and no code beyond text';
const placeholder = (r: Resource) => {
  const o = r as unknown as R & { code?: { coding?: { code?: string }[] }; component?: unknown[]; hasMember?: unknown[] };
  return r.resourceType === 'Observation' && !Object.keys(o).some((k) => /^value[A-Z]/.test(k)) && !o.component?.length && !o.hasMember?.length && !o.code?.coding?.some((c) => c.code);
};

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
  for (const [r, m] of match) {
    const why = placeholder(r) ? PLACEHOLDER : undefined;
    if (!m) add(r.resourceType, '(record)', why);
    else for (const p of lossPaths(r, m)) add(r.resourceType, p, why);
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
  const report: CompareReport = { documents: 0, failed: 0, losses: [], gains: {}, unaccounted: [], notImported: [] };
  const q = { subject: `Patient/${patientId}`, identifier: 'urn:ga-server:id:file|', contenttype: 'application/xml', _sort: '_lastUpdated', _count: '1000' };
  for await (const page of client.searchResourcePages('DocumentReference', q, { cache: 'no-cache' })) {
    for (const d of page) {
      const url = d.content?.[0]?.attachment?.url;
      const xml = url ? await (await client.download(url)).text() : '';
      if (!isCcda(xml)) continue;
      const old = await convertMs(xml, converterUrl); // CONVERTER_DOWN when the Microsoft converter is not running
      let local: ReturnType<typeof convertCcdaLocal>;
      try {
        local = convertCcdaLocal(xml);
      } catch {
        // Counted, never the message (it may quote the document). Compared as an empty conversion, so every Microsoft record
        // is a loss and every entry unaccounted: a document the new path cannot convert never passes the gate.
        report.failed++;
        local = { resources: [], notImported: [] };
      }
      report.documents++;
      const r = compareCcda(xml, old, local.resources, local.notImported);
      for (const l of r.losses) {
        const same = report.losses.find((x) => x.type === l.type && x.path === l.path && x.explained === l.explained);
        if (same) same.count += l.count;
        else report.losses.push({ ...l });
      }
      for (const [t, c] of Object.entries(r.gains)) report.gains[t] = (report.gains[t] ?? 0) + c;
      addNotImported(report.unaccounted, r.unaccounted);
      addNotImported(report.notImported, local.notImported);
    }
  }
  return report;
}
