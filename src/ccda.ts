import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Composition, Condition, Identifier, MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import { XMLParser } from 'fast-xml-parser';
import { convertCcdaToFhir, convertXmlToCcda, mapCcdaSystemToFhir, mapTimestampOrBooleanValue, nodeToPlainText, OBSERVATION_VALUE_CONTENT } from '../vendor/medplum-ccda/index.ts';
import { mapCcdaAllergyCategoryAndType } from '../vendor/medplum-ccda/systems.ts';
import * as OID from '../vendor/medplum-ccda/oids.ts';
import { sanitizeNullFlavors } from '../vendor/medplum-ccda/sanitize.ts';
import type { CcdaObservation, CcdaReference, CcdaSection, CcdaTemplateId, CcdaTimestampOrBoolean } from '../vendor/medplum-ccda/types.ts';
import { type GaConfig, GaError } from './config.ts';
import { RXNORM } from './concepts.ts';
import { addReport, importResources, type ImportReport, type NotImported } from './engine.ts';
import { withImportLock } from './lock.ts';
import { storeDocument } from './document.ts';

type X = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const norm = (s: string) => s.replace(/^urn:(oid|uuid):/i, '').toLowerCase();
const cdaKeys = (n: X): string[] =>
  arr(n.id as X | X[] | undefined)
    .filter((i) => i['@_root'] && !i['@_nullFlavor']) // nullFlavor/empty ids identify nothing
    .map((i) => (i['@_extension'] ? `${norm(String(i['@_root']))}|${i['@_extension']}` : norm(String(i['@_root']))));
const fhirKey = (i: Identifier): string | undefined =>
  !i.value ? undefined : i.system === 'urn:ietf:rfc:3986' ? norm(i.value) : `${norm(i.system ?? '')}|${i.value}`;

const attr = (n: unknown, k: string) => (n as X | undefined)?.[`@_${k}`] as string | undefined;
// Text of a narrative node (mixed content), whitespace collapsed.
const textOf = (n: unknown): string =>
  (typeof n === 'string' || typeof n === 'number' ? String(n)
    : Array.isArray(n) ? n.map(textOf).join(' ')
    : n && typeof n === 'object' ? Object.entries(n).filter(([k]) => !k.startsWith('@_')).map(([, v]) => textOf(v)).join(' ')
    : '').replace(/\s+/g, ' ').trim();

const RXNORM_OID = '2.16.840.1.113883.6.88';
type MedInfo = { name?: string; rxnorm?: string };

// Per source entry <id>: a substanceAdministration's (or its supply's) drug (narrative name, RxNorm).
function sourceInfo(xml: string) {
  const drug = new Map<string, MedInfo>();
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
  const walk = (o: X) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('@_')) continue;
      for (const c of arr(v)) {
        if (!c || typeof c !== 'object') continue;
        const n = c as X;
        if (k === 'substanceAdministration') {
          const info = drugInfo(n.consumable);
          for (const key of cdaKeys(n)) if ((info.name || info.rxnorm) && !drug.has(key)) drug.set(key, info);
          // Its supply orders and dispenses: their own product, else this drug.
          for (const s of arr(n.entryRelationship as X | X[] | undefined).flatMap((er) => arr(er.supply as X | X[] | undefined))) {
            const own = drugInfo(s.product);
            const sinfo = own.rxnorm && own.rxnorm !== info.rxnorm ? own : { name: info.name ?? own.name, rxnorm: info.rxnorm };
            for (const key of cdaKeys(s)) if ((sinfo.name || sinfo.rxnorm) && !drug.has(key)) drug.set(key, sinfo);
          }
        }
        walk(n);
      }
    }
  };
  walk(root);
  return { drug };
}


const lookup = <T>(m: Map<string, T>, r: Resource): T | undefined =>
  [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []]
    .flat()
    .map((i) => fhirKey(i))
    .map((k) => (k ? m.get(k) : undefined))
    .find((v) => v !== undefined);
const named = (c: CodeableConcept | undefined, info: MedInfo): CodeableConcept => {
  const coding = [...(c?.coding ?? [])];
  if (info.rxnorm && !coding.some((x) => x.system === RXNORM && x.code === info.rxnorm)) coding.push({ system: RXNORM, code: info.rxnorm, display: info.name });
  return { ...c, coding, text: info.name ?? c?.text };
};

// GA's own choices (not converter fixes): a drug named inline (or in a contained Medication) on a
// statement, order or dispense takes the narrative name and RxNorm; an INT value goes in valueQuantity, unitless (GA's readers: lab
// rows, content keys, duplicate checks read a number there).
function gaChoices(r: Resource, drug: Map<string, MedInfo>): Resource {
  const info = ['MedicationStatement', 'MedicationRequest', 'MedicationDispense'].includes(r.resourceType) && lookup(drug, r);
  if (info) {
    const m = r as MedicationStatement;
    if (m.medicationCodeableConcept) r = { ...m, medicationCodeableConcept: named(m.medicationCodeableConcept, info) } as Resource;
    if (m.contained) r = { ...r, contained: m.contained.map((c) => (c.resourceType === 'Medication' ? { ...c, code: named(c.code, info) } : c)) } as Resource;
  }
  if (r.resourceType === 'Observation' && (r as Observation).valueInteger !== undefined) {
    const { valueInteger, ...o } = r as Observation;
    return { ...o, valueQuantity: { value: valueInteger } } as Observation;
  }
  return r;
}

// GA's choices; converter fixes live in the library.
function localChoices(rs: Resource[], xml: string): Resource[] {
  const { drug } = sourceInfo(xml);
  return rs.map((r) => gaChoices(r, drug));
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

const isCcda = (xml: string) => /^﻿?\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<(?:\w+:)?ClinicalDocument[\s/>]/.test(xml);

export function ccdaFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const xmls = (readdirSync(path, { recursive: true }) as string[]).filter((f) => /\.xml$/i.test(f)).sort().map((f) => join(path, f));
  return xmls.filter((f) => {
    if (isCcda(readFileSync(f, 'utf8'))) return true;
    console.error(`skip ${basename(f)}: not a ClinicalDocument`);
    return false;
  });
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
const GENERIC_ALLERGY_TYPES = new Set(['418038007', '420134006']);
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
const NUMERIC = new Set(['PQ', 'REAL', 'INT']);
const root0 = (t: CcdaTemplateId[] | undefined) => t?.[0]?.['@_root'];
const hasTemplate = (n: { templateId?: CcdaTemplateId[] }, ...roots: string[]) => !!n.templateId?.some((t) => roots.includes(t['@_root']));
export const sectionName = (s: CcdaSection) => nodeToPlainText(s.title) || s.code?.['@_displayName'] || root0(s.templateId) || 'untitled';
// A medication's supply orders and dispenses (entryRelationship/supply) each become a record of their own.
const supplies = (s: CcdaSection) => (s.entry ?? []).flatMap((e) => e.substanceAdministration ?? []).flatMap((sa) => sa.entryRelationship ?? []).flatMap((er) => er.supply ?? []).length;
const statementCount = (s: CcdaSection) => (s.entry ?? []).flatMap((e) => STATEMENTS.flatMap((k) => arr((e as X)[k]))).length + supplies(s);

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
    // Payers: one Coverage per policy activity of a coverage act (none: the act produced no record).
    const payers = hasTemplate(s, OID.OID_PAYERS_SECTION, OID.OID_PAYERS_SECTION_V2);
    const policies = payers ? entries.flatMap((e) => e.act ?? []).map((a) => (a.entryRelationship ?? []).flatMap((er) => er.act ?? [])) : [];
    // Concern acts: one record per SUBJ observation (none: the act produced no record).
    const concerns = hasTemplate(s, ...CONCERN) ? entries.flatMap((e) => e.act ?? []).map((a) => (a.entryRelationship ?? []).filter((er) => er['@_typeCode'] === 'SUBJ').flatMap((er) => er.observation ?? []).length) : [];
    // An allergy observation's value is read only as the category and type it states (medplum#11308): a code stating neither is named,
    // except the type value set's two generic codes (propensity to adverse reaction(s)), which the PR's table maps to neither on purpose.
    if (hasTemplate(s, ...ALLERGIES)) {
      const subj = entries.flatMap((e) => e.act ?? []).flatMap((a) => (a.entryRelationship ?? []).filter((er) => er['@_typeCode'] === 'SUBJ')).flatMap((er) => er.observation ?? []);
      add(name, OID.OID_ALLERGY_OBSERVATION, subj.filter((o) => {
        const m = mapCcdaAllergyCategoryAndType(o.value);
        const code = (o.value as X | undefined)?.['@_code'] as string | undefined;
        return code && !GENERIC_ALLERGY_TYPES.has(code) && !m.category && !m.type;
      }).length, 'allergy type not converted');
    }
    const expected = statementCount(s) + [...policies.map((p) => p.length), ...concerns].reduce((n, k) => n + Math.max(0, k - 1), 0);
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
    // Organizer components: the library reads observations (care teams: their member acts, one participant per performer; result
    // organizers: also procedures, as Procedures reporting in the panel, and encounters, as the panel's visit).
    const careTeam = hasTemplate(s, OID.OID_CARE_TEAMS_SECTION);
    for (const org of entries.flatMap((e) => e.organizer ?? [])) {
      const read = careTeam ? ['act'] : hasTemplate(org, OID.OID_RESULT_ORGANIZER, OID.OID_RESULT_ORGANIZER_V2) ? ['observation', 'procedure', 'encounter'] : ['observation'];
      const other = (org.component ?? []).reduce((n, c) => n + STATEMENTS.filter((k) => !read.includes(k)).reduce((m, k) => m + arr((c as X)[k]).length, 0), 0);
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
      if (!o.code && !OBSERVATION_VALUE_CONTENT.some((k) => (o.value as X | undefined)?.[k] !== undefined)) {
        if (nested) add(name, root0(o.templateId), 1, 'observation without a code');
        return;
      }
      const type = o.value?.['@_xsi:type'];
      // A TS or BL value that does not parse (the library's own reader decides) is unread like an unknown type.
      const raw = (o.value as X | undefined)?.['@_value'] as string | undefined;
      // A number that does not parse: the library writes no value, never NaN.
      const unread = ((type === 'TS' || type === 'BL') && !Object.keys(mapTimestampOrBooleanValue(o.value as CcdaTimestampOrBoolean)).length) ||
        (NUMERIC.has(type ?? '') && raw !== undefined && !Number.isFinite(Number.parseFloat(raw)));
      if (type && (unread || (!VALUE_TYPES.has(type) && !(type === 'ED' && textED(o.value as CcdaReference))))) add(name, root0(o.templateId), 1, `${type} value not converted`);
      for (const er of o.entryRelationship ?? []) for (const c of er.observation ?? []) walk(c, true);
    };
    const family = (o: CcdaObservation) => {
      if (negated(o) || !Object.keys(o.value ?? {}).some((k) => k !== '@_xsi:type')) return add(name, root0(o.templateId), 1, 'family history observation not converted');
      const related = (o.entryRelationship ?? []).flatMap((er) => er.observation ?? []);
      const unread = related.filter((c) => negated(c) || !hasTemplate(c, ...FAMILY_DETAILS));
      add(name, root0(o.templateId), unread.length, 'family history detail not converted');
      // FHIR has one onset: an age at onset wins over the observation's own time.
      // Only an age with a number is an onset (processFamilyHistoryObservation reads it as a quantity); else the time is the onset.
      const aged = related.some((c) => !negated(c) && hasTemplate(c, OID.OID_AGE_OBSERVATION) && Number.isFinite(Number.parseFloat(attr(c.value, 'value') ?? '')));
      add(name, root0(o.templateId), aged && o.effectiveTime?.[0] ? 1 : 0, 'family history onset date not converted');
    };
    for (const e of entries) {
      for (const o of e.observation ?? []) walk(o, false);
      for (const org of e.organizer ?? []) {
        // FHIR has one deceased[x]: a death time beside deceasedInd="false" contradicts it and is kept out, so it is named.
        const person = org.subject?.relatedSubject?.subject;
        if (hasTemplate(org, OID.OID_FAMILY_HISTORY_ORGANIZER) && person?.['sdtc:deceasedInd']?.['@_value'] === 'false' && person['sdtc:deceasedTime']?.['@_value']) {
          add(name, root0(org.templateId), 1, 'family history death date not converted');
        }
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
  return { resources: localChoices(resources, xml), notImported };
}

// Sums rows of one section, template and reason (several documents of one import).
function addNotImported(total: NotImported[], rows: NotImported[]): NotImported[] {
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
  if (!files.length) return total;
  const notImported: NotImported[] = (total.notImported = []);
  return withImportLock(async () => {
    for (const file of files) {
      const xml = readFileSync(file, 'utf8');
      const converted = convertCcdaLocal(xml);
      const { fileHash } = await storeDocument(client, file, patientId, 'application/xml');
      const r = await importResources(client, converted.resources, { kind: 'ccda', file, org: custodian(xml), date: ccdaDate(xml), writer: 'importer' }, patientId, fileHash);
      addReport(total, r);
      addNotImported(notImported, converted.notImported);
    }
    return total;
  });
}
