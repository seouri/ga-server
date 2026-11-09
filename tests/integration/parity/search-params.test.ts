// Medplum 5.2.14 packages/server/src/fhir/search-params.test.ts, ported side by side (see harness.ts).
// Medplum gives each test a fresh project; here the file shares one, swept of these types before the run.
import type { Appointment, Bundle, Practitioner, Slot } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { names, paritySides, q, same, search, type Side } from './harness.ts';

const ref = (r: { resourceType: string; id: string }) => ({ reference: `${r.resourceType}/${r.id}` });

describe.skipIf(SQLITE)('Medplum Custom Search Parameters (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  test('Medplum Custom Search Parameters › Search by Appointment.end [server/src/fhir/search-params.test.ts]', () => same(sides, async (s) => {
    const [start1, end1, start2, end2] = ['1970-01-01T12:00:00.000Z', '1970-01-01T13:00:00.000Z', '1970-01-01T13:00:00.000Z', '1970-01-01T14:00:00.000Z'];
    const practitioner = await s.create<Practitioner>({ resourceType: 'Practitioner', name: [{ prefix: ['Dr.'], given: ['Alice'], family: 'Smith' }] });
    const base: Appointment = {
      resourceType: 'Appointment', status: 'booked',
      participant: [{ type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' }] }], actor: ref(practitioner), status: 'accepted' }],
      appointmentType: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0276', code: 'FOLLOWUP', display: 'A follow up visit from a previous appointment' }] },
    };
    const appointment1 = await s.create({ ...base, start: start1, end: end1 });
    const appointment2 = await s.create({ ...base, start: start2, end: end2 });
    const results1 = await search(s, q('Appointment', ['date', `ge${start1}`], ['end', `le${start2}`]));
    expect(results1.entry).toHaveLength(1);
    expect(results1.entry?.[0].resource?.id).toBe(appointment1.id);
    const results2 = await search(s, q('Appointment', ['date', `ge${start1}`], ['end', `le${end2}`]));
    expect(results2.entry).toHaveLength(2);
    return [names(results1, { appointment1, appointment2 }), names(results2, { appointment1, appointment2 }).sort()];
  }));

  test('Medplum Custom Search Parameters › Search by Slot.end [server/src/fhir/search-params.test.ts]', () => same(sides, async (s) => {
    const [start1, end1, start2, end2] = ['1970-01-01T12:00:00.000Z', '1970-01-01T13:00:00.000Z', '1970-01-01T13:00:00.000Z', '1970-01-01T14:00:00.000Z'];
    await s.create<Practitioner>({ resourceType: 'Practitioner', name: [{ prefix: ['Dr.'], given: ['Alice'], family: 'Smith' }] });
    const base: Slot = { resourceType: 'Slot', status: 'free', schedule: { reference: 'Schedule/123' }, start: new Date().toISOString(), end: new Date().toISOString() };
    const slot1 = await s.create({ ...base, start: start1, end: end1 });
    const slot2 = await s.create({ ...base, start: start2, end: end2 });
    const results1 = await search(s, q('Slot', ['start', `ge${start1}`], ['end', `le${start2}`]));
    expect(results1.entry).toHaveLength(1);
    expect(results1.entry?.[0].resource?.id).toBe(slot1.id);
    const results2 = await search(s, q('Slot', ['start', `ge${start1}`], ['end', `le${end2}`]));
    expect(results2.entry).toHaveLength(2);
    return [names(results1, { slot1, slot2 }), names(results2, { slot1, slot2 }).sort()];
  }));

  // Medplum's NOT_EQUALS on a reference is :not over HTTP (a reference value takes no prefix).
  test('Medplum Custom Search Parameters › Search by DiagnosticReport.study [server/src/fhir/search-params.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }] });
    const study1 = await s.create({ resourceType: 'ImagingStudy', status: 'available', subject: ref(patient) });
    const study2 = await s.create({ resourceType: 'ImagingStudy', status: 'available', subject: ref(patient) });
    const code = { coding: [{ system: 'http://loinc.org', code: '10221-0', display: 'Surgical operation note specimens taken Narrative' }], text: 'Surgical operation note specimens taken Narrative' };
    const report1 = await s.create({ resourceType: 'DiagnosticReport', imagingStudy: [ref(study1)], status: 'final', code });
    const report2 = await s.create({ resourceType: 'DiagnosticReport', imagingStudy: [ref(study2)], status: 'final', code });
    const results1 = await search(s, q('DiagnosticReport', ['study', `ImagingStudy/${study1.id}`]));
    expect(results1.entry).toHaveLength(1);
    expect(results1.entry?.[0].resource?.id).toBe(report1.id);
    const results2 = await search(s, q('DiagnosticReport', ['study:not', `ImagingStudy/${study1.id}`]));
    expect(results2.entry).toHaveLength(1);
    expect(results2.entry?.[0].resource?.id).toBe(report2.id);
    return [names(results1, { report1, report2 }), names(results2, { report1, report2 })];
  }));

  test('Medplum Custom Search Parameters › Search by Flag.category [server/src/fhir/search-params.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const flag = (code: string, display: string) => s.create({
      resourceType: 'Flag', status: 'active', subject: ref(patient),
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/flag-category', code, display }] }],
      code: { coding: [{ system: 'http://snomed.info/sct', code: '3902000' }] },
    });
    const flag1 = await flag('drug', 'Drug');
    const flag2 = await flag('lab', 'Lab');
    const results = await search(s, q('Flag', ['category', 'http://terminology.hl7.org/CodeSystem/flag-category|drug']));
    expect(results.entry).toHaveLength(1);
    expect(results.entry?.[0].resource?.id).toBe(flag1.id);
    return names(results, { flag1, flag2 });
  }));

  test('Medplum Custom Search Parameters › Search for Practitioner by qualification-code [server/src/fhir/search-params.test.ts]', () => same(sides, async (s) => {
    const qual = (code: string, display: string) => [{ code: { coding: [{ code, system: 'http://terminology.hl7.org/CodeSystem/v2-0360', display }] } }];
    const practitioner1 = await s.create<Practitioner>({ resourceType: 'Practitioner', name: [{ given: ['Alice'], family: 'A' }], qualification: qual('MD', 'Doctor of Medicine') });
    const practitioner2 = await s.create<Practitioner>({ resourceType: 'Practitioner', name: [{ given: ['Bob'], family: 'B' }], qualification: qual('RN', 'Registered Nurse') });
    const result = await search(s, q('Practitioner', ['qualification-code', 'MD']));
    expect(result.entry).toHaveLength(1);
    expect(result.entry?.[0]?.resource).toMatchObject(practitioner1);
    return names(result, { practitioner1, practitioner2 });
  }));

  test('Medplum Custom Search Parameters › Search for PractitionerRole by network [server/src/fhir/search-params.test.ts]', () => same(sides, async (s) => {
    const network1 = await s.create({ resourceType: 'Organization', name: 'Network One' });
    const network2 = await s.create({ resourceType: 'Organization', name: 'Network Two' });
    const role = (n: { resourceType: string; id: string }) => s.create({
      resourceType: 'PractitionerRole', extension: [{ url: 'http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/network-reference', valueReference: ref(n) }],
    });
    const role1 = await role(network1);
    const role2 = await role(network2);
    const result = await search(s, q('PractitionerRole', ['network', `Organization/${network1.id}`]));
    expect(result.entry).toHaveLength(1);
    expect(result.entry?.[0]?.resource).toMatchObject(role1);
    return names(result, { role1, role2 });
  }));

  test('Medplum Custom Search Parameters › Search for CoverageEligibilityRequest by coverage [server/src/fhir/search-params.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const insurer = await s.create({ resourceType: 'Organization', name: 'Insurer' });
    const coverage = () => s.create({ resourceType: 'Coverage', status: 'active', beneficiary: ref(patient), payor: [ref(insurer)] });
    const coverage1 = await coverage();
    const coverage2 = await coverage();
    const request = (...cs: { resourceType: string; id: string }[]) => s.create({
      resourceType: 'CoverageEligibilityRequest', status: 'active', purpose: ['validation'], patient: ref(patient), created: new Date().toISOString(),
      insurer: ref(insurer), insurance: cs.map((c) => ({ coverage: ref(c) })),
    });
    const request1 = await request(coverage1);
    const request2 = await request(coverage2);
    const request3 = await request(coverage1, coverage2);
    const result: Bundle = await search(s, q('CoverageEligibilityRequest', ['coverage', `Coverage/${coverage1.id}`]));
    expect(result.entry).toHaveLength(2);
    expect(result.entry?.map((e) => e.resource?.id).sort()).toStrictEqual([request1.id, request3.id].sort());
    return names(result, { request1, request2, request3 }).sort();
  }));
});
