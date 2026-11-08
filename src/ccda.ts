import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, CodeableConcept, Composition, Condition, Encounter, Identifier, Medication, MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import { XMLParser } from 'fast-xml-parser';
import { convertCcdaToFhir, convertXmlToCcda, mapCcdaSystemToFhir, mapTimestampOrBooleanValue, nodeToPlainText } from '../vendor/medplum-ccda/index.ts';
import { mapCcdaAllergyCategoryAndType } from '../vendor/medplum-ccda/systems.ts';
import * as OID from '../vendor/medplum-ccda/oids.ts';
import { sanitizeNullFlavors } from '../vendor/medplum-ccda/sanitize.ts';
import type { CcdaObservation, CcdaReference, CcdaSection, CcdaTemplateId, CcdaTimestampOrBoolean } from '../vendor/medplum-ccda/types.ts';
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
  // Its whole-document DocumentReference is dropped: storeDocument keeps the original file.
  return repair((result.entry ?? []).map((e) => e.resource as Resource).filter((r) => r.resourceType !== 'DocumentReference'), xml);
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
  // A consumable's or supply product's drug: the narrative name its originalText points at (else displayName) and RxNorm.
  const drugInfo = (product: unknown): MedInfo => {
    const mc = (((product as X | undefined)?.manufacturedProduct as X)?.manufacturedMaterial as X | undefined)?.code as X | undefined;
    const ref = attr((mc?.originalText as X)?.reference, 'value')?.replace(/^#/, '');
    return {
      name: (ref && narrative.get(ref)) || attr(mc, 'displayName') || undefined,
      rxnorm: attr(mc, 'codeSystem') === RXNORM_OID ? attr(mc, 'code') : undefined,
    };
  };
  const walk = (o: X, act: string | undefined, inProblems: boolean) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('@_')) continue;
      for (const c of arr(v)) {
        if (!c || typeof c !== 'object') continue;
        const n = c as X;
        const code = attr(n.statusCode, 'code');
        const problems = k === 'section' ? arr(n.templateId as X | X[]).some((t) => PROBLEM_SECTION.test(attr(t, 'root') ?? '')) : inProblems;
        if (k === 'substanceAdministration') {
          const info = drugInfo(n.consumable);
          for (const key of cdaKeys(n)) {
            if (code && !med.has(key)) med.set(key, code);
            if ((info.name || info.rxnorm) && !drug.has(key)) drug.set(key, info);
          }
          // Its supply orders and dispenses: their own product, else this drug (the Microsoft path shares its Medication).
          for (const s of arr(n.entryRelationship as X | X[] | undefined).flatMap((er) => arr(er.supply as X | X[] | undefined))) {
            const own = drugInfo(s.product);
            const sinfo = own.rxnorm && own.rxnorm !== info.rxnorm ? own : { name: info.name ?? own.name, rxnorm: info.rxnorm };
            for (const key of cdaKeys(s)) if ((sinfo.name || sinfo.rxnorm) && !drug.has(key)) drug.set(key, sinfo);
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
  return rs.map((r) => {
    if (r.resourceType === 'Medication') {
      const info = drugOf.get(`Medication/${r.id}`);
      return info ? { ...r, code: named((r as Medication).code, info) } : r;
    }
    // The in-process path names the drug inline (or in a contained Medication) on statements, orders and dispenses: the same narrative name and RxNorm.
    const info = ['MedicationStatement', 'MedicationRequest', 'MedicationDispense'].includes(r.resourceType) && lookup(drug, r);
    if (info) {
      const m = r as MedicationStatement;
      if (m.medicationCodeableConcept) r = { ...m, medicationCodeableConcept: named(m.medicationCodeableConcept, info) } as Resource;
      if (m.contained) r = { ...r, contained: m.contained.map((c) => (c.resourceType === 'Medication' ? { ...c, code: named(c.code, info) } : c)) } as Resource;
    }
    if (r.resourceType === 'MedicationStatement') {
      return { ...r, status: MED_STATUS[lookup(med, r) ?? ''] ?? (r.status || 'unknown') };
    }
    if (r.resourceType === 'Encounter') return { ...r, status: (r as Encounter).status || 'unknown' };
    // GA's readers (lab rows, content keys, duplicate checks) read a number from valueQuantity: an INT value goes there, unitless, as on the Microsoft path.
    if (r.resourceType === 'Observation' && (r as Observation).valueInteger !== undefined) {
      const { valueInteger, ...o } = r as Observation;
      return { ...o, valueQuantity: { value: valueInteger } } as Observation;
    }
    if (r.resourceType === 'Condition') {
      // A Condition linked to its encounter is a visit diagnosis, also when its observation id repeats a problem-list one.
      const inList = (r as Condition).encounter ? false : lookup(problemList, r);
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
const VALUE_TYPES = new Set(['PQ', 'CO', 'CD', 'CE', 'ST', 'INT', 'REAL', 'TS', 'BL']);
// An ED value the library reads (medplum#11242): text, inline or by narrative reference; binary ED (a PDF) has no value[x] type.
const textED = (v: CcdaReference) => (v['@_mediaType'] ?? 'text/plain').startsWith('text/') && (v['@_representation'] ?? 'TXT') === 'TXT';
const ENCOUNTER_DIAGNOSIS = [OID.OID_ENCOUNTER_DIAGNOSIS, OID.OID_ENCOUNTER_DIAGNOSIS_V2];
// Sections whose concern acts the library reads as one record per SUBJ observation (processConditionAct, processAllergyIntoleranceAct).
const ALLERGIES = [OID.OID_ALLERGIES_SECTION_ENTRIES_REQUIRED, OID.OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL, OID.OID_ALLERGIES_SECTION_ENTRIES_REQUIRED_V2,
  OID.OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL_V2];
const CONCERN = [OID.OID_PROBLEMS_SECTION_ENTRIES_REQUIRED, OID.OID_PROBLEMS_SECTION_ENTRIES_OPTIONAL, OID.OID_PROBLEMS_SECTION_V2_ENTRIES_REQUIRED,
  OID.OID_PROBLEMS_SECTION_V2_ENTRIES_OPTIONAL, OID.OID_HEALTH_CONCERNS_SECTION, ...ALLERGIES];
// A goal observation (by its template, in any section, and every observation in the plan of care and goals sections) is read by
// processGoalObservation, which keeps only these value types and no child observation.
const GOAL_TEMPLATES = [OID.OID_GOALS_SECTION, OID.OID_GOAL_OBSERVATION];
const GOAL_VALUE_TYPES = new Set(['CD', 'ST']);
// A plan-of-care observation in these moods (not a goal template) is a planned test: a ServiceRequest with no value or child observation.
const PLANNED_MOODS = new Set(['INT', 'PRP', 'RQO', 'ARQ']);
// A family history observation is one condition of its FamilyMemberHistory: its coded value, with these related observations
// (age at onset, caused death); a negated one is none (medplum#11243).
const FAMILY_DETAILS = [OID.OID_AGE_OBSERVATION, OID.OID_FAMILY_HISTORY_DEATH_OBSERVATION];
const negated = (o: CcdaObservation) => o['@_negationInd'] === 'true';
// What makes an observation value say something (processVitalsObservation keeps an uncoded observation that has one).
const VALUED = ['@_value', '@_code', '@_displayName', '#text', 'reference', 'originalText'];
const root0 = (t: CcdaTemplateId[] | undefined) => t?.[0]?.['@_root'];
const hasTemplate = (n: { templateId?: CcdaTemplateId[] }, ...roots: string[]) => !!n.templateId?.some((t) => roots.includes(t['@_root']));
export const sectionName = (s: CcdaSection) => nodeToPlainText(s.title) || s.code?.['@_displayName'] || root0(s.templateId) || 'untitled';
// A medication's supply orders and dispenses (entryRelationship/supply) each become a record of their own.
const supplies = (s: CcdaSection) => (s.entry ?? []).flatMap((e) => e.substanceAdministration ?? []).flatMap((sa) => sa.entryRelationship ?? []).flatMap((er) => er.supply ?? []).length;
export const statementCount = (s: CcdaSection) => (s.entry ?? []).flatMap((e) => STATEMENTS.flatMap((k) => arr((e as X)[k]))).length + supplies(s);

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
    // Payers: one Coverage per policy activity of a coverage act (none: the act produced no record).
    const payers = hasTemplate(s, OID.OID_PAYERS_SECTION, OID.OID_PAYERS_SECTION_V2);
    const policies = payers ? entries.flatMap((e) => e.act ?? []).map((a) => (a.entryRelationship ?? []).flatMap((er) => er.act ?? [])) : [];
    // Concern acts: one record per SUBJ observation (none: the act produced no record).
    const concerns = hasTemplate(s, ...CONCERN) ? entries.flatMap((e) => e.act ?? []).map((a) => (a.entryRelationship ?? []).filter((er) => er['@_typeCode'] === 'SUBJ').flatMap((er) => er.observation ?? []).length) : [];
    // An allergy observation's value is read only as the category and type it states (medplum#11308): a code stating neither is named.
    if (hasTemplate(s, ...ALLERGIES)) {
      const subj = entries.flatMap((e) => e.act ?? []).flatMap((a) => (a.entryRelationship ?? []).filter((er) => er['@_typeCode'] === 'SUBJ')).flatMap((er) => er.observation ?? []);
      add(name, OID.OID_ALLERGY_OBSERVATION, subj.filter((o) => {
        const m = mapCcdaAllergyCategoryAndType(o.value);
        return (o.value as X | undefined)?.['@_code'] && !m.category && !m.type;
      }).length, 'allergy type not converted');
    }
    const expected = statements.length + supplies(s) + [...policies.map((p) => p.length), ...concerns].reduce((n, k) => n + Math.max(0, k - 1), 0);
    add(name, root0(s.templateId), expected - made.length, made.length ? 'entry produced no record' : 'section not supported by the converter');
    // The library keeps the payer, covered party and subscriber id; a guarantor and the policy holder's own details (name, address) have no Coverage field.
    for (const p of policies.flat()) {
      add(name, root0(p.templateId), (p.performer ?? []).filter((f) => hasTemplate(f, OID.OID_GUARANTOR_PERFORMER) || f.assignedEntity?.code?.['@_code'] === 'GUAR').length, 'guarantor not converted');
      const holder = (p.participant ?? []).find((x) => x['@_typeCode'] === 'HLD')?.participantRole;
      add(name, root0(p.templateId), holder?.playingEntity || holder?.addr?.length ? 1 : 0, 'policy holder details not converted');
    }
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
    // Visit diagnoses: each SUBJ observation of an encounter diagnosis act is a Condition pointing at its Encounter (any other observation is named).
    const dx = entries.flatMap((e) => e.encounter ?? []).flatMap((enc) => enc.entryRelationship ?? []).flatMap((er) => er.act ?? []).filter((a) => hasTemplate(a, ...ENCOUNTER_DIAGNOSIS))
      .flatMap((a) => (a.entryRelationship ?? []).flatMap((er) => er.observation ?? [])).length;
    const encounters = new Set(made.filter((r) => r?.resourceType === 'Encounter').map((r) => `Encounter/${r?.id}`));
    const linked = resources.filter((r) => r.resourceType === 'Condition' && encounters.has((r as Condition).encounter?.reference ?? '')).length;
    add(name, OID.OID_ENCOUNTER_DIAGNOSIS, dx - linked, 'encounter diagnosis not converted');
    // Organizer components: the library reads only observations (care teams: their member acts, one participant per performer).
    const careTeam = hasTemplate(s, OID.OID_CARE_TEAMS_SECTION);
    for (const org of entries.flatMap((e) => e.organizer ?? [])) {
      const read = careTeam ? 'act' : 'observation';
      const other = (org.component ?? []).reduce((n, c) => n + STATEMENTS.filter((k) => k !== read).reduce((m, k) => m + arr((c as X)[k]).length, 0), 0);
      add(name, root0(org.templateId), other, 'organizer component not converted');
      if (careTeam) add(name, root0(org.templateId), (org.component ?? []).flatMap((c) => c.act ?? []).filter((a) => !a.performer?.length).length, 'care team member without performer');
    }
    // Observations the library reads as results (its "vitals" path), with their children: a missing code drops the record, an unread value type the value.
    const goals = hasTemplate(s, OID.OID_PLAN_OF_CARE_SECTION, OID.OID_GOALS_SECTION);
    const walk = (o: CcdaObservation, nested: boolean) => {
      if (!nested && !hasTemplate(o, ...GOAL_TEMPLATES) && hasTemplate(s, OID.OID_PLAN_OF_CARE_SECTION) && PLANNED_MOODS.has(o['@_moodCode'])) {
        const type = o.value?.['@_xsi:type'];
        if (o.value) add(name, root0(o.templateId), 1, `${type ?? 'untyped'} value not converted`);
        add(name, root0(o.templateId), (o.entryRelationship ?? []).flatMap((er) => er.observation ?? []).length, 'observation in planned request not converted');
        return;
      }
      if (!nested && (goals || hasTemplate(o, ...GOAL_TEMPLATES))) {
        const type = o.value?.['@_xsi:type'];
        if (type && !GOAL_VALUE_TYPES.has(type)) add(name, root0(o.templateId), 1, `${type} value not converted`);
        add(name, root0(o.templateId), (o.entryRelationship ?? []).flatMap((er) => er.observation ?? []).length, 'observation in goal not converted');
        return;
      }
      // No code and no value: the library makes no record (a value alone is kept, its code data-absent).
      if (!o.code && !VALUED.some((k) => (o.value as X | undefined)?.[k] !== undefined)) {
        if (nested) add(name, root0(o.templateId), 1, 'observation without a code');
        return;
      }
      const type = o.value?.['@_xsi:type'];
      // A TS or BL value that does not parse (the library's own reader decides) is unread like an unknown type.
      const unread = (type === 'TS' || type === 'BL') && !Object.keys(mapTimestampOrBooleanValue(o.value as CcdaTimestampOrBoolean)).length;
      if (type && (unread || (!VALUE_TYPES.has(type) && !(type === 'ED' && textED(o.value as CcdaReference))))) add(name, root0(o.templateId), 1, `${type} value not converted`);
      for (const er of o.entryRelationship ?? []) for (const c of er.observation ?? []) walk(c, true);
    };
    const family = (o: CcdaObservation) => {
      if (negated(o) || !Object.keys(o.value ?? {}).some((k) => k !== '@_xsi:type')) return add(name, root0(o.templateId), 1, 'family history observation not converted');
      const related = (o.entryRelationship ?? []).flatMap((er) => er.observation ?? []);
      const unread = related.filter((c) => negated(c) || !hasTemplate(c, ...FAMILY_DETAILS));
      add(name, root0(o.templateId), unread.length, 'family history detail not converted');
      // FHIR has one onset: an age at onset wins over the observation's own time.
      const aged = related.some((c) => !negated(c) && hasTemplate(c, OID.OID_AGE_OBSERVATION));
      add(name, root0(o.templateId), aged && o.effectiveTime?.[0] ? 1 : 0, 'family history onset date not converted');
    };
    for (const e of entries) {
      for (const o of e.observation ?? []) walk(o, false);
      for (const org of e.organizer ?? []) {
        const read = hasTemplate(org, OID.OID_FAMILY_HISTORY_ORGANIZER) ? family : (o: CcdaObservation) => walk(o, true);
        for (const c of org.component ?? []) for (const o of c.observation ?? []) read(o);
      }
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
