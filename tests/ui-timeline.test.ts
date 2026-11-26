import type { Resource } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { cardiacStudy } from '../src/identity.ts';
import { buildTimeline, drugKey, encounterKind } from '../src/ui/timeline.ts';

const cat = (...codes: string[]) => codes.map((code) => ({ coding: [{ code }] }));
const enc = (id: string, cls: string, types: string[], start: string, end = start): Resource => ({ resourceType: 'Encounter', id, status: 'finished', class: { display: cls }, type: types.map((t) => ({ coding: [{ display: t }] })), period: { start, end } });

test('cardiacStudy: Epic echo and ECG section categories, not labs or imaging in general', () => {
  expect(cardiacStudy({ category: [{ coding: [{ code: 'laboratory' }] }, { coding: [{ code: 'Echo', display: 'Echocardiography' }], text: 'Echocardiography' }] })).toBe('echo');
  expect(cardiacStudy({ category: [{ coding: [{ code: 'laboratory' }] }, { coding: [{ code: 'ECG' }] }] })).toBe('ecg');
  expect(cardiacStudy({ category: [{ text: 'EKG' }] })).toBe('ecg');
  expect(cardiacStudy({ category: [{ coding: [{ code: 'laboratory' }] }, { coding: [{ code: 'Lab' }] }] })).toBeUndefined();
  expect(cardiacStudy({ category: [{ coding: [{ code: 'imaging' }] }] })).toBeUndefined();
  expect(cardiacStudy({})).toBeUndefined();
});

test('encounterKind: standard classes, Epic classes, and a stay of a day or more', () => {
  const k = (cls: string, types: string[], hours = 0) => encounterKind(enc('e', cls, types, '2020-01-01T10:00:00Z', new Date(Date.parse('2020-01-01T10:00:00Z') + hours * 3.6e6).toISOString()) as never);
  expect(k('Appointment', ['Office Visit'], 0.5)).toBe('visit');
  expect(k('HOV', ['Outpatient', 'Hospital Encounter', 'CT FACE'], 1)).toBe('hospital');
  expect(k('Support OP Encounter', ['Refill'])).toBe('contact');
  expect(k('Support OP Encounter', ['Telephone'])).toBe('contact');
  expect(k('Discharge', ['Day Surgery', 'Hospital Encounter'], 4)).toBe('procedure');
  expect(k('Surgery Log', ['Surgery'])).toBe('procedure');
  expect(k('Discharge', ['Hospital Encounter'], 60)).toBe('inpatient');
  expect(k('IMP', [])).toBe('inpatient');
  expect(k('EMER', [])).toBe('emergency');
  expect(k('Emergency', ['Hospital Encounter'], 5)).toBe('emergency');
});

test('drugKey: one course per drug whatever the strength', () => {
  expect(drugKey('sertraline 100 mg tablet')).toBe(drugKey('Sertraline 50 MG tablet'));
  expect(drugKey('aspirin-acetaminophen-caffeine 250-250-65 mg per tablet')).toBe('aspirin-acetaminophen-caffeine');
  expect(drugKey('tirzepatide (weight loss) 2.5 mg/0.5 mL pen')).toBe('tirzepatide');
});

test('buildTimeline: pairs doubled records, keeps echo measurements out of labs, counts what it leaves out', () => {
  const lab = (id: string, name: string, value: number, t: string, extra: object = {}): Resource => ({ resourceType: 'Observation', id, status: 'final', category: cat('laboratory', 'Lab'), code: { text: name }, valueQuantity: { value, unit: 'mg/dL' }, effectiveDateTime: t, ...extra }) as Resource;
  const all: Resource[] = [
    enc('d1', 'Discharge', ['Outpatient', 'Hospital Encounter'], '2022-08-16T13:13:00Z', '2022-08-16T17:36:00Z'),
    enc('d2', 'Surgery Log', ['Surgery'], '2022-08-16'),
    enc('v1', 'Appointment', ['Office Visit', 'PATIENT ENCOUNTER PROCEDURE'], '2023-01-05T15:00:00Z', '2023-01-05T15:30:00Z'),
    enc('r1', 'Support OP Encounter', ['Refill'], '2023-02-01'),
    { resourceType: 'Procedure', id: 'p1', status: 'completed', category: { coding: [{ code: '103693007' }] }, code: { text: 'Endoscopy, Colon (ENDOSCOPY, COLON)' }, performedDateTime: '2022-08-16T14:39:28Z' },
    { resourceType: 'Procedure', id: 'p2', status: 'completed', category: { coding: [{ code: '387713003' }] }, code: { text: 'COLONOSCOPY' }, performedDateTime: '2022-08-16T14:50:00Z' },
    { resourceType: 'Procedure', id: 'p3', status: 'completed', category: { coding: [{ code: '103693007' }] }, code: { text: 'ECHO COMPLETE TTE' }, performedDateTime: '2021-11-01T13:00:00Z' },
    { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final', category: [{ coding: [{ code: 'Echo' }] }, { coding: [{ code: 'LP29708-2', display: 'Cardiology' }] }], code: { text: 'Adult Echo TTE' }, basedOn: [{ display: 'ECHO COMPLETE TTE' }], effectiveDateTime: '2021-11-01T13:48:12Z', result: [{ reference: 'Observation/o1' }] },
    { resourceType: 'DiagnosticReport', id: 'dr2', status: 'final', category: [{ coding: [{ code: 'Lab' }] }], code: { text: 'Lipid panel' }, effectiveDateTime: '2021-04-09T20:29:00Z' },
    { resourceType: 'Observation', id: 'o1', status: 'final', category: cat('laboratory', 'Echo'), code: { text: 'LEFT VENTRICULAR MASS' }, valueQuantity: { value: 180, unit: 'g' }, effectiveDateTime: '2021-11-01T13:48:12Z' },
    lab('l1', 'CALCULATED LDL', 137, '2014-04-30T20:29:00Z', { referenceRange: [{ low: { value: 50 }, high: { value: 129 } }] }),
    lab('l2', 'CALCULATED LDL', 56, '2025-09-29T17:54:00Z'),
    { resourceType: 'Condition', id: 'c1', category: cat('problem-list-item'), code: { text: 'Essential hypertension' }, onsetDateTime: '2019-11-25', subject: {} },
    { resourceType: 'Condition', id: 'c2', category: cat('encounter-diagnosis'), code: { text: 'Snoring' }, encounter: { reference: 'Encounter/v1' }, subject: {} },
    { resourceType: 'MedicationRequest', id: 'm1', status: 'stopped', intent: 'order', category: cat('community'), medicationReference: { display: 'sertraline 50 mg tablet' }, authoredOn: '2016-03-15', subject: {} },
    { resourceType: 'MedicationRequest', id: 'm2', status: 'active', intent: 'order', category: cat('community'), medicationReference: { display: 'sertraline 100 mg tablet' }, authoredOn: '2025-12-30', subject: {} },
    { resourceType: 'MedicationRequest', id: 'm3', status: 'completed', intent: 'order', category: cat('inpatient'), medicationReference: { display: 'fentanyl (PF)' }, authoredOn: '2022-08-16T14:00:00Z', subject: {} },
    { resourceType: 'DocumentReference', id: 'n1', status: 'current', category: cat('clinical-note'), type: { text: 'Progress Notes' }, date: '2023-01-05T16:00:00Z', content: [] },
    { resourceType: 'DocumentReference', id: 'n2', status: 'current', category: cat('summary-document'), type: { text: 'Encounter Summary' }, date: '2023-01-05T16:00:00Z', content: [] },
    { resourceType: 'Observation', id: 'a1', status: 'final', meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }] }, code: { text: 'Body weight' }, valueQuantity: { value: 86, unit: 'kg' }, effectiveDateTime: '2025-10-12T07:00:00-04:00' },
    { resourceType: 'Observation', id: 'x1', status: 'unknown', category: cat('smartdata', 'exam'), code: { text: 'OPHTH SLE OD CORNEA NORMAL' } },
  ] as Resource[];
  const t = buildTimeline(all, '2026-11-23');
  expect(t.encounters.map((e) => e.kind)).toEqual(['procedure', 'visit', 'contact']); // the surgery log is the day procedure's second record
  expect(t.encounters[0].end).toBe('2022-08-16T17:36:00Z');
  expect(t.procedures.map((p) => p.label)).toEqual(['Colonoscopy']); // the order-based record is folded; the echo is a study
  expect(t.procedures[0].also).toEqual(['Endoscopy, Colon (ENDOSCOPY, COLON)']);
  expect(t.procedures[0].rows).toContainEqual(['Drugs given that day', 'fentanyl (PF)']);
  expect(t.studies).toHaveLength(1);
  expect(t.studies[0]).toMatchObject({ kind: 'echo', label: 'Adult Echo TTE', rows: [['Left Ventricular Mass', '180 g']] });
  expect(t.labs).toHaveLength(1); // the echo measurement, filed "laboratory" by Epic, is not a lab series
  expect(t.labs[0].points.map((p) => [p[1], p[4]])).toEqual([[137, 'high'], [56, '']]);
  expect(t.problems.map((p) => p.label)).toEqual(['Essential hypertension']);
  expect(t.diagnoses).toEqual([{ label: 'Snoring', dates: ['2023-01-05'] }]);
  expect(t.medications).toHaveLength(1);
  expect(t.medications[0]).toMatchObject({ label: 'sertraline', current: true, t: '2016-03-15', end: '2026-11-23' });
  expect(t.medications[0].orders).toHaveLength(2);
  expect(t.notes.map((n) => n.label)).toEqual(['Progress Notes']);
  expect(t.wearables.map((w) => [w.key, w.points.length])).toEqual([['weight', 1]]);
  expect(t.left).toMatchObject({ 'encounter summary documents': 1, 'hospital observations without a date (exam findings)': 1, 'second encounter records of a day procedure (the surgery log)': 1 });
  expect(t.min).toBe('2014-04-30');
});

test('buildTimeline: a child\'s growth measures get lanes; systolic and diastolic filed apart are one reading', () => {
  const vital = (id: string, code: string, text: string, value: number, unit: string, when: string): Resource =>
    ({ resourceType: 'Observation', id, status: 'final', category: cat('vital-signs'), code: { coding: [{ system: 'http://loinc.org', code }], text }, valueQuantity: { value, unit, code: unit }, effectiveDateTime: when }) as Resource;
  const t = buildTimeline([
    vital('h1', '8302-2', 'Body height', 97.2, 'cm', '2024-09-10T16:11:00Z'),
    vital('h2', '8302-2', 'Body height', 40, '[in_i]', '2025-03-10T16:11:00Z'),
    vital('c1', '8287-5', 'Head Occipital-frontal circumference by Tape measure', 47, 'cm', '2023-01-05T15:00:00Z'),
    vital('c2', '8289-1', 'Head Occipital-frontal circumference Percentile', 60, '%', '2023-01-05T15:00:00Z'),
    vital('b1', '59576-9', 'Body mass index (BMI) [Percentile] Per age and sex', 42, '%', '2024-09-10T16:11:00Z'),
    vital('s1', '8480-6', 'Systolic blood pressure', 98, 'mm[Hg]', '2024-09-10T16:11:00Z'),
    vital('d1', '8462-4', 'Diastolic blood pressure', 61, 'mm[Hg]', '2024-09-10T16:11:00Z'),
    vital('s2', '8480-6', 'Systolic blood pressure', 101, 'mm[Hg]', '2025-06-01T10:00:00Z'), // no diastolic at that instant
    { resourceType: 'Observation', id: 'p1', status: 'final', category: cat('vital-signs'), code: { text: 'Blood pressure' }, effectiveDateTime: '2024-09-10T16:11:00Z',
      component: [{ code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 98 } }, { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 61 } }] } as Resource,
  ], '2026-11-23');
  const lane = (k: string) => t.wearables.find((w) => w.key === k)?.clinic.map((p) => [p[1], p[2]]);
  expect(lane('height')).toEqual([[97.2, undefined], [101.6, undefined]]); // inches converted
  expect(lane('head')).toEqual([[47, undefined]]); // the percentile is not a circumference
  expect(lane('bmiPct')).toEqual([[42, undefined]]);
  expect(lane('bp')).toEqual([[98, 61]]); // the pair repeats the record that has both parts: once
  expect(t.left).toMatchObject({ 'clinic blood pressures with only one of systolic and diastolic': 1 });
  // z-scores only when the person's sex and birth date are given: one per weight and height that has a reference at that age
  expect(t.wearables.some((w) => w.key === 'heightZ')).toBe(false);
  const child = buildTimeline([vital('h1', '8302-2', 'Body height', 97.2, 'cm', '2024-09-10T16:11:00Z'), vital('w1', '29463-7', 'Body weight', 16.5, 'kg', '2024-09-10T16:11:00Z')], '2026-11-23', { gender: 'male', birthDate: '2020-05-10' });
  const z = (k: string) => child.wearables.find((w) => w.key === k);
  expect(z('heightZ')?.computed).toMatch(/computed by GA/);
  expect(z('heightZ')?.clinic.map((p) => p[3])).toEqual(['h1']); // a click opens the reading it was computed from
  expect(z('weightZ')?.clinic[0][1]).toBeGreaterThan(-1);
  expect(z('weightZ')?.clinic[0][1]).toBeLessThan(1);
  // a weight ten times too large: its z-score is set aside (a question mark on the page), the weight itself stays in its lane
  const typo = buildTimeline([vital('w1', '29463-7', 'Body weight', 5.2, 'kg', '2020-08-01T16:00:00Z'), vital('w2', '29463-7', 'Body weight', 52, 'kg', '2020-08-05T16:00:00Z')], '2026-11-23', { gender: 'male', birthDate: '2020-05-10' });
  const wz = typo.wearables.find((w) => w.key === 'weightZ');
  expect(wz?.clinic.map((p) => p[3])).toEqual(['w1']);
  expect(wz?.doubted).toMatchObject([{ id: 'w2', why: expect.stringMatching(/more than 4 standard deviations/) }]);
  expect(typo.wearables.find((w) => w.key === 'weight')?.clinic).toHaveLength(2);
});
