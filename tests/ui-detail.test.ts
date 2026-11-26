import type { Resource } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { LINK_ONLY, makeDetails, say } from '../src/ui/detail.ts';
import { geneticTest } from '../src/identity.ts';
import { seriesKey } from '../src/ui/timeline.ts';

const P = { reference: 'Patient/p' };
const lab = (id: string, t: string, v: number, extra: object = {}): Resource => ({ resourceType: 'Observation', id, status: 'final', subject: P, effectiveDateTime: t,
  category: [{ coding: [{ code: 'laboratory' }] }], code: { text: 'LDL', coding: [{ system: 'http://loinc.org', code: '13457-7' }] },
  valueQuantity: { value: v, unit: 'mg/dL' }, referenceRange: [{ low: { value: 50 }, high: { value: 129 }, text: '50 - 129 mg/dL' }], encounter: { reference: 'Encounter/e1' }, ...extra });
const vital = (id: string, name: string, specific: string, v: number): Resource => ({ resourceType: 'Observation', id, status: 'final', subject: P, effectiveDateTime: '2024-03-01T10:00:00Z',
  category: [{ coding: [{ code: 'vital-signs' }] }], code: { text: name, coding: [{ system: 'http://loinc.org', code: '8716-3' }, { system: 'http://loinc.org', code: specific }] },
  valueQuantity: { value: v, unit: '/min' }, encounter: { reference: 'Encounter/e1' } });
const all: Resource[] = [
  { resourceType: 'Encounter', id: 'e1', status: 'finished', class: { code: 'AMB', display: 'Appointment' }, type: [{ text: 'Office Visit' }], subject: P, period: { start: '2024-03-01T10:00:00Z', end: '2024-03-01T10:30:00Z' },
    participant: [{ type: [{ text: 'referrer' }], individual: { display: 'Dr A' } }, { type: [{ text: 'attender' }], individual: { display: 'Dr A' } }], account: [{ display: 'ACCOUNT NAME' }] },
  lab('l1', '2023-03-01', 140, { interpretation: [{ coding: [{ code: 'H' }] }], note: [{ text: 'fasting sample' }] }), lab('l2', '2024-03-01', 90),
  vital('v1', 'Pulse', '8867-4', 64), vital('v2', 'Respirations', '9279-1', 14),
  { resourceType: 'Condition', id: 'c1', subject: P, code: { text: 'Hypertension' }, category: [{ coding: [{ code: 'encounter-diagnosis' }] }], encounter: { reference: 'Encounter/e1' }, recordedDate: '2024-03-01' },
  { resourceType: 'DocumentReference', id: 'n1', status: 'current', subject: P, type: { text: 'Progress Notes' }, category: [{ coding: [{ code: 'clinical-note' }] }], date: '2024-03-01T11:00:00Z',
    author: [{ display: 'Dr A' }], content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Doing well. Return in a year.').toString('base64') } }], context: { encounter: [{ reference: 'Encounter/e1' }] } },
  { resourceType: 'Immunization', id: 'i1', status: 'completed', patient: P, vaccineCode: { text: 'Influenza', coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '150' }] }, occurrenceDateTime: '2024-10-01',
    lotNumber: 'LOT42', manufacturer: { display: 'Maker Inc' }, site: { text: 'Left arm' }, route: { text: 'Intramuscular' }, doseQuantity: { value: 0.5, unit: 'mL' } },
  { resourceType: 'MedicationRequest', id: 'm1', status: 'active', intent: 'order', subject: P, medicationCodeableConcept: { text: 'atorvastatin 20 mg tablet' }, authoredOn: '2024-03-01', requester: { display: 'Dr A' },
    dosageInstruction: [{ text: 'Take 1 tablet nightly', patientInstruction: 'With water', route: { text: 'Oral' } }], dispenseRequest: { numberOfRepeatsAllowed: 3, quantity: { value: 90, unit: 'tablet' } }, encounter: { reference: 'Encounter/e1' } },
  { resourceType: 'DiagnosticReport', id: 'r1', status: 'final', subject: P, code: { text: 'SURGICAL PATHOLOGY' }, category: [{ text: 'Pathology' }], effectiveDateTime: '2024-03-02', conclusion: 'Benign.',
    result: [{ reference: 'Observation/px' }], presentedForm: [{ contentType: 'text/html', url: 'https://hospital.example/Binary/1' }] },
  { resourceType: 'Observation', id: 'px', status: 'final', subject: P, effectiveDateTime: '2024-03-02', category: [{ coding: [{ code: 'laboratory' }] }], code: { text: 'Narrative' }, valueString: `Final diagnosis: ${'tubular adenoma. '.repeat(12)}` },
  { resourceType: 'AllergyIntolerance', id: 'a1', patient: P, code: { text: 'Penicillin' }, recordedDate: '2010-01-01', reaction: [{ manifestation: [{ text: 'Rash' }] }] },
];
const detail = makeDetails(all);
const flat = (d: unknown) => JSON.stringify(d);

test('say: plain words for any value, never a code, id or address', () => {
  expect(say({ coding: [{ system: 'http://loinc.org', code: '1234-5' }] })).toBeUndefined();
  expect(say({ text: 'Left arm', coding: [{ code: 'LA' }] })).toBe('Left arm');
  expect(say({ reference: 'Practitioner/1', display: 'Dr A' })).toBe('Dr A');
  expect(say({ value: 0.5, unit: 'mL', system: 'urn:x', code: '1' })).toBe('0.5 mL');
  expect(say({ start: '2024-03-01', end: '2024-03-02' })).toBe('2024-03-01 – 2024-03-02');
  expect(say([{ numberOfRepeatsAllowed: 3, quantity: { value: 90, unit: 'tablet' } }])).toBe('number of repeats allowed 3, quantity 90 tablet');
});

test('a visit lists what was recorded at it, each kind in its own form; one person is named once', () => {
  const d = detail({ ref: 'Encounter/e1' })!;
  expect(d.kind).toBe('Visit');
  expect(d.facts).toContainEqual(['With', 'Dr A (referrer, attender)']);
  expect(flat(d)).not.toMatch('ACCOUNT NAME');
  expect(d.sections.map((s) => s.title)).toEqual(['Diagnoses at visits', 'Notes', 'Medications', 'Lab tests', 'Vital signs (clinic)']);
  const vitals = d.sections.find((s) => s.title === 'Vital signs (clinic)')!;
  expect(vitals.type === 'table' && vitals.rows.map((r) => [(r[0] as { v: string }).v, r[1]])).toEqual([['Pulse', '64 /min'], ['Respirations', '14 /min']]);
});

test('vital signs with the generic vital-signs code first are still separate series', () => {
  expect(seriesKey(all[3] as never)).toBe('8867-4');
  expect(seriesKey(all[4] as never)).toBe('9279-1');
});

test('a number over time: a chart with the usual range, every result with its flag and comment', () => {
  const d = detail({ series: '13457-7' })!;
  expect(d.facts).toContainEqual(['Latest', '90 mg/dL']);
  const chart = d.sections.find((s) => s.type === 'series')!;
  expect(chart.type === 'series' && chart.points).toEqual([['2023-03-01', [140], 50, 129, 'high'], ['2024-03-01', [90], 50, 129, '']]);
  const rows = d.sections.find((s) => s.title === 'Every result')!;
  expect(rows.type === 'table' && rows.rows[1]).toEqual([{ v: '2023-03-01', q: 'ref=Observation/l1' }, { v: '140 mg/dL (high)', alert: true }, '50 - 129 mg/dL', 'fasting sample']);
});

test('text is read as text: a note, a report conclusion, a long result; a report with only a hospital link says so', () => {
  expect(detail({ ref: 'DocumentReference/n1' })!.sections[0]).toMatchObject({ type: 'text', text: 'Doing well. Return in a year.' });
  const r = detail({ ref: 'DiagnosticReport/r1' })!;
  expect(r.sections.map((s) => [s.title, s.type])).toEqual([['Conclusion', 'text'], ['Narrative', 'text']]); // its long result is its text
  const bare = makeDetails([{ resourceType: 'DiagnosticReport', id: 'b1', status: 'final', subject: P, code: { text: 'XR Hand' }, effectiveDateTime: '2011-09-13', presentedForm: [{ contentType: 'text/html', url: 'https://hospital.example/Binary/3' }] }]);
  expect(bare({ ref: 'DiagnosticReport/b1' })!.sections).toEqual([{ title: 'Full text', type: 'text', text: LINK_ONLY }]);
});

test('a link-only imaging report reads the imaging note of its day, and says the match is by date', () => {
  const report: Resource = { resourceType: 'DiagnosticReport', id: 'x1', status: 'final', subject: P, code: { text: 'XR Hand' }, category: [{ text: 'Imaging' }], effectiveDateTime: '2011-09-13T14:00:00Z', presentedForm: [{ contentType: 'text/html', url: 'https://hospital.example/Binary/2' }] };
  const note: Resource = { resourceType: 'DocumentReference', id: 'x2', status: 'current', subject: P, type: { text: 'Diagnostic imaging study' }, category: [{ coding: [{ code: 'clinical-note' }] }], date: '2011-09-13T15:00:00Z',
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Type: Hand Min 3 Views. No fracture.').toString('base64') } }] };
  const d = makeDetails([report, note])({ ref: 'DiagnosticReport/x1' })!;
  expect(d.sections[0]).toMatchObject({ title: 'Text, from the imaging note of that day', text: 'Type: Hand Min 3 Views. No fracture.' });
  expect(d.sections[1]).toMatchObject({ note: 'The report itself arrived as a link only; GA matched this note to it by date.' });
  expect(JSON.stringify(d)).not.toMatch('holds only a link');
});

test('an event keeps its particulars: vaccine lot and site, prescription directions and supply', () => {
  const i = flat(detail({ ref: 'Immunization/i1' }));
  for (const s of ['LOT42', 'Maker Inc', 'Left arm', 'Intramuscular', '0.5 mL']) expect(i).toMatch(s);
  const m = detail({ ref: 'MedicationRequest/m1' })!;
  expect(m.facts).toEqual(expect.arrayContaining([['Directions', 'Take 1 tablet nightly'], ['Instructions to the patient', 'With water'], ['Route', 'Oral'], ['Ordered by', 'Dr A'], ['Supply', 'number of repeats allowed 3, quantity 90 tablet']]));
  expect(detail({ course: 'atorvastatin' })!.facts).toContainEqual(['Directions (latest)', 'Take 1 tablet nightly']);
});

test('every record is reachable from "All records", whatever its type', () => {
  const seen = new Set<string>(), queue = ['list=index'], reached = new Set<string>();
  while (queue.length) {
    const q = queue.pop()!;
    if (seen.has(q)) continue;
    seen.add(q);
    const i = q.indexOf('='), d = detail({ [q.slice(0, i)]: q.slice(i + 1) });
    expect(d, q).toBeDefined();
    if (q.startsWith('ref=')) reached.add(q.slice(4));
    for (const s of d!.sections) if (s.type === 'table') for (const row of s.rows) for (const c of row) if (typeof c === 'object' && c.q) queue.push(c.q);
  }
  for (const r of all) expect(reached, `${r.resourceType}/${r.id}`).toContain(`${r.resourceType}/${r.id}`);
  expect(flat(detail({ ref: 'AllergyIntolerance/a1' }))).toMatch('Rash');
});

test('genetic test results have their own kind in "All records"', () => {
  const lab = (id: string, text: string, value: string): Resource =>
    ({ resourceType: 'Observation', id, status: 'final', subject: { reference: 'Patient/p' }, category: [{ coding: [{ code: 'laboratory' }] }], code: { text }, valueString: value, effectiveDateTime: '2023-02-01' }) as Resource;
  const d = makeDetails([lab('g1', 'Clinical Exome Sequence Analysis, result', 'Negative'), lab('g2', 'Exome sequencing: copy number variants (CNV)', 'Not performed'), lab('l1', 'Urine colour', 'Yellow'),
    { resourceType: 'DiagnosticReport', id: 'r1', status: 'final', subject: { reference: 'Patient/p' }, category: [{ coding: [{ code: 'GE' }] }], code: { text: 'Panel 12' }, effectiveDateTime: '2023-02-01' } as Resource]);
  const kinds = Object.fromEntries((d({ list: 'index' })!.sections[0] as unknown as { rows: { v: string }[][] }).rows.map((r) => [r[0].v, r[1]]));
  expect(kinds).toMatchObject({ 'Genetic tests': '2', 'Genetic test reports': '1', 'Lab tests': '1' });
  expect(JSON.stringify(d({ list: 'Genetic tests' }))).toMatch(/Exome sequencing: copy number variants/);
  expect(geneticTest({ code: { text: 'Fishing injury' } })).toBe(false); // whole words only
  expect(geneticTest({ code: { text: 'Hemoglobin' } })).toBe(false);
  expect(geneticTest({ code: { text: 'Chromosomal microarray' } })).toBe(true);
});

