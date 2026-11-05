import type { MedplumClient } from '@medplum/core';
import type {
  CodeableConcept, FamilyMemberHistory, FamilyMemberHistoryCondition, Identifier, Immunization, Observation, Procedure, QuestionnaireResponse,
  Resource,
} from '@medplum/fhirtypes';
import { DUP_OF, TAG } from '../engine.ts';
import { EPIC_OID } from '../identity.ts';
import { ehiDate } from './dates.ts';
import { type EhiCtx, ehiId, encounterRef, epicId, localId, PATIENT_REF } from './ids.ts';
import type { EhiTables, Row } from './read.ts';

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const NUM = /^-?\d+(\.\d+)?$/;
const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const category = (code: string): CodeableConcept[] => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }] }];
const byLine = (a: Row, b: Row) => Number(a.LINE) - Number(b.LINE);

function immStatus(s: string | undefined): Immunization['status'] {
  if (/error|delet/i.test(s ?? '')) return 'entered-in-error';
  if (/not given|refus|declin/i.test(s ?? '')) return 'not-done';
  return 'completed'; // the tables hold administrations; every real row is "Given"
}

type ImmFields = { name: string; date: string; status?: string; ndc?: string; mfg?: string; lot?: string; exp?: string; site?: string; route?: string; amount?: string; unit?: string };
const immBody = (f: ImmFields, ctx: EhiCtx) => {
  const expirationDate = ehiDate(f.exp ?? '', ctx);
  return {
    resourceType: 'Immunization' as const,
    status: immStatus(f.status),
    vaccineCode: { text: f.name, ...(f.ndc && { coding: [{ system: 'http://hl7.org/fhir/sid/ndc', code: f.ndc }] }) },
    patient: PATIENT_REF,
    occurrenceDateTime: f.date,
    ...(f.mfg && { manufacturer: { display: f.mfg } }),
    ...(f.lot && { lotNumber: f.lot }),
    ...(expirationDate && { expirationDate: expirationDate.slice(0, 10) }),
    ...(f.site && { site: { text: f.site } }),
    ...(f.route && { route: { text: f.route } }),
    ...(NUM.test(f.amount ?? '') && { doseQuantity: { value: Number(f.amount), ...(f.unit && { unit: f.unit }) } }),
  };
};

// R15: IMMUNE is the immunization record (its ids are the C-CDA's). IMM_ADMIN is a document re-listing the history at each
// contact; its vaccine+date pairs that IMMUNE lacks become records keyed by name and date (no Epic id exists for them).
// R18: such a pair on the date of an IMMUNE dose with the same lot number is that dose (not created, counted); with
// another or no lot it is created as a possible duplicate of that date's IMMUNE dose(s), engine tag and extension.
// A row without a vaccine name or date says nothing: skipped, counted.
export function mapImmunizations(t: EhiTables, ctx: EhiCtx, counts = { skippedNoName: 0, immAdminSameDose: 0, immAdminPossibleDuplicate: 0 }): Resource[] {
  const enc = encounterRef(t);
  const out: Immunization[] = [];
  const seen = new Set<string>();
  for (const r of t.rows('IMMUNE')) {
    const name = r.IMMUNZATN_ID_NAME;
    const date = ehiDate(r.IMMUNE_DATE, ctx);
    if (!name || !date) {
      counts.skippedNoName++;
      continue;
    }
    seen.add(`${norm(name)}|${date.slice(0, 10)}`);
    const encounter = enc(r.IMM_CSN);
    const b = immBody({ name, date, status: r.IMMNZTN_STATUS_C_NAME, ndc: r.NDC_NUM_ID_NDC_CODE, mfg: r.MFG_C_NAME, lot: r.LOT, exp: r.EXPIRATION_DATE, site: r.SITE_C_NAME, route: r.ROUTE_C_NAME, amount: r.IMMNZTN_DOSE_AMOUNT, unit: r.IMMNZTN_DOSE_UNIT_C_NAME }, ctx);
    const { resourceType, status, vaccineCode, patient, occurrenceDateTime, ...rest } = b;
    out.push({
      resourceType,
      id: localId('IMMUNE', r.IMMUNE_ID),
      identifier: [ehiId(ctx, 'IMMUNE', r.IMMUNE_ID), ...epicId(ctx, 'imm', r.IMMUNE_ID)],
      status,
      vaccineCode,
      patient,
      ...(encounter && { encounter }),
      occurrenceDateTime,
      ...(r.IMM_HISTORIC_ADM_YN === 'Y' && { primarySource: false }),
      ...rest,
    });
  }
  // Latest contact's row per vaccine+date.
  const latest = new Map<string, Row>();
  for (const r of t.rows('IMM_ADMIN')) {
    const name = r.IMM_TYPE_ID_NAME || r.IMM_TYPE_FREE_TEXT;
    const date = ehiDate(r.IMM_DATE, ctx);
    if (!name || !date) {
      counts.skippedNoName++;
      continue;
    }
    const k = `${norm(name)}|${date.slice(0, 10)}`;
    if (seen.has(k)) continue;
    const prev = latest.get(k);
    if (!prev || Number(r.CONTACT_DATE_REAL) > Number(prev.CONTACT_DATE_REAL)) latest.set(k, r);
  }
  const immune = [...out];
  const immuneOn = (day: string) => immune.filter((i) => i.occurrenceDateTime?.slice(0, 10) === day);
  for (const [k, r] of latest) {
    const [n, date] = k.split('|');
    const same = immuneOn(date);
    if (r.IMM_LOT_NUMBER && same.some((i) => i.lotNumber === r.IMM_LOT_NUMBER)) {
      counts.immAdminSameDose++;
      continue;
    }
    const dup = same.length > 0;
    if (dup) counts.immAdminPossibleDuplicate++;
    const b = immBody({ name: r.IMM_TYPE_ID_NAME || r.IMM_TYPE_FREE_TEXT, date, status: r.IMM_STATUS_C_NAME, mfg: r.IMM_MANUFACTURER_C_NAME || r.IMM_MANUF_FREE_TEXT, lot: r.IMM_LOT_NUMBER, exp: r.IMM_ADMIN_EXPIRATION_DATE, site: r.IMM_SITE_C_NAME, route: r.IMM_ROUTE_C_NAME, amount: r.IMM_DOSE_AMOUNT, unit: r.IMM_DOSE_UNIT_C_NAME }, ctx);
    const { resourceType, ...rest } = b;
    out.push({
      resourceType,
      id: localId('IMM_ADMIN', `${n}-${date}`),
      ...(dup && { meta: { tag: [{ system: TAG, code: 'possible-duplicate' }] } }),
      identifier: [ehiId(ctx, 'IMM_ADMIN', k)],
      ...rest,
      ...(dup && { extension: same.map((i) => ({ url: DUP_OF, valueReference: { reference: `Immunization/${i.id}` } })) }),
    });
  }
  return out;
}

const epicIds = (r: { identifier?: Identifier[] }) => (r.identifier ?? []).filter((i) => i.system?.startsWith(EPIC_OID) && i.value);
const idKey = (i: Identifier) => `${i.system}|${i.value}`;
const immNames = (i: Immunization) => [i.vaccineCode?.text, ...(i.vaccineCode?.coding ?? []).map((c) => c.display)].map(norm).filter(Boolean);

// Before import. An EHI immunization with an Epic id keeps the existing record's vaccine codes (C-CDA CVX/NDC; the export
// has none), so the engine's update doesn't drop them. One without (IMM_ADMIN) is linked to an existing patient
// Immunization on the same date with the same vaccine name, when that pairing is unique both ways: it takes that
// record's Epic ids (the engine then links it) and codes. A tie, or a match without Epic ids, stays unlinked.
export async function linkImmunizationsToExisting(
  client: MedplumClient,
  resources: Resource[],
  patientId: string,
): Promise<{ resources: Resource[]; epicLinked: number; matched: number; unmatched: number }> {
  const out = structuredClone(resources);
  const imms = out.filter((r): r is Immunization => r.resourceType === 'Immunization');
  if (!imms.length) return { resources: out, epicLinked: 0, matched: 0, unmatched: 0 };
  const existing = await client.searchResources('Immunization', { patient: `Patient/${patientId}`, _count: '1000' }, { cache: 'no-cache' });
  const keepCodes = (mine: Immunization, from: Immunization) => {
    if (from.vaccineCode?.coding?.length) mine.vaccineCode = { ...mine.vaccineCode, coding: from.vaccineCode.coding };
  };
  let epicLinked = 0;
  const claimed = new Set<Immunization>();
  for (const i of imms) {
    const mine = new Set(epicIds(i).map(idKey));
    if (!mine.size) continue;
    const hits = existing.filter((x) => epicIds(x).some((e) => mine.has(idKey(e))));
    hits.forEach((h) => claimed.add(h));
    if (hits.length !== 1) continue; // none, or ambiguous: the engine creates or flags
    epicLinked++;
    keepCodes(i, hits[0]);
  }
  const open = imms.filter((i) => !epicIds(i).length);
  const pick = open.map((i) => {
    const day = i.occurrenceDateTime?.slice(0, 10);
    const name = norm(i.vaccineCode?.text);
    const c = existing.filter((x) => !claimed.has(x) && x.occurrenceDateTime?.slice(0, 10) === day && immNames(x).includes(name));
    return c.length === 1 ? c[0] : undefined;
  });
  let matched = 0;
  open.forEach((i, n) => {
    const m = pick[n];
    if (!m || pick.filter((x) => x === m).length !== 1 || !epicIds(m).length) return;
    matched++;
    i.identifier = [...(i.identifier ?? []), ...epicIds(m)];
    keepCodes(i, m);
  });
  return { resources: out, epicLinked, matched, unmatched: open.length - matched };
}

// HL7 v3 RoleCode for the relations Epic uses; any other relation is kept by name only.
const ROLE: Record<string, string> = {
  mother: 'MTH', father: 'FTH', sister: 'SIS', brother: 'BRO', son: 'SON', daughter: 'DAU', 'maternal grandmother': 'MGRMTH',
  'maternal grandfather': 'MGRFTH', 'paternal grandmother': 'PGRMTH', 'paternal grandfather': 'PGRFTH', 'maternal aunt': 'MAUNT',
  'maternal uncle': 'MUNCLE', 'paternal aunt': 'PAUNT', 'paternal uncle': 'PUNCLE', child: 'CHILD', sibling: 'SIB', spouse: 'SPS',
};
const ROLE_SYS = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode';

// FAMILY_HX is re-recorded at visits (snapshots by CSN): each relative (FAM_MED_REL_ID) is taken from their latest
// snapshot (highest CSN). R4 FamilyMemberHistory has no encounter element. "Neg HX" lists conditions absent from the family: kept as a note, never as conditions.
export function mapFamilyHistory(t: EhiTables, ctx: EhiCtx, counts = { skippedNoRelative: 0 }): Resource[] {
  const byRel = new Map<string, Row[]>();
  for (const r of t.rows('FAMILY_HX')) {
    const k = r.FAM_MED_REL_ID || r.RELATION_C_NAME;
    if (k) byRel.set(k, [...(byRel.get(k) ?? []), r]);
    else counts.skippedNoRelative++; // neither a relation nor a relative id: whose history is unknown
  }
  const out: FamilyMemberHistory[] = [];
  for (const [k, all] of byRel) {
    const csn = all.map((r) => r.PAT_ENC_CSN_ID).sort((a, b) => Number(b) - Number(a))[0];
    const rows = all.filter((r) => r.PAT_ENC_CSN_ID === csn).sort(byLine);
    const relation = rows[0].RELATION_C_NAME;
    const neg = /^neg(ative)? hx$/i.test(relation);
    const names = rows.map((r) => r.MEDICAL_HX_C_NAME || r.MEDICAL_OTHER).filter(Boolean);
    const condition = rows
      .filter((r) => r.MEDICAL_HX_C_NAME || r.MEDICAL_OTHER)
      .map((r): FamilyMemberHistoryCondition => ({
        code: { text: r.MEDICAL_HX_C_NAME || r.MEDICAL_OTHER },
        ...(NUM.test(r.AGE_OF_ONSET ?? '') && { onsetAge: { value: Number(r.AGE_OF_ONSET), unit: 'a', system: UCUM, code: 'a' } }),
        ...(r.COMMENTS && { note: [{ text: r.COMMENTS }] }),
      }));
    if (!names.length) continue; // a relative with no condition says nothing
    // No relation name but a relative id: a family member of unknown relation (relationship is 1..1, never empty).
    const role = neg || !relation ? 'FAMMEMB' : ROLE[norm(relation)];
    out.push({
      resourceType: 'FamilyMemberHistory',
      id: localId('FAMILY_HX', k),
      identifier: [ehiId(ctx, 'FAMILY_HX', k)],
      status: 'completed',
      patient: PATIENT_REF,
      relationship: { ...(role && { coding: [{ system: ROLE_SYS, code: role }] }), ...(relation && { text: relation }) },
      ...(neg ? { note: [{ text: `No family history of: ${names.join(', ')}` }] } : { condition }),
    } as FamilyMemberHistory);
  }
  return out;
}

// Flowsheet vitals in the C-CDA's LOINC codes and units (GA's C-CDA vitals use kg, cm, Cel, separate systolic/diastolic),
// so the engine's content path can merge an EHI vital with its C-CDA copy. Rounded to the C-CDA's precision (height 1
// decimal, temperature 2: exact factors then rounding reproduce every same-time real C-CDA value).
type Vital = { code: string; unit: string; from?: Record<string, (v: number) => number>; digits?: number; trunc?: boolean };
const VITALS: [RegExp, Vital][] = [
  [/^(PULSE|HEART RATE)$/, { code: '8867-4', unit: '/min' }],
  [/^(PULSE OXIMETRY|SPO2)$/, { code: '59408-5', unit: '%' }],
  [/^(RESPIRATIONS|RESP(IRATORY)? RATE)$/, { code: '9279-1', unit: '/min' }],
  [/^(R )?BMI$/, { code: '39156-5', unit: 'kg/m2' }],
  // shortcut: Epic's own kg (C-CDA) as lb x 0.4536 truncated to 3 decimals, fitted on 4 of 4 same-time real C-CDA weights
  // (exact factors matched 0; R16a); re-check if a weight flags at the same time.
  [/^WEIGHT(\/SCALE)?$/, { code: '29463-7', unit: 'kg', digits: 3, trunc: true, from: { ounces: (v) => (v / 16) * 0.4536, lb: (v) => v * 0.4536, kg: (v) => v } }],
  [/^HEIGHT$/, { code: '8302-2', unit: 'cm', digits: 1, from: { inches: (v) => v * 2.54, cm: (v) => v } }],
  [/^TEMPERATURE$/, { code: '8310-5', unit: 'Cel', digits: 2, from: { '°F': (v) => ((v - 32) * 5) / 9, '°C': (v) => v } }],
];
const round = (v: number, d?: number, trunc = false) => (d === undefined ? v : (trunc ? Math.floor(v * 10 ** d + 1e-9) : Math.round(v * 10 ** d)) / 10 ** d);
const utc = (s: string | undefined) => (s && s.length > 10 ? new Date(s).toISOString().replace('.000Z', 'Z') : s);

// IP_FLWSHT_MEAS rows with their values (V_EHI_FLO_MEAS_VALUE, same FSD_ID/LINE); a row without a value is skipped, counted.
export function mapVitals(t: EhiTables, ctx: EhiCtx, counts = { skippedEmpty: 0 }): Resource[] {
  const enc = encounterRef(t);
  const value = new Map(t.rows('V_EHI_FLO_MEAS_VALUE').map((v) => [`${v.FSD_ID}-${v.LINE}`, v]));
  // FSD_ID -> INPATIENT_DATA_ID -> the one encounter carrying it.
  const csnOf = new Map<string, string[]>();
  for (const e of t.rows('PAT_ENC')) if (e.INPATIENT_DATA_ID) csnOf.set(e.INPATIENT_DATA_ID, [...(csnOf.get(e.INPATIENT_DATA_ID) ?? []), e.PAT_ENC_CSN_ID]);
  const fsdCsn = new Map(t.rows('IP_FLWSHT_REC').map((r) => [r.FSD_ID, csnOf.get(r.INPATIENT_DATA_ID)]));
  const out: Observation[] = [];
  for (const r of t.rows('IP_FLWSHT_MEAS')) {
    const pk = `${r.FSD_ID}-${r.LINE}`;
    const v = value.get(pk);
    const raw = v?.MEAS_VALUE_EXTERNAL;
    const name = r.FLO_MEAS_ID_FLO_MEAS_NAME || v?.FLO_MEAS_ID_FLO_MEAS_NAME;
    if (!raw || !name) {
      counts.skippedEmpty++;
      continue;
    }
    const csns = fsdCsn.get(r.FSD_ID) ?? [];
    const encounter = csns.length === 1 ? enc(csns[0]) : undefined;
    const effectiveDateTime = utc(ehiDate(r.RECORDED_TIME, ctx));
    const base = (suffix: string) => ({
      resourceType: 'Observation' as const,
      id: localId('IP_FLWSHT_MEAS', suffix ? `${pk}-${suffix}` : pk),
      identifier: [ehiId(ctx, 'IP_FLWSHT_MEAS', suffix ? `${pk}|${suffix}` : pk)],
      status: 'final' as const,
    });
    const tail = { subject: PATIENT_REF, ...(encounter && { encounter }), ...(effectiveDateTime && { effectiveDateTime }) };
    const vital = (code: string, unit: string, n: number): Observation => ({
      ...base(/^(8480-6|8462-4)$/.test(code) ? code : ''),
      category: category('vital-signs'),
      code: { coding: [{ system: LOINC, code }], text: name },
      ...tail,
      valueQuantity: { value: n, unit, system: UCUM, code: unit },
    });
    const bp = /^(BP|BLOOD PRESSURE)$/i.test(name) && /^(\d+)\/(\d+)$/.exec(raw);
    if (bp) {
      out.push(vital('8480-6', 'mm[Hg]', Number(bp[1])), vital('8462-4', 'mm[Hg]', Number(bp[2])));
      continue;
    }
    const spec = VITALS.find(([re]) => re.test(name.toUpperCase()))?.[1];
    const conv = spec && NUM.test(raw) && (spec.from ? spec.from[v?.UNITS ?? ''] : (x: number) => x);
    if (spec && conv) {
      out.push(vital(spec.code, spec.unit, round(conv(Number(raw)), spec.digits, spec.trunc)));
      continue;
    }
    out.push({
      ...base(''),
      code: { text: name },
      ...tail,
      ...(NUM.test(raw) ? { valueQuantity: { value: Number(raw), ...(v?.UNITS && { unit: v.UNITS }) } } : { valueString: raw }),
    });
  }
  return out;
}

// R20: Epic smoking status names -> the SNOMED codes the C-CDA smoking-status entries carry; others stay text only.
const SMOKING: Record<string, string> = {
  never: '266919005', former: '8517006', 'current every day': '449868002', 'current some day': '428041000124106',
  'never assessed': '266927001', unknown: '266927001', 'unknown if ever smoked': '266927001',
};
const smokingValue = (name: string): CodeableConcept => {
  const code = SMOKING[norm(name)];
  return { ...(code && { coding: [{ system: 'http://snomed.info/sct', code }] }), text: name };
};

// SOCIAL_HX, one row per visit: smoking status (72166-2), alcohol use (11331-6) and ounces per week (no LOINC: by name).
export function mapSocial(t: EhiTables, ctx: EhiCtx): Resource[] {
  const enc = encounterRef(t);
  const out: Observation[] = [];
  for (const r of t.rows('SOCIAL_HX')) {
    const csn = r.PAT_ENC_CSN_ID;
    if (!csn) continue; // no key; never seen in the export
    const encounter = enc(csn);
    const effectiveDateTime = ehiDate(r.CONTACT_DATE, ctx);
    const obs = (what: string, code: CodeableConcept, value: Partial<Observation>): Observation => ({
      resourceType: 'Observation',
      id: localId('SOCIAL_HX', `${csn}-${what}`),
      identifier: [ehiId(ctx, 'SOCIAL_HX', `${csn}|${what}`)],
      status: 'final',
      category: category('social-history'),
      code,
      subject: PATIENT_REF,
      ...(encounter && { encounter }),
      ...(effectiveDateTime && { effectiveDateTime }),
      ...value,
    });
    if (r.SMOKING_TOB_USE_C_NAME) out.push(obs('smoking', { coding: [{ system: LOINC, code: '72166-2' }], text: 'Tobacco smoking status' }, { valueCodeableConcept: smokingValue(r.SMOKING_TOB_USE_C_NAME) }));
    if (r.ALCOHOL_USE_C_NAME)
      out.push(obs('alcohol', { coding: [{ system: LOINC, code: '11331-6' }], text: 'Alcohol use' }, { valueCodeableConcept: { text: r.ALCOHOL_USE_C_NAME }, ...(r.ALCOHOL_COMMENT && { note: [{ text: r.ALCOHOL_COMMENT }] }) }));
    if (NUM.test(r.ALCOHOL_OZ_PER_WK ?? '')) out.push(obs('alcohol-oz', { text: 'Alcohol oz per week' }, { valueQuantity: { value: Number(r.ALCOHOL_OZ_PER_WK), unit: 'oz/wk' } }));
  }
  return out;
}

// R6: Epic's health-maintenance view at export time = the latest HM_HISTORICAL_STATUS row per topic (highest LINE;
// on real data completion dates never decrease with LINE), dated the export. HM_HISTORY completions (no topic in the
// export) become Procedures; one without a time is skipped, counted.
export function mapHealthMaintenance(t: EhiTables, ctx: EhiCtx, counts = { skippedNoDate: 0 }): Resource[] {
  const latest = new Map<string, Row>();
  for (const r of t.rows('HM_HISTORICAL_STATUS')) {
    const prev = latest.get(r.HM_TOPIC_ID_NAME);
    if (r.HM_TOPIC_ID_NAME && (!prev || Number(r.LINE) > Number(prev.LINE))) latest.set(r.HM_TOPIC_ID_NAME, r);
  }
  const status = [...latest].map(([topic, r]): Observation => {
    const due = ehiDate(r.NEXT_DUE_DATE, ctx);
    const done = ehiDate(r.LAST_COMPLETED_DATE, ctx);
    const component = [
      ...(due ? [{ code: { text: 'Next due date' }, valueDateTime: due }] : []),
      ...(done ? [{ code: { text: 'Last completed date' }, valueDateTime: done }] : []),
    ];
    return {
      resourceType: 'Observation',
      id: localId('HM_HISTORICAL_STATUS', r.LINE),
      identifier: [ehiId(ctx, 'HM_HISTORICAL_STATUS', topic)],
      status: 'final',
      code: { text: `Health maintenance: ${topic}` },
      subject: PATIENT_REF,
      effectiveDateTime: ctx.date,
      ...(r.HM_STATUS_C_NAME && { valueString: r.HM_STATUS_C_NAME }),
      ...(component.length && { component }),
    };
  });
  const done: Procedure[] = [];
  // Keyed by completion type and time (LINE is a list position, not an id); LINE only breaks a tie between equal rows.
  const keyed = t.rows('HM_HISTORY').flatMap((r) => {
    const performedDateTime = ehiDate(r.HM_COMP_UTC_DTTM, { ...ctx, timeZone: 'UTC' }); // the column is UTC
    if (!performedDateTime || !r.HM_COMP_TYPE_C_NAME) {
      counts.skippedNoDate++;
      return [];
    }
    return [{ r, performedDateTime, key: `${r.HM_COMP_TYPE_C_NAME}|${performedDateTime}` }];
  });
  for (const { r, performedDateTime, key } of keyed) {
    const tie = keyed.filter((x) => x.key === key).length > 1;
    done.push({
      resourceType: 'Procedure',
      id: localId('HM_HISTORY', r.LINE),
      identifier: [ehiId(ctx, 'HM_HISTORY', tie ? `${key}|${r.LINE}` : key)],
      status: 'completed',
      code: { text: `Health maintenance completion: ${r.HM_COMP_TYPE_C_NAME}` },
      subject: PATIENT_REF,
      performedDateTime,
    });
  }
  return [...status, ...done];
}

// One QuestionnaireResponse per ANSWER_ID. The export has no question text (CL_QANSWER_QA is absent): items are keyed
// by LINE. Unanswered lines are left out; an answer set with no answers is skipped, counted.
export function mapQuestionnaires(t: EhiTables, ctx: EhiCtx, counts = { skippedEmpty: 0 }): Resource[] {
  const sets = new Map<string, Row[]>();
  for (const r of t.rows('V_EHI_HQA_QUEST_ANSWER')) sets.set(r.ANSWER_ID, [...(sets.get(r.ANSWER_ID) ?? []), r]);
  const out: QuestionnaireResponse[] = [];
  for (const [id, rows] of sets) {
    const item = rows.filter((r) => r.QUEST_ANSWER_EXTERNAL).sort(byLine).map((r) => ({ linkId: r.LINE, answer: [{ valueString: r.QUEST_ANSWER_EXTERNAL }] }));
    if (!item.length) {
      counts.skippedEmpty++;
      continue;
    }
    out.push({
      resourceType: 'QuestionnaireResponse',
      id: localId('V_EHI_HQA_QUEST_ANSWER', id),
      identifier: ehiId(ctx, 'V_EHI_HQA_QUEST_ANSWER', id), // 0..1 on this type
      status: 'completed',
      subject: PATIENT_REF,
      item,
    });
  }
  return out;
}
