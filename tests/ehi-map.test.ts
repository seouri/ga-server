import { join } from 'node:path';
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
import { linkImmunizationsToExisting, mapFamilyHistory, mapHealthMaintenance, mapImmunizations, mapQuestionnaires, mapSocial, mapVitals } from '../src/ehi/history.ts';
import { mapMeds } from '../src/ehi/meds.ts';
import { mapMessages, mapNotes } from '../src/ehi/documents.ts';

const FIX = join(import.meta.dirname, 'fixtures/ehi');
const t = () => new EhiTables(FIX);
const ctx: EhiCtx = { org: 'synthetic-health', date: '2026-01-17T08:30:00-05:00', epicOrgNumber: '99' };
const SYS = 'urn:ga-server:id:ehi:synthetic-health';
const of = <T extends Resource>(rs: Resource[], type: string) => rs.filter((r) => r.resourceType === type) as T[];

describe('EHI mappers', () => {
  it('ehiDate normalizes the export\'s date formats', () => {
    expect(ehiDate('1/16/2026 12:00:00 AM', ctx)).toBe('2026-01-16');
    expect(ehiDate('1/15/2026 8:05:00 AM', ctx)).toBe('2026-01-15T08:05:00-05:00');
    expect(ehiDate('12/3/2025 12:30:00 PM', ctx)).toBe('2025-12-03T12:30:00-05:00');
    expect(ehiDate('1/5/2026 12:15:00 AM', ctx)).toBe('2026-01-05T00:15:00-05:00');
    expect(ehiDate('1/5/2026 11:59:59 PM', { ...ctx, date: '2026-01-17T08:30:00Z' })).toBe('2026-01-05T23:59:59Z');
    expect(ehiDate('', ctx)).toBeUndefined();
    expect(() => ehiDate('2026-01-05', ctx)).toThrow();
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
      valueCodeableConcept: { text: 'Never' },
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
      resourceType: 'Procedure', id: 'HM_HISTORY-1', identifier: [{ system: SYS, value: 'HM_HISTORY|1' }], status: 'completed',
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
      identifier: [{ system: SYS, value: 'HNO_INFO|1001' }],
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
});
