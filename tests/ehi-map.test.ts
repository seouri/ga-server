import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  Communication, Condition, DiagnosticReport, DocumentReference, Encounter, FamilyMemberHistory, Immunization, MedicationRequest, Observation,
  Procedure, QuestionnaireResponse, Resource,
} from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { mapConditions } from '../src/ehi/conditions.ts';
import { ehiDate } from '../src/ehi/dates.ts';
import { mapEncounters } from '../src/ehi/encounters.ts';
import { type EhiCtx, PATIENT_REF } from '../src/ehi/ids.ts';
import { linkResultsToExisting, mapLabs } from '../src/ehi/labs.ts';
import type { MedplumClient } from '@medplum/core';
import { EhiTables } from '../src/ehi/read.ts';
import { linkImmunizationsToExisting, mapFamilyHistory, pairImmunizations, mapHealthMaintenance, mapImmunizations, mapQuestionnaires, mapSocial, mapVitals } from '../src/ehi/history.ts';
import { mapMeds } from '../src/ehi/meds.ts';
import { mapMessages, mapNotes } from '../src/ehi/documents.ts';

const FIX = join(import.meta.dirname, 'fixtures/ehi');
const t = () => new EhiTables(FIX);
const ctx: EhiCtx = { org: 'synthetic-health', date: '2026-01-17T08:30:00-05:00', timeZone: 'America/New_York', epicOrgNumber: '99' };
const SYS = 'urn:ga-server:id:ehi:synthetic-health';
const of = <T extends Resource>(rs: Resource[], type: string) => rs.filter((r) => r.resourceType === type) as T[];

describe('EHI mappers', () => {
  it('ehiDate normalizes the export\'s date formats', () => {
    expect(ehiDate('1/16/2026 12:00:00 AM', ctx)).toBe('2026-01-16');
    expect(ehiDate('1/15/2026 8:05:00 AM', ctx)).toBe('2026-01-15T08:05:00-05:00');
    expect(ehiDate('12/3/2025 12:30:00 PM', ctx)).toBe('2025-12-03T12:30:00-05:00');
    expect(ehiDate('1/5/2026 12:15:00 AM', ctx)).toBe('2026-01-05T00:15:00-05:00');
    expect(ehiDate('1/5/2026 11:59:59 PM', { ...ctx, timeZone: 'UTC' })).toBe('2026-01-05T23:59:59Z');
    expect(ehiDate('', ctx)).toBeUndefined();
    expect(() => ehiDate('2026-01-05', ctx)).toThrow();
  });

  it('ehiDate gives each time the offset its own date had in the export\'s zone (R17)', () => {
    expect(ehiDate('7/15/2026 8:05:00 AM', ctx)).toBe('2026-07-15T08:05:00-04:00'); // summer: EDT
    expect(ehiDate('1/15/2026 8:05:00 AM', ctx)).toBe('2026-01-15T08:05:00-05:00'); // winter: EST
    expect(ehiDate('11/1/2026 1:30:00 PM', ctx)).toBe('2026-11-01T13:30:00-05:00'); // the day DST ended
    expect(ehiDate('7/15/2026 8:05:00 AM', { ...ctx, timeZone: 'Asia/Seoul' })).toBe('2026-07-15T08:05:00+09:00');
  });

  it('mapLabs makes one report per order and one observation per result line', () => {
    const rs = mapLabs(t(), ctx);
    const [dr, ...more] = of<DiagnosticReport>(rs, 'DiagnosticReport');
    expect(more).toHaveLength(0);
    const obs = of<Observation>(rs, 'Observation');
    expect(obs).toHaveLength(2);
    // GA identifier first, then the order link identifier; Observations carry no link identifier (R7).
    expect(dr.identifier).toEqual([
      { system: SYS, value: 'ORDER_PROC|9000001' },
      { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.798268', value: '9000001' },
    ]);
    expect(obs.map((o) => o.identifier)).toEqual([[{ system: SYS, value: 'ORDER_RESULTS|9000001-1' }], [{ system: SYS, value: 'ORDER_RESULTS|9000001-2' }]]);
    expect(dr.result).toEqual(obs.map((o) => ({ reference: `Observation/${o.id}` })));
    expect(dr.encounter).toEqual({ reference: 'Encounter/PAT_ENC-8000001' });
    expect(dr.subject).toEqual(PATIENT_REF);
    const [ldl] = obs;
    expect(ldl).toMatchObject({
      status: 'final',
      effectiveDateTime: '2026-01-15T08:05:00-05:00', // specimen time, not the result date
      valueQuantity: { value: 111, unit: 'mg/dL' },
      referenceRange: [{ high: { value: 100, unit: 'mg/dL' } }],
      encounter: { reference: 'Encounter/PAT_ENC-8000001' },
      subject: PATIENT_REF,
    });
  });

  it('mapLabs uses LOINC when present, else code.text', () => {
    const [ldl, hdl] = of<Observation>(mapLabs(t(), ctx), 'Observation');
    // The export has LOINC long names, never codes: name kept, no code invented.
    expect(ldl.code).toEqual({ text: 'LDL CALCULATED', coding: [{ display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation' }] });
    expect(hdl.code).toEqual({ text: 'HDL' });
  });

  it('mappers never emit empty strings, arrays or objects', () => {
    const empty = (v: unknown): boolean =>
      v === '' || (Array.isArray(v) ? !v.length || v.some(empty) : v && typeof v === 'object' ? !Object.keys(v).length || Object.values(v).some(empty) : false);
    const all = [
      ...mapLabs(t(), ctx), ...mapEncounters(t(), ctx), ...mapConditions(t(), ctx), ...mapImmunizations(t(), ctx), ...mapFamilyHistory(t(), ctx),
      ...mapVitals(t(), ctx), ...mapSocial(t(), ctx), ...mapHealthMaintenance(t(), ctx), ...mapQuestionnaires(t(), ctx), ...mapMeds(t(), ctx),
      ...mapMessages(t(), ctx), ...mapNotes(t(), ctx, FIX).resources,
    ];
    for (const r of all) expect(empty(r), r.id).toBe(false);
  });

  it('no Epic org number: no link identifiers', () => {
    const [dr] = of<DiagnosticReport>(mapLabs(t(), { ...ctx, epicOrgNumber: undefined }), 'DiagnosticReport');
    expect(dr.identifier).toEqual([{ system: SYS, value: 'ORDER_PROC|9000001' }]);
  });

  it('mapEncounters keys on the CSN and links it', () => {
    const [e] = mapEncounters(t(), ctx) as Encounter[];
    expect(e).toMatchObject({
      id: 'PAT_ENC-8000001',
      identifier: [
        { system: SYS, value: 'PAT_ENC|8000001' },
        { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.3.698084.8', value: '8000001' },
        { system: 'urn:oid:1.2.840.114350.1.72.75210', value: '8000001' }, // R13: both CSN roots
      ],
      period: { start: '2026-01-15' },
      subject: PATIENT_REF,
    });
    expect(e.class).toBeUndefined(); // unknown: left out (R11)
    expect(e.status).toBeUndefined(); // neither status column says: left out, like class
  });

  it('mapConditions sets category and resolved status', () => {
    const cs = mapConditions(t(), ctx) as Condition[];
    const cat = (c: Condition) => c.category?.[0]?.coding?.[0]?.code;
    const status = (c: Condition) => c.clinicalStatus?.coding?.[0]?.code;
    const dx = cs.filter((c) => cat(c) === 'encounter-diagnosis');
    const pl = cs.filter((c) => cat(c) === 'problem-list-item');
    expect(dx).toHaveLength(2);
    // R12: the visit diagnosis's own Epic id, `<CSN>-<DX_ID>`.
    expect(dx[0].identifier).toEqual([
      { system: SYS, value: 'PAT_ENC_DX|8000001-1' },
      { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.1.1099.1', value: '8000001-7000001' },
    ]);
    expect(dx[1].code).toBeUndefined(); // no name in the export: omitted, never empty
    expect(dx[0].encounter).toEqual({ reference: 'Encounter/PAT_ENC-8000001' });
    expect(dx[0].code).toEqual({ text: 'Test problem' }); // named via DX_LINK_PROB_ID
    expect(pl.map((c) => [c.code?.text, status(c), c.abatementDateTime])).toEqual([
      ['Test problem', 'active', undefined],
      ['Test resolved problem', 'resolved', '2021-06-01'],
    ]);
    expect(pl[1].identifier).toEqual([
      { system: SYS, value: 'PROBLEM_LIST|6000002' },
      { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.768076', value: '6000002' },
    ]);
    expect(pl[1].onsetDateTime).toBe('2020-03-02');
  });

  it('mapLabs skips and counts a result line without any name', () => {
    const base = t();
    const rows = (table: string) =>
      table === 'ORDER_RESULTS' ? [...base.rows(table), { ...base.rows(table)[0], LINE: '3', COMPONENT_ID_NAME: '', COMPON_LNC_ID_LNC_LONG_NAME: '' }] : base.rows(table);
    const counts = { skippedNoName: 0 };
    const rs = mapLabs({ rows } as unknown as EhiTables, ctx, counts);
    expect(of<Observation>(rs, 'Observation')).toHaveLength(2);
    expect(of<DiagnosticReport>(rs, 'DiagnosticReport')[0].result).toHaveLength(2);
    expect(counts.skippedNoName).toBe(1);
  });

  it('two EHI lines claiming one existing result: neither is identified', async () => {
    const existing: Observation = {
      resourceType: 'Observation', id: 'old', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '1-1' }] },
      effectiveDateTime: '2024-03-01', valueQuantity: { value: 0, unit: '%' },
    };
    const report: DiagnosticReport = { resourceType: 'DiagnosticReport', id: 'r', status: 'final', code: { text: 'x' }, result: [{ reference: 'Observation/old' }] };
    const client = {
      searchResources: async (type: string) => (type === 'DiagnosticReport' ? [report] : [existing]),
    } as unknown as MedplumClient;
    const line = (id: string): Observation => ({ resourceType: 'Observation', id, status: 'final', code: { text: id }, valueQuantity: { value: 0, unit: '%' } });
    const dr: DiagnosticReport = {
      resourceType: 'DiagnosticReport', id: 'ehi', status: 'final', code: { text: 'x' },
      identifier: [{ system: SYS, value: 'ORDER_PROC|1' }, { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.798268', value: '1' }],
      result: [{ reference: 'Observation/a' }, { reference: 'Observation/b' }],
    };
    const out = await linkResultsToExisting(client, [dr, line('a'), line('b')], 'p');
    expect(out).toMatchObject({ identified: 0, unidentified: 2 });
    expect(of<Observation>(out.resources, 'Observation').map((o) => [o.code.coding, o.effectiveDateTime])).toEqual([[undefined, undefined], [undefined, undefined]]);
    // One line alone takes the existing code and time.
    const one = await linkResultsToExisting(client, [{ ...dr, result: [{ reference: 'Observation/a' }] }, line('a')], 'p');
    expect(one).toMatchObject({ identified: 1, unidentified: 0 });
  });

  it('an entered-in-error problem gets no clinical status and no abatement', () => {
    const base = t();
    const rows = (table: string) =>
      table === 'PROBLEM_LIST' ? [{ ...base.rows(table)[1], PROBLEM_STATUS_C_NAME: 'Deleted' }] : base.rows(table);
    const [c] = (mapConditions({ rows } as unknown as EhiTables, ctx) as Condition[]).filter((x) => x.id?.startsWith('PROBLEM_LIST'));
    expect(c.verificationStatus?.coding?.[0]?.code).toBe('entered-in-error');
    expect(c.clinicalStatus).toBeUndefined();
    expect(c.abatementDateTime).toBeUndefined();
  });

  it('mapImmunizations: IMMUNE with its Epic id, plus IMM_ADMIN vaccine+date pairs IMMUNE lacks', () => {
    const [a, b, c, ...more] = mapImmunizations(t(), ctx) as Immunization[];
    expect(more).toHaveLength(0);
    expect(a).toEqual({
      resourceType: 'Immunization',
      id: 'IMMUNE-6100001',
      identifier: [{ system: SYS, value: 'IMMUNE|6100001' }, { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.768076', value: '6100001' }],
      status: 'completed',
      vaccineCode: { text: 'TEST VACCINE', coding: [{ system: 'http://hl7.org/fhir/sid/ndc', code: '00000-0000-00' }] },
      patient: PATIENT_REF,
      encounter: { reference: 'Encounter/PAT_ENC-8000001' },
      occurrenceDateTime: '2026-01-15',
      manufacturer: { display: 'TEST MAKER' },
      lotNumber: 'LOT1',
      expirationDate: '2027-06-30',
      site: { text: 'Left deltoid' },
      route: { text: 'Intramuscular' },
      doseQuantity: { value: 0.5, unit: 'mL' },
    });
    expect(b).toMatchObject({ id: 'IMMUNE-6100002', primarySource: false, occurrenceDateTime: '2010-03-02', vaccineCode: { text: 'OLD VACCINE' } });
    // Two contacts list the same outside dose: one record, from the latest contact; no Epic id exists for it.
    expect(c).toEqual({
      resourceType: 'Immunization',
      id: 'IMM_ADMIN-outside vaccine-2020-05-01',
      identifier: [{ system: SYS, value: 'IMM_ADMIN|outside vaccine|2020-05-01' }],
      status: 'completed',
      vaccineCode: { text: 'Outside Vaccine' },
      patient: PATIENT_REF,
      occurrenceDateTime: '2020-05-01',
      lotNumber: 'LOT9',
    });
  });

  it('an IMM_ADMIN dose on an IMMUNE dose\'s date: same lot is that dose; another lot is a possible duplicate of it (R18)', () => {
    const base = t();
    const extra = (lot: string, date = '1/15/2026 12:00:00 AM') => ({ ...base.rows('IMM_ADMIN')[1], IMM_TYPE_FREE_TEXT: 'Test vaccine (outside name)', IMM_DATE: date, IMM_LOT_NUMBER: lot });
    const rows = (table: string) => (table === 'IMM_ADMIN' ? [...base.rows(table), extra('LOT1'), { ...extra('LOT2'), IMM_TYPE_FREE_TEXT: 'Another name' }] : base.rows(table));
    const counts = { skippedNoName: 0, immAdminSameDose: 0, immAdminPossibleDuplicate: 0 };
    const rs = mapImmunizations({ rows } as unknown as EhiTables, ctx, counts) as Immunization[];
    expect(counts).toEqual({ skippedNoName: 0, immAdminSameDose: 1, immAdminPossibleDuplicate: 1 });
    expect(rs.map((r) => r.id)).toEqual(['IMMUNE-6100001', 'IMMUNE-6100002', 'IMM_ADMIN-outside vaccine-2020-05-01', 'IMM_ADMIN-another name-2026-01-15']);
    const dup = rs[3];
    expect(dup.meta).toEqual({ tag: [{ system: 'urn:ga-server:tag', code: 'possible-duplicate' }] });
    expect(dup.extension).toEqual([{ url: 'urn:ga-server:ext:possible-duplicate-of', valueReference: { reference: 'Immunization/IMMUNE-6100001' } }]);
    expect(rs[2].meta).toBeUndefined(); // no IMMUNE dose that day: an ordinary record
  });

  it('linkImmunizationsToExisting keeps the C-CDA vaccine codes and links IMM_ADMIN doses by date and name, never on a tie', async () => {
    const CVX = 'urn:oid:2.16.840.1.113883.12.292';
    const epic = (v: string) => ({ system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.768076', value: v });
    const imm = (id: string, date: string, extra: Partial<Immunization>): Immunization => ({ resourceType: 'Immunization', id, status: 'completed', patient: { reference: 'Patient/p' }, occurrenceDateTime: date, vaccineCode: {}, ...extra });
    const existing = [
      imm('c1', '2026-01-15', { identifier: [epic('6100001')], vaccineCode: { coding: [{ system: CVX, code: '208' }] } }),
      imm('c2', '2020-05-01', { identifier: [epic('555')], vaccineCode: { text: 'OUTSIDE VACCINE', coding: [{ system: CVX, code: '88' }] } }),
    ];
    const client = (rs: Immunization[]) => ({ searchResources: async () => rs }) as unknown as MedplumClient;
    const out = await linkImmunizationsToExisting(client(existing), mapImmunizations(t(), ctx), 'p');
    expect(out).toMatchObject({ epicLinked: 1, matched: 1, unmatched: 0 });
    const [a, , c] = out.resources as Immunization[];
    expect(a.vaccineCode).toEqual({ text: 'TEST VACCINE', coding: [{ system: CVX, code: '208' }] });
    expect(c.identifier).toEqual([{ system: SYS, value: 'IMM_ADMIN|outside vaccine|2020-05-01' }, epic('555')]);
    expect(c.vaccineCode).toEqual({ text: 'Outside Vaccine', coding: [{ system: CVX, code: '88' }] });
    // Two existing doses of that vaccine on that day: a tie, left unlinked.
    const tie = await linkImmunizationsToExisting(client([...existing, { ...existing[1], id: 'c3', identifier: [epic('556')] }]), mapImmunizations(t(), ctx), 'p');
    expect(tie).toMatchObject({ matched: 0, unmatched: 1 });
    expect((tie.resources[2] as Immunization).identifier).toHaveLength(1);
  });

  it('mapFamilyHistory: one record per relative from their latest snapshot, negative history as a note', () => {
    const fh = mapFamilyHistory(t(), ctx) as FamilyMemberHistory[];
    expect(fh.map((f) => f.identifier?.[0].value)).toEqual(['FAMILY_HX|1', 'FAMILY_HX|2', 'FAMILY_HX|3', 'FAMILY_HX|4']);
    const [mother, gf, neg, father] = fh;
    expect(mother).toEqual({
      resourceType: 'FamilyMemberHistory',
      id: 'FAMILY_HX-1',
      identifier: [{ system: SYS, value: 'FAMILY_HX|1' }],
      status: 'completed',
      patient: PATIENT_REF,
      relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'MTH' }], text: 'Mother' },
      condition: [
        { code: { text: 'Test condition' }, onsetAge: { value: 50, unit: 'a', system: 'http://unitsofmeasure.org', code: 'a' } },
        { code: { text: 'Other condition' }, note: [{ text: 'test comment' }] },
      ],
    });
    expect(gf.relationship.coding?.[0].code).toBe('MGRFTH');
    // "Neg HX": conditions absent from the family. Stated in a note, never as conditions (a code search must not hit them).
    expect(neg.condition).toBeUndefined();
    expect(neg.relationship).toEqual({ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'FAMMEMB' }], text: 'Neg HX' });
    expect(neg.note).toEqual([{ text: 'No family history of: Cancer' }]);
    expect(father.condition).toEqual([{ code: { text: 'Only old' } }]);
  });

  it('mapVitals: LOINC and C-CDA units for vitals, split blood pressure, others by name', () => {
    const vs = mapVitals(t(), ctx) as Observation[];
    const q = (o: Observation) => [o.code.coding?.[0]?.code ?? o.code.text, o.valueQuantity?.value ?? o.valueString, o.valueQuantity?.unit];
    expect(vs.map(q)).toEqual([
      ['8480-6', 120, 'mm[Hg]'],
      ['8462-4', 80, 'mm[Hg]'],
      ['29463-7', 68.04, 'kg'], // 2400 oz = 150 lb x 0.4536 (Epic's factor), truncated
      ['8310-5', 37, 'Cel'], // 98.6 °F
      ['CLINIC R POSITION', 'Sitting', undefined],
      ['8302-2', 177.8, 'cm'], // 70 in
    ]);
    const [sys] = vs;
    expect(sys).toEqual({
      resourceType: 'Observation',
      id: 'IP_FLWSHT_MEAS-1000001-1-8480-6',
      identifier: [{ system: SYS, value: 'IP_FLWSHT_MEAS|1000001-1|8480-6' }],
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }], text: 'BLOOD PRESSURE' },
      subject: PATIENT_REF,
      encounter: { reference: 'Encounter/PAT_ENC-8000001' }, // FSD_ID -> IP_FLWSHT_REC -> PAT_ENC.INPATIENT_DATA_ID
      effectiveDateTime: '2026-01-15T13:30:00Z', // UTC, as the C-CDA vitals are (exact-time merge)
      valueQuantity: { value: 120, unit: 'mm[Hg]', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
    });
    expect(vs[4].category).toBeUndefined();
  });

  it('mapSocial: smoking status and alcohol use', () => {
    const [smoke, alc, oz] = mapSocial(t(), ctx) as Observation[];
    expect(smoke).toMatchObject({
      identifier: [{ system: SYS, value: 'SOCIAL_HX|8000001|smoking' }],
      code: { coding: [{ system: 'http://loinc.org', code: '72166-2' }], text: 'Tobacco smoking status' },
      category: [{ coding: [{ code: 'social-history' }] }],
      valueCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: '266919005' }], text: 'Never' },
      effectiveDateTime: '2026-01-15',
      encounter: { reference: 'Encounter/PAT_ENC-8000001' },
    });
    expect(alc).toMatchObject({ code: { coding: [{ system: 'http://loinc.org', code: '11331-6' }] }, valueCodeableConcept: { text: 'Yes' } });
    expect(oz).toMatchObject({ code: { text: 'Alcohol oz per week' }, valueQuantity: { value: 1, unit: 'oz/wk' } });
  });

  it('mapHealthMaintenance: latest status per topic as of the export, completions as procedures', () => {
    const counts = { skippedNoDate: 0 };
    const rs = mapHealthMaintenance(t(), ctx, counts);
    const [topic, other] = rs.filter((r) => r.resourceType === 'Observation') as Observation[];
    expect(topic).toMatchObject({
      identifier: [{ system: SYS, value: 'HM_HISTORICAL_STATUS|TEST TOPIC' }],
      status: 'final',
      code: { text: 'Health maintenance: TEST TOPIC' },
      effectiveDateTime: ctx.date,
      valueString: 'Not Due',
      component: [
        { code: { text: 'Next due date' }, valueDateTime: '2027-01-15' },
        { code: { text: 'Last completed date' }, valueDateTime: '2026-01-16' },
      ],
    });
    expect(other).toMatchObject({ valueString: 'Aged Out' });
    expect(other.component).toBeUndefined();
    const procs = rs.filter((r) => r.resourceType === 'Procedure') as Procedure[];
    expect(procs).toEqual([{
      resourceType: 'Procedure', id: 'HM_HISTORY-1', identifier: [{ system: SYS, value: 'HM_HISTORY|Immunization|2026-01-15T20:30:00Z' }], status: 'completed',
      code: { text: 'Health maintenance completion: Immunization' }, subject: PATIENT_REF, performedDateTime: '2026-01-15T20:30:00Z',
    }]);
    expect(counts.skippedNoDate).toBe(1);
  });

  it('mapQuestionnaires: one response per answer set, answered lines in order', () => {
    const counts = { skippedEmpty: 0 };
    const [qr, ...more] = mapQuestionnaires(t(), ctx, counts) as QuestionnaireResponse[];
    expect(more).toHaveLength(0);
    expect(counts.skippedEmpty).toBe(1);
    expect(qr).toEqual({
      resourceType: 'QuestionnaireResponse',
      id: 'V_EHI_HQA_QUEST_ANSWER-1100001',
      identifier: { system: SYS, value: 'V_EHI_HQA_QUEST_ANSWER|1100001' }, // 0..1 on this type
      status: 'completed',
      subject: PATIENT_REF,
      item: [{ linkId: '1', answer: [{ valueString: 'Never' }] }, { linkId: '2', answer: [{ valueString: 'Yes' }] }],
    });
  });

  it('mapMeds: medication order linked by order id', () => {
    const [m] = mapMeds(t(), ctx) as MedicationRequest[];
    expect(m).toEqual({
      resourceType: 'MedicationRequest',
      id: 'ORDER_MED-5000001',
      identifier: [{ system: SYS, value: 'ORDER_MED|5000001' }, { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.798268', value: '5000001' }],
      status: 'unknown',
      intent: 'order',
      medicationCodeableConcept: { text: 'TESTDRUG 10 MG TABLET' },
      subject: PATIENT_REF,
      encounter: { reference: 'Encounter/PAT_ENC-8000001' },
      authoredOn: '2026-01-15',
    });
  });

  it('messages keep thread order and full text', () => {
    const [first, reply, ...more] = mapMessages(t(), ctx) as Communication[];
    expect(more).toHaveLength(0);
    expect(first).toEqual({
      resourceType: 'Communication',
      id: 'MYC_MESG-900001',
      identifier: [{ system: SYS, value: 'MYC_MESG|900001' }],
      status: 'completed',
      subject: PATIENT_REF,
      encounter: { reference: 'Encounter/PAT_ENC-8000001' },
      topic: { text: 'Test' },
      sent: '2026-01-15T09:00:00-05:00',
      sender: PATIENT_REF,
      recipient: [{ display: 'TEST, PROVIDER' }],
      payload: [{ contentString: 'Hello there\nSecond’s line' }], // RTF lines joined in LINE order (9 before 10), split mid-word
    });
    expect(reply).toMatchObject({
      id: 'MYC_MESG-900002',
      sender: { display: 'TEST, PROVIDER' },
      recipient: [PATIENT_REF],
      inResponseTo: [{ reference: 'Communication/MYC_MESG-900001' }],
      payload: [{ contentString: 'plain line\nsay "x\n"quoted" start not split\nline1\nline2' }],
    });
  });

  it('mapNotes: RTF, plain text, or metadata only', () => {
    const { resources, rtf } = mapNotes(t(), ctx, FIX);
    const [a, b, c] = resources as DocumentReference[];
    const text = (d: DocumentReference) => d.content.map((x) => (x.attachment.data ? Buffer.from(x.attachment.data, 'base64').toString('utf8') : x.attachment.title));
    expect(a).toMatchObject({
      id: 'HNO_INFO-1001',
      identifier: [{ system: SYS, value: 'HNO_INFO|1001' }, { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.727879', value: '1001' }], // its Epic note id links C-CDA notes
      status: 'current',
      type: { text: 'Progress Notes' },
      description: 'Progress Notes',
      subject: PATIENT_REF,
      date: '2026-01-15T14:00:00-05:00',
      author: [{ display: 'TEST, PROVIDER' }],
      context: { encounter: [{ reference: 'Encounter/PAT_ENC-8000001' }], period: { start: '2026-01-15T13:00:00-05:00' } },
    });
    expect(text(a)).toEqual(['Synthetic note body.']);
    expect(a.content[0].attachment.contentType).toBe('text/plain; charset=utf-8');
    expect(rtf.get('HNO_INFO-1001')).toEqual([join(FIX, 'Rich Text', 'HNO_1001_56510_41.RTF')]);
    expect(text(b)).toEqual(['Plain text note.\nSecond line.']);
    expect(b.date).toBe('2026-01-16T09:00:00-05:00'); // no create time: last update
    expect(c.content).toEqual([{ attachment: { title: 'No text in export' } }]);
    expect(c.date).toBeUndefined(); // a date without time is not an instant
    expect(c.type).toEqual({ text: 'Telephone Encounter' });
  });

  it('R20: Epic smoking status names map to the C-CDA SNOMED codes; others stay text', () => {
    const base = t();
    const names = ['Former', 'Current Every Day', 'Current Some Day', 'Never Assessed', 'Unknown', 'never', 'Heavy Smoker'];
    const rows = (table: string) =>
      table === 'SOCIAL_HX' ? names.map((n, i) => ({ ...base.rows(table)[0], PAT_ENC_CSN_ID: `80000${i}`, SMOKING_TOB_USE_C_NAME: n, ALCOHOL_USE_C_NAME: '', ALCOHOL_OZ_PER_WK: '' })) : base.rows(table);
    const vs = (mapSocial({ rows } as unknown as EhiTables, ctx) as Observation[]).map((o) => o.valueCodeableConcept);
    expect(vs.map((v) => v?.coding?.[0]?.code)).toEqual(['8517006', '449868002', '428041000124106', '266927001', '266927001', '266919005', undefined]);
    expect(vs[6]).toEqual({ text: 'Heavy Smoker' });
  });

  it('an RTF message without text falls back to MSG_TXT', () => {
    const base = t();
    const rows = (table: string) => (table === 'MYC_MESG_RTF_TEXT' ? [...base.rows(table), { MESSAGE_ID: '900002', LINE: '1', RTF_TXT: '{\\rtf1 {\\fonttbl{\\f0 Arial;}}}' }] : base.rows(table));
    const reply = (mapMessages({ rows } as unknown as EhiTables, ctx) as Communication[])[1];
    expect(reply.payload?.[0]?.contentString).toBe('plain line\nsay "x\n"quoted" start not split\nline1\nline2');
  });

  it('a note\'s RTF segments are read in numeric order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ehi-'));
    mkdirSync(join(dir, 'Rich Text'));
    writeFileSync(join(dir, 'Rich Text', 'HNO_77_56510_41.RTF'), '{\\rtf1 second}');
    writeFileSync(join(dir, 'Rich Text', 'HNO_77_9.5_41.RTF'), '{\\rtf1 first}');
    const rows = (table: string) => (table === 'HNO_INFO' ? [{ NOTE_ID: '77' }] : []);
    const { resources, rtf } = mapNotes({ rows } as unknown as EhiTables, ctx, dir);
    expect(rtf.get('HNO_INFO-77')?.map((f) => basename(f).split('_')[2])).toEqual(['9.5', '56510']);
    expect((resources[0] as DocumentReference).content.map((c) => Buffer.from(c.attachment.data as string, 'base64').toString())).toEqual(['first', 'second']);
  });

  it('R18 compares IMMUNE and IMM_ADMIN dates by day', () => {
    const base = t();
    const rows = (table: string) =>
      table === 'IMMUNE' ? [{ ...base.rows(table)[0], IMMUNE_DATE: '1/15/2026 9:00:00 AM' }]
        : table === 'IMM_ADMIN' ? [{ ...base.rows(table)[1], IMM_TYPE_FREE_TEXT: 'Other name', IMM_DATE: '1/15/2026 12:00:00 AM', IMM_LOT_NUMBER: 'LOT1' }, { ...base.rows(table)[0], IMM_DATE: '1/15/2026 12:00:00 AM' }]
          : base.rows(table);
    const counts = { skippedNoName: 0, immAdminSameDose: 0, immAdminPossibleDuplicate: 0 };
    const rs = mapImmunizations({ rows } as unknown as EhiTables, ctx, counts);
    expect(rs.map((r) => r.id)).toEqual(['IMMUNE-6100001']); // same lot that day: the same dose; same name that day: already IMMUNE
    expect(counts.immAdminSameDose).toBe(1);
  });

  it('family history never has an empty relationship: a known relative without a relation name is a family member', () => {
    const base = t();
    const rows = (table: string) =>
      table === 'FAMILY_HX'
        ? [{ ...base.rows(table)[1], RELATION_C_NAME: '', FAM_MED_REL_ID: '9' }, { ...base.rows(table)[1], RELATION_C_NAME: '', FAM_MED_REL_ID: '' }, { ...base.rows(table)[1], FAM_MED_REL_ID: '10', MEDICAL_HX_C_NAME: '', MEDICAL_OTHER: '' }]
        : base.rows(table);
    const counts = { skippedNoRelative: 0, skippedNoCondition: 0 };
    const fh = mapFamilyHistory({ rows } as unknown as EhiTables, ctx, counts) as FamilyMemberHistory[];
    expect(fh.map((f) => f.relationship)).toEqual([{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'FAMMEMB' }] }]);
    expect(counts).toEqual({ skippedNoRelative: 1, skippedNoCondition: 1 }); // relative 10 has no condition: counted
  });

  it('HM completions are keyed by type and time; LINE breaks only a tie', () => {
    const base = t();
    const row = base.rows('HM_HISTORY')[0];
    const rows = (table: string) => (table === 'HM_HISTORY' ? [row, { ...row, LINE: '7' }, { ...row, LINE: '8', HM_COMP_TYPE_C_NAME: 'LOS Code' }] : base.rows(table));
    const keys = mapHealthMaintenance({ rows } as unknown as EhiTables, ctx).filter((r) => r.resourceType === 'Procedure').map((r) => (r as Procedure).identifier?.[0].value);
    expect(keys).toEqual(['HM_HISTORY|Immunization|2026-01-15T20:30:00Z|1', 'HM_HISTORY|Immunization|2026-01-15T20:30:00Z|7', 'HM_HISTORY|LOS Code|2026-01-15T20:30:00Z']);
  });
});

it('pairImmunizations: same day by lot, else by name; copies of one dose count once; never a tie or a double claim', () => {
  const epic = { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.768076', value: '1' };
  const imm = (id: string, date: string, text: string, lot?: string, identifier?: { system: string; value: string }[]): Immunization =>
    ({ resourceType: 'Immunization', id, status: 'completed', patient: { reference: 'Patient/p' }, occurrenceDateTime: date, vaccineCode: { text }, ...(lot ? { lotNumber: lot } : {}), ...(identifier ? { identifier } : {}) });
  const existing = [
    imm('b', '2022-10-07', 'INFLUENZA A', 'L9'),
    imm('a', '2022-10-07', 'INFLUENZA B', 'l9', [epic]), // a copy of the same dose (same lot): the Epic one wins
    imm('c', '2001-09-01', 'Td, unspecified'),
    imm('d', '2001-09-01', 'TD VACCINE (ADULT)'),
    imm('e', '2010-01-01', 'MMR'),
    imm('f', '2010-01-01', 'MMR'),
  ];
  const out = pairImmunizations(existing, [
    imm('x1', '2022-10-07', 'FLU-IIV3', 'L9'),
    imm('x2', '2001-09-01', 'TD, UNSPECIFIED'),
    imm('x3', '2010-01-01', 'MMR'), // two existing MMR that day: a tie
    imm('x4', '2030-01-01', 'NEW'),
  ]);
  expect(out.map((m) => m?.id)).toEqual(['a', 'c', undefined, undefined]);
  // two incoming lines claiming the same existing dose: neither is paired
  expect(pairImmunizations(existing, [imm('y1', '2001-09-01', 'Td, unspecified'), imm('y2', '2001-09-01', 'TD unspecified')]).map((m) => m?.id)).toEqual([undefined, undefined]);
});
