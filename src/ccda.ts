import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, CodeableConcept, Composition, Condition, Encounter, Identifier, Medication, MedicationStatement, Resource } from '@medplum/fhirtypes';
import { XMLParser } from 'fast-xml-parser';
import { convertCcdaToFhir, convertXmlToCcda, mapCcdaSystemToFhir } from '../vendor/medplum-ccda/index.ts';
import * as OID from '../vendor/medplum-ccda/oids.ts';
import { sanitizeNullFlavors } from '../vendor/medplum-ccda/sanitize.ts';
import type { CcdaObservation, CcdaReference, CcdaSection, CcdaTemplateId } from '../vendor/medplum-ccda/types.ts';
import { type GaConfig, GaError, isGaNotRunning } from './config.ts';
import { RXNORM } from './concepts.ts';
import { addReport, importResources, type ImportReport, type NotImported } from './engine.ts';
import { TAG } from './identity.ts';
import { withImportLock } from './lock.ts';
import { storeDocument } from './document.ts';

export const CONVERTER_DOWN = 'the C-CDA converter is not running: start it with docker compose --profile ccda up -d fhir-converter';

export async function convertCcdaMs(xml: string, converterUrl: string): Promise<Resource[]> {
  let res: Response;
  try {
    res = await fetch(`${converterUrl}convertToFhir?api-version=2024-05-01-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ InputDataFormat: 'Ccda', RootTemplateName: 'CCD', InputDataString: xml }),
    });
  } catch (e) {
    // On demand (compose profile ccda): a refused connection is not "GA is not running".
    if (isGaNotRunning(e)) throw new GaError(CONVERTER_DOWN);
    throw e;
  }
  // Status only: the converter's error body can echo document content.
  if (!res.ok) throw new GaError(`converter failed: HTTP ${res.status}`);
  // Status only, also when the body is not the expected JSON: a parse error would quote it.
  const result = await res.json().then((b: { result?: Bundle }) => b?.result, () => undefined);
  if (result?.resourceType !== 'Bundle') throw new GaError(`converter failed: HTTP ${res.status}, unexpected response`);
  return repair((result.entry ?? []).map((e) => e.resource as Resource), xml);
}

type X = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const norm = (s: string) => s.replace(/^urn:(oid|uuid):/i, '').toLowerCase();
export const cdaKeys = (n: X): string[] =>
  arr(n.id as X | X[] | undefined)
    .filter((i) => i['@_root'] && !i['@_nullFlavor']) // nullFlavor/empty ids identify nothing
    .map((i) => (i['@_extension'] ? `${norm(String(i['@_root']))}|${i['@_extension']}` : norm(String(i['@_root']))));
export const fhirKey = (i: Identifier): string | undefined =>
  !i.value ? undefined : i.system === 'urn:ietf:rfc:3986' ? norm(i.value) : `${norm(i.system ?? '')}|${i.value}`;

const attr = (n: unknown, k: string) => (n as X | undefined)?.[`@_${k}`] as string | undefined;
// Problem Status observation (LOINC 33999-4) value, by SNOMED code or display name.
const PROBLEM_STATUS: Record<string, string> = {
  '55561003': 'active',
  '73425007': 'inactive',
  '413322009': 'resolved',
  active: 'active',
  inactive: 'inactive',
  resolved: 'resolved',
};
const ACT_STATUS: Record<string, string> = { active: 'active', completed: 'resolved', resolved: 'resolved' };

// R11 precedence: status observation > effectiveTime/high present > enclosing concern act statusCode.
function problemStatus(obs: X, act?: string): string | undefined {
  const statusObs = arr(obs.entryRelationship as X | X[] | undefined)
    .flatMap((er) => arr(er.observation as X | X[] | undefined))
    .find((o) => attr(o.code, 'code') === '33999-4');
  const v = statusObs?.value;
  const fromObs = PROBLEM_STATUS[attr(v, 'code') ?? ''] ?? PROBLEM_STATUS[(attr(v, 'displayName') ?? '').toLowerCase()];
  if (fromObs) return fromObs;
  if (attr((obs.effectiveTime as X | undefined)?.high, 'value')) return 'resolved';
  return ACT_STATUS[act ?? ''];
}

// Text of a narrative node (mixed content), whitespace collapsed.
const textOf = (n: unknown): string =>
  (typeof n === 'string' || typeof n === 'number' ? String(n)
    : Array.isArray(n) ? n.map(textOf).join(' ')
    : n && typeof n === 'object' ? Object.entries(n).filter(([k]) => !k.startsWith('@_')).map(([, v]) => textOf(v)).join(' ')
    : '').replace(/\s+/g, ' ').trim();

const RXNORM_OID = '2.16.840.1.113883.6.88';
const PROBLEM_SECTION = /^2\.16\.840\.1\.113883\.10\.20\.22\.2\.5(\.1)?$/;
type MedInfo = { name?: string; rxnorm?: string };

// Per source entry <id>: substanceAdministration status and drug (narrative name, RxNorm), and each observation's
// problem status (see problemStatus) and whether it sits in the Problems section (problem list) or elsewhere (visit diagnoses).
function sourceInfo(xml: string) {
  const med = new Map<string, string>();
  const drug = new Map<string, MedInfo>();
  const prob = new Map<string, string>();
  const problemList = new Map<string, boolean>();
  const narrative = new Map<string, string>();
  const root = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml) as X;
  const collect = (o: unknown) => {
    for (const c of arr(o as X | X[])) {
      if (!c || typeof c !== 'object') continue;
      const id = attr(c, 'ID');
      if (id && !narrative.has(id)) narrative.set(id, textOf(c));
      for (const [k, v] of Object.entries(c)) if (!k.startsWith('@_')) collect(v);
    }
  };
  collect(root);
  const walk = (o: X, act: string | undefined, inProblems: boolean) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('@_')) continue;
      for (const c of arr(v)) {
        if (!c || typeof c !== 'object') continue;
        const n = c as X;
        const code = attr(n.statusCode, 'code');
        const problems = k === 'section' ? arr(n.templateId as X | X[]).some((t) => PROBLEM_SECTION.test(attr(t, 'root') ?? '')) : inProblems;
        if (k === 'substanceAdministration') {
          const mat = ((n.consumable as X)?.manufacturedProduct as X)?.manufacturedMaterial as X | undefined;
          const mc = mat?.code as X | undefined;
          const ref = attr((mc?.originalText as X)?.reference, 'value')?.replace(/^#/, '');
          const info: MedInfo = {
            name: (ref && narrative.get(ref)) || attr(mc, 'displayName') || undefined,
            rxnorm: attr(mc, 'codeSystem') === RXNORM_OID ? attr(mc, 'code') : undefined,
          };
          for (const key of cdaKeys(n)) {
            if (code && !med.has(key)) med.set(key, code);
            if ((info.name || info.rxnorm) && !drug.has(key)) drug.set(key, info);
          }
        }
        if (k === 'observation') {
          const st = problemStatus(n, act);
          for (const key of cdaKeys(n)) {
            if (st && !prob.has(key)) prob.set(key, st);
            if (!problemList.has(key)) problemList.set(key, problems);
          }
        }
        walk(n, k === 'act' ? code : act, problems);
      }
    }
  };
  walk(root, undefined, false);
  return { med, drug, prob, problemList };
}

const MED_STATUS: Record<string, MedicationStatement['status']> = { active: 'active', completed: 'completed', aborted: 'stopped', suspended: 'on-hold' };
const cc = (system: string, code: string) => ({ coding: [{ system, code }] });
const CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category';

// Fixes converter template gaps from the source XML; only neutral values ('unknown') when the source has nothing.
// Drops the converter's DocumentReference: storeDocument keeps the original file.
export function repair(rs: Resource[], xml: string): Resource[] {
  const { med, drug, prob, problemList } = sourceInfo(xml);
  const lookup = <T>(m: Map<string, T>, r: Resource): T | undefined =>
    [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []]
      .flat()
      .map((i) => fhirKey(i))
      .map((k) => (k ? m.get(k) : undefined))
      .find((v) => v !== undefined);
  // The converter keeps only the NDC package code: name each Medication from its statement's source entry.
  const drugOf = new Map<string, MedInfo>();
  for (const r of rs) {
    const ref = r.resourceType === 'MedicationStatement' ? (r as MedicationStatement).medicationReference?.reference : undefined;
    const info = ref && lookup(drug, r);
    if (ref && info) drugOf.set(ref, info);
  }
  const named = (c: CodeableConcept | undefined, info: MedInfo): CodeableConcept => {
    const coding = [...(c?.coding ?? [])];
    if (info.rxnorm && !coding.some((x) => x.system === RXNORM && x.code === info.rxnorm)) coding.push({ system: RXNORM, code: info.rxnorm, display: info.name });
    return { ...c, coding, text: info.name ?? c?.text };
  };
  return rs
    .filter((r) => r.resourceType !== 'DocumentReference')
    .map((r) => {
      if (r.resourceType === 'Medication') {
        const info = drugOf.get(`Medication/${r.id}`);
        return info ? { ...r, code: named((r as Medication).code, info) } : r;
      }
      if (r.resourceType === 'MedicationStatement') {
        return { ...r, status: MED_STATUS[lookup(med, r) ?? ''] ?? (r.status || 'unknown') };
      }
      if (r.resourceType === 'Encounter') return { ...r, status: (r as Encounter).status || 'unknown' };
      if (r.resourceType === 'Condition') {
        const inList = lookup(problemList, r);
        if (inList !== undefined) r = { ...r, category: [cc(CATEGORY, inList ? 'problem-list-item' : 'encounter-diagnosis')] } as Condition;
        const s = lookup(prob, r);
        if (!s) return r;
        const clinicalStatus = cc('http://terminology.hl7.org/CodeSystem/condition-clinical', s);
        if (s !== 'resolved') return { ...r, clinicalStatus };
        return { ...r, clinicalStatus, verificationStatus: cc('http://terminology.hl7.org/CodeSystem/condition-ver-status', 'confirmed') };
      }
      return r;
    });
}

// Custodian organisation name, matched only inside its own element so a nameless custodian can never pick up a later (patient) <name>.
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const custodian = (xml: string): string | undefined => {
  const body = /<(?:\w+:)?representedCustodianOrganization\b[^>]*>([\s\S]*?)<\/(?:\w+:)?representedCustodianOrganization>/.exec(xml)?.[1];
  const name = body && /<(?:\w+:)?name\b[^>]*>([^<]*)<\/(?:\w+:)?name>/.exec(body)?.[1];
  try {
    return name?.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, d, h, n) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : (ENTITY[n] ?? m))).trim() || undefined;
  } catch {
    return undefined; // a code point out of range: the folder name keys the source instead
  }
};

// The header effectiveTime precedes any body effectiveTime in CDA, so the first match is the document's.
export function ccdaDate(xml: string): string {
  const m = xml.match(/<effectiveTime\s[^>]*?value="(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?([+-]\d{4})?"/);
  if (!m) throw new GaError('ClinicalDocument has no effectiveTime');
  const [, y, mo, d, h, mi, s, tz] = m;
  const day = `${y}-${mo}-${d}`;
  // FHIR dateTime with a time needs a zone; without one keep only the date.
  return h && tz ? `${day}T${h}:${mi}:${s ?? '00'}${tz.slice(0, 3)}:${tz.slice(3)}` : day;
}

export const isCcda = (xml: string) => /^﻿?\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<(?:\w+:)?ClinicalDocument[\s/>]/.test(xml);

export function ccdaFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const xmls = (readdirSync(path, { recursive: true }) as string[]).filter((f) => /\.xml$/i.test(f)).sort().map((f) => join(path, f));
  return xmls.filter((f) => {
    if (isCcda(readFileSync(f, 'utf8'))) return true;
    console.error(`skip ${basename(f)}: not a ClinicalDocument`);
    return false;
  });
}

// Marks the Composition of each in-process conversion, so its records never count as Microsoft-era ones (ccdaConverter).
const LOCAL_TAG = 'ccda-medplum';

// In process unless the record holds C-CDA records the Microsoft converter wrote: those keep their path until `ga ccda replace`
// (a mix would duplicate them). Each C-CDA import writes one Composition, so one search per import decides.
export async function ccdaConverter(cfg: Pick<GaConfig, 'patientId' | 'ccdaConverter'>, client: MedplumClient, patientId = cfg.patientId): Promise<'medplum' | 'microsoft'> {
  if (cfg.ccdaConverter) return cfg.ccdaConverter;
  // Also a Composition stored without a patient (engine.ts allows C-CDA records so): a miss here would duplicate the record.
  // Not scoped to this patient, so another patient's could match: that only keeps the Microsoft path, never risks a duplicate.
  for (const who of [{ subject: `Patient/${patientId}` }, { 'subject:missing': 'true' }]) {
    const old = await client.search('Composition', { ...who, _tag: `${TAG}|src-ccda`, '_tag:not': `${TAG}|${LOCAL_TAG}`, _count: '1' }, { cache: 'no-cache' });
    if (old.entry?.length) return 'microsoft';
  }
  return 'medplum';
}

// Clinical statements an entry may hold (CDA R2): each is one record or is named in notImported.
const STATEMENTS = ['act', 'encounter', 'observation', 'observationMedia', 'organizer', 'procedure', 'regionOfInterest', 'substanceAdministration', 'supply'];
// Observation value types the library converts (processVitalsObservation); any other is dropped with a console.warn.
const VALUE_TYPES = new Set(['PQ', 'CO', 'CD', 'CE', 'ST', 'INT']);
// An ED value the library reads (medplum#11242): text, inline or by narrative reference; binary ED (a PDF) has no value[x] type.
const textED = (v: CcdaReference) => (v['@_mediaType'] ?? 'text/plain').startsWith('text/') && (v['@_representation'] ?? 'TXT') === 'TXT';
const ENCOUNTER_DIAGNOSIS = '2.16.840.1.113883.10.20.22.4.80';
const NOT_VITALS = new Set(['2.16.840.1.113883.10.20.22.2.10', '2.16.840.1.113883.10.20.22.2.60', '2.16.840.1.113883.10.20.22.2.500']); // plan of care, goals, care teams
// Sections whose concern acts the library reads as one record from the first SUBJ observation only (processConditionAct, processAllergyIntoleranceAct).
const CONCERN = new Map<string, string>([
  ...[OID.OID_PROBLEMS_SECTION_ENTRIES_REQUIRED, OID.OID_PROBLEMS_SECTION_ENTRIES_OPTIONAL, OID.OID_PROBLEMS_SECTION_V2_ENTRIES_REQUIRED,
    OID.OID_PROBLEMS_SECTION_V2_ENTRIES_OPTIONAL, OID.OID_HEALTH_CONCERNS_SECTION].map((o): [string, string] => [o, 'problem']),
  ...[OID.OID_ALLERGIES_SECTION_ENTRIES_REQUIRED, OID.OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL, OID.OID_ALLERGIES_SECTION_ENTRIES_REQUIRED_V2,
    OID.OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL_V2].map((o): [string, string] => [o, 'allergy']),
]);
// A goal observation (by its template, in any section) is read by processGoalObservation, which keeps only these value types.
const GOAL_TEMPLATES = [OID.OID_GOALS_SECTION, OID.OID_GOAL_OBSERVATION];
const GOAL_VALUE_TYPES = new Set(['CD', 'ST']);
const root0 = (t: CcdaTemplateId[] | undefined) => t?.[0]?.['@_root'];
const hasTemplate = (n: { templateId?: CcdaTemplateId[] }, ...roots: string[]) => !!n.templateId?.some((t) => roots.includes(t['@_root']));
export const sectionName = (s: CcdaSection) => textOf(s.title) || s.code?.['@_displayName'] || root0(s.templateId) || 'untitled';
export const statementCount = (s: CcdaSection) => (s.entry ?? []).flatMap((e) => STATEMENTS.flatMap((k) => arr((e as X)[k]))).length;

// Converts in process with the vendored @medplum/ccda. Accounting: every section is on the Composition (its narrative); every
// entry with no record, visit diagnosis the converter drops, and observation value it cannot read is in notImported, with a reason.
export function convertCcdaLocal(xml: string): { resources: Resource[]; notImported: NotImported[] } {
  const ccda = sanitizeNullFlavors(convertXmlToCcda(xml)); // what the library reads: the same sections, in its order
  const sections = (ccda.component?.structuredBody?.component ?? []).flatMap((c) => c.section ?? []);
  // Unsupported sections are not silently skipped: they are accounted below.
  const resources = (convertCcdaToFhir(ccda, { ignoreUnsupportedSections: true }).entry ?? []).map((e) => e.resource as Resource);
  const byRef = new Map(resources.map((r) => [`${r.resourceType}/${r.id}`, r]));
  const comp = resources.find((r): r is Composition => r.resourceType === 'Composition');
  const notImported: NotImported[] = [];
  const add = (section: string, templateId: string | undefined, entries: number, reason: string) => {
    if (entries > 0) addNotImported(notImported, [{ section, ...(templateId && { templateId }), entries, reason }]);
  };
  sections.forEach((s: CcdaSection, i) => {
    const name = sectionName(s);
    const made = (comp?.section?.[i]?.entry ?? []).map((e) => byRef.get(e.reference ?? ''));
    const entries = s.entry ?? [];
    const statements = entries.flatMap((e) => STATEMENTS.flatMap((k) => (e as Record<string, unknown[] | undefined>)[k] ?? []));
    add(name, root0(s.templateId), statements.length - made.length, made.length ? 'entry produced no record' : 'section not supported by the converter');
    // Sections inside a section: the library reads neither their entries nor their narrative.
    const nested = (n: CcdaSection): void => {
      for (const c of arr((n as { component?: X | X[] }).component)) {
        for (const sub of arr(c.section as CcdaSection | CcdaSection[] | undefined)) {
          addNotImported(notImported, [{ section: name, ...(root0(sub.templateId) && { templateId: root0(sub.templateId) }), entries: sub.entry?.length ?? 0, reason: 'nested section not read' }]);
          nested(sub);
        }
      }
    };
    nested(s);
    // Visit diagnoses: the library reads only RSON observations on an encounter, not Epic's diagnosis acts (Task 5).
    const dx = entries.flatMap((e) => e.encounter ?? []).flatMap((enc) => enc.entryRelationship ?? []).flatMap((er) => er.act ?? []).filter((a) => hasTemplate(a, ENCOUNTER_DIAGNOSIS)).length;
    const linked = made.reduce((n, r) => n + (r?.resourceType === 'Encounter' ? ((r as Encounter).diagnosis?.length ?? 0) : 0), 0);
    add(name, ENCOUNTER_DIAGNOSIS, dx - linked, 'encounter diagnosis not converted');
    // Concern acts: only the first SUBJ observation becomes a record.
    const kind = s.templateId?.map((t) => CONCERN.get(t['@_root'])).find(Boolean);
    for (const act of kind ? entries.flatMap((e) => e.act ?? []) : []) {
      const subj = (act.entryRelationship ?? []).filter((er) => er['@_typeCode'] === 'SUBJ').flatMap((er) => er.observation ?? []).length;
      add(name, root0(act.templateId), subj - 1, `additional ${kind} in concern not converted`);
    }
    // Organizer components: the library reads only observations (care teams: their member acts, one participant per performer).
    const careTeam = hasTemplate(s, OID.OID_CARE_TEAMS_SECTION);
    for (const org of entries.flatMap((e) => e.organizer ?? [])) {
      const read = careTeam ? 'act' : 'observation';
      const other = (org.component ?? []).reduce((n, c) => n + STATEMENTS.filter((k) => k !== read).reduce((m, k) => m + arr((c as X)[k]).length, 0), 0);
      add(name, root0(org.templateId), other, 'organizer component not converted');
      if (careTeam) add(name, root0(org.templateId), (org.component ?? []).flatMap((c) => c.act ?? []).filter((a) => !a.performer?.length).length, 'care team member without performer');
    }
    // Observations the library reads as results (its "vitals" path), with their children: a missing code drops the record, an unread value type the value.
    if (hasTemplate(s, ...NOT_VITALS)) return;
    const walk = (o: CcdaObservation, nested: boolean) => {
      if (!nested && hasTemplate(o, ...GOAL_TEMPLATES)) {
        const type = o.value?.['@_xsi:type'];
        if (type && !GOAL_VALUE_TYPES.has(type)) add(name, root0(o.templateId), 1, `${type} value not converted`);
        return;
      }
      if (!o.code) {
        if (nested) add(name, root0(o.templateId), 1, 'observation without a code');
        return;
      }
      const type = o.value?.['@_xsi:type'];
      if (type && !VALUE_TYPES.has(type) && !(type === 'ED' && textED(o.value as CcdaReference))) add(name, root0(o.templateId), 1, `${type} value not converted`);
      for (const er of o.entryRelationship ?? []) for (const c of er.observation ?? []) walk(c, true);
    };
    for (const e of entries) {
      for (const o of e.observation ?? []) walk(o, false);
      for (const org of e.organizer ?? []) for (const c of org.component ?? []) for (const o of c.observation ?? []) walk(o, true);
    }
  });
  // Identity: the document id keys the Composition (the library gives it none), never converter-made content.
  const docId = ccda.id?.[0];
  if (comp && docId?.['@_root']) {
    const root = docId['@_root'];
    comp.identifier = docId['@_extension']
      ? { system: mapCcdaSystemToFhir(root), value: docId['@_extension'] }
      : { system: 'urn:ietf:rfc:3986', value: `urn:${/-/.test(root) ? 'uuid' : 'oid'}:${root}` };
  }
  if (comp) comp.meta = { ...comp.meta, tag: [...(comp.meta?.tag ?? []), { system: TAG, code: LOCAL_TAG }] };
  return { resources: repair(resources, xml), notImported };
}

// Sums rows of one section, template and reason (several documents of one import).
export function addNotImported(total: NotImported[], rows: NotImported[]): NotImported[] {
  for (const r of rows) {
    const same = total.find((t) => t.section === r.section && t.templateId === r.templateId && t.reason === r.reason);
    if (same) same.entries += r.entries;
    else total.push({ ...r });
  }
  return total;
}

export async function importPath(client: MedplumClient, cfg: GaConfig, path: string, patientId = cfg.patientId): Promise<ImportReport> {
  const total: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: [] };
  const files = ccdaFiles(path);
  // Decided once: this import's own records must not switch the path between its files.
  const local = files.length > 0 && (await ccdaConverter(cfg, client, patientId)) === 'medplum';
  if (local) total.notImported = [];
  for (const file of files) {
    const xml = readFileSync(file, 'utf8');
    const { resources, notImported } = local ? convertCcdaLocal(xml) : { resources: await convertCcdaMs(xml, cfg.converterUrl), notImported: undefined };
    const { fileHash } = await storeDocument(client, file, patientId, 'application/xml');
    const r = await withImportLock(() => importResources(client, resources, { kind: 'ccda', file, org: custodian(xml), date: ccdaDate(xml), writer: 'importer' }, patientId, fileHash));
    addReport(total, r);
    if (notImported && total.notImported) addNotImported(total.notImported, notImported);
  }
  return total;
}
