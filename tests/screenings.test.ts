import { expect, test } from 'vitest';
import type { Observation, Procedure, Resource } from '@medplum/fhirtypes';
import { CONCEPT_SRC } from '../src/concept-apply.ts';
import { evaluateScreenings, loadRules, type ScreenInput } from '../src/screenings.ts';

// Synthetic records only.
const rules = loadRules();
const AS_OF = '2026-11-07';
const base: ScreenInput = { birthDate: '1970-01-01', sex: 'male', records: [] };
const item = (records: Resource[], id: string, input: Partial<ScreenInput> = {}) =>
  evaluateScreenings(rules, { ...base, ...input, records }, AS_OF).find((x) => x.topic === id)!;
const proc = (date: string, code: Procedure['code'], extra: Partial<Procedure> = {}): Procedure =>
  ({ resourceType: 'Procedure', id: 'p1', status: 'completed', subject: {}, code, performedDateTime: date, ...extra });
const CPT = 'http://www.ama-assn.org/go/cpt';

test('a colonoscopy in any form counts', () => {
  expect(item([proc('2020-03-01', { text: 'Colonoscopy' })], 'colorectal')).toMatchObject({ status: 'done', dueDate: '2030-03-01', last: { date: '2020-03-01', by: 'colonoscopy', id: 'Procedure/p1' } });
  expect(item([proc('2020-03-01', { coding: [{ system: CPT, code: '45378' }] })], 'colorectal')).toMatchObject({ status: 'done', dueDate: '2030-03-01' });
  const fit: Observation = { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '29771-3' }] }, effectiveDateTime: '2026-01-10' };
  // The brief expected 'done', but 2027-01-10 is 64 days after asOf: its own 90-day rule makes it 'due soon'.
  expect(item([fit], 'colorectal')).toMatchObject({ status: 'due soon', dueDate: '2027-01-10', last: { by: 'stool test (FIT or gFOBT)' } });
});

test('the record that covers longest drives the due date', () => {
  const fit: Observation = { resourceType: 'Observation', status: 'final', code: { text: 'Occult blood, stool (FIT)' }, effectiveDateTime: '2026-01-10' };
  expect(item([proc('2020-03-01', { text: 'Colonoscopy' }), fit], 'colorectal')).toMatchObject({ dueDate: '2030-03-01', last: { by: 'colonoscopy' } });
  // "Virtual colonoscopy" names CT colonography: the shorter interval wins for that one record.
  expect(item([proc('2024-03-01', { text: 'CT virtual colonoscopy' })], 'colorectal')).toMatchObject({ dueDate: '2029-03-01', last: { by: 'CT colonography' } });
});

test('due soon within 90 days, overdue past the date', () => {
  expect(item([proc('2016-12-01', { text: 'Colonoscopy' })], 'colorectal')).toMatchObject({ status: 'due soon', dueDate: '2026-12-01' });
  expect(item([proc('2016-01-01', { text: 'Colonoscopy' })], 'colorectal')).toMatchObject({ status: 'overdue', dueDate: '2026-01-01' });
});

test('never done and eligible is due', () => {
  const r = item([], 'colorectal');
  expect(r.status).toBe('due');
  expect(r.dueDate).toBeUndefined();
  expect(r.last).toBeUndefined();
});

test('a suggested code is not evidence', () => {
  const p = proc('2020-03-01', { text: 'Lower GI endoscopy', coding: [{ system: CPT, code: '45378', display: 'Colonoscopy', extension: [{ url: CONCEPT_SRC, valueString: 'suggested' }] }] },
    { meta: { tag: [{ system: 'urn:ga-server:tag', code: 'concept-suggested' }] } });
  expect(item([p], 'colorectal').status).toBe('due');
  // The same GA coding on an untagged record is a confirmed mapping.
  expect(item([{ ...p, meta: {} }], 'colorectal').status).toBe('done');
});

test('records that are not evidence are skipped', () => {
  const p = proc('2020-03-01', { text: 'Colonoscopy' });
  expect(item([{ ...p, status: 'not-done' }], 'colorectal').status).toBe('due');
  expect(item([{ ...p, performedDateTime: '2027-01-01' }], 'colorectal').status).toBe('due');
  expect(item([{ ...p, performedDateTime: undefined }], 'colorectal').status).toBe('due');
  expect(item([{ ...p, performedDateTime: '1960-01-01' }], 'colorectal').status).toBe('due'); // before birth
  expect(item([{ ...p, performedDateTime: undefined, performedPeriod: { start: '2020-03-01' } }], 'colorectal').status).toBe('done');
});

test('Apple Health readings never satisfy blood pressure', () => {
  const tag = (code: string) => ({ meta: { tag: [{ system: 'urn:ga-server:tag', code }] } });
  const bp: Observation = { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] }, effectiveDateTime: '2026-10-01', ...tag('src-ehi') };
  expect(item([bp], 'blood-pressure-40').status).toBe('done');
  // A PDF of home readings (or any non-hospital source) is not a clinic measurement.
  expect(item([{ ...bp, ...tag('src-pdf') }], 'blood-pressure-40').status).toBe('due');
  expect(item([{ ...bp, meta: undefined }], 'blood-pressure-40').status).toBe('due');
  expect(item([{ ...bp, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }] } }], 'blood-pressure-40').status).toBe('due');
  // Apple's copy of a hospital record is the hospital's measurement.
  expect(item([{ ...bp, ...tag('src-apple-clinical') }], 'blood-pressure-40').status).toBe('done');
});

test('out of age range is not for you', () => {
  expect(item([], 'colorectal', { birthDate: '2000-01-01' }).status).toBe('not for you');
  expect(item([], 'cervical', { sex: 'male' }).status).toBe('not for you');
});

test('sex unknown is discuss', () => {
  // Born 1961: 65 on asOf, inside every sex-specific topic's age range (AAA starts at 65).
  for (const id of ['cervical', 'breast', 'prostate', 'aaa']) expect(item([], id, { birthDate: '1961-01-01', sex: undefined }).status).toBe('discuss');
});

test('risk-based topics are discuss with the quoted words', () => {
  const lung = item([], 'lung');
  expect(lung.status).toBe('discuss');
  expect(lung.reason).toContain(rules.topics.find((t) => t.id === 'lung')!.riskBased);
  // A screening already on record that is still current is reported as done.
  expect(item([proc('2026-06-01', { coding: [{ system: CPT, code: '71271' }] })], 'lung')).toMatchObject({ status: 'done', dueDate: '2027-06-01' });
  expect(item([proc('2020-06-01', { coding: [{ system: CPT, code: '71271' }] })], 'lung').status).toBe('discuss');
});

test('grade C reads worth discussing', () => {
  const r = item([], 'prostate', { birthDate: '1966-01-01' });
  expect(r.status).toBe('discuss');
  expect(r.reason).toContain('worth discussing with your doctor');
});

test('every topic cites its source', () => {
  for (const t of rules.topics) {
    expect(t.source).toMatch(/^https:\/\/www\.uspreventiveservicestaskforce\.org\//);
    expect(t.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.why).not.toBe('');
    expect(t.cost).not.toBe('');
  }
  expect(item([], 'hiv').citation).toContain(rules.topics.find((t) => t.id === 'hiv')!.source);
});

const obs = (text: string, date = '2026-06-01'): Observation => ({ resourceType: 'Observation', status: 'final', code: { text }, effectiveDateTime: date });
const female = { birthDate: '1966-01-01', sex: 'female' as const };

test('uncoded names match only the intended test', () => {
  expect(item([obs('Occult Blood, Urine')], 'colorectal').status).toBe('due');
  expect(item([obs('Respirator fit test, N95')], 'colorectal').status).toBe('due');
  expect(item([proc('2026-06-01', { text: 'Reduction mammoplasty' })], 'breast', female).status).toBe('due');
  expect(item([proc('2026-06-01', { text: 'Diagnostic mammogram, left' })], 'breast', female).status).toBe('due');
  expect(item([proc('2026-06-01', { text: 'Excision of papilloma, skin' })], 'cervical', female).status).toBe('due');
  expect(item([obs('Anal Pap smear')], 'cervical', female).status).toBe('due');
  expect(item([proc('2026-06-01', { text: 'Low dose CT abdomen pelvis renal stone' })], 'lung').status).toBe('discuss');

  expect(item([proc('2020-03-01', { text: 'Colonoscopy' })], 'colorectal').status).toBe('done');
  expect(item([obs('FIT', '2026-01-10')], 'colorectal').dueDate).toBe('2027-01-10');
  expect(item([proc('2026-06-01', { text: 'Screening mammogram' })], 'breast', female).status).toBe('done');
  expect(item([obs('Pap smear')], 'cervical', female).status).toBe('done');
  expect(item([proc('2026-06-01', { text: 'Low-dose CT chest lung screening' })], 'lung').status).toBe('done');
  expect(item([obs('HIV-1/2 Ag/Ab, 4th gen')], 'hiv').status).toBe('done');
});

test('an HPV test alone counts only from age 30', () => {
  const young = { birthDate: '2000-01-01', sex: 'female' as const }; // 26 on asOf
  expect(item([obs('HPV, high risk')], 'cervical', young).status).toBe('due');
  expect(item([obs('HPV, high risk')], 'cervical', female)).toMatchObject({ status: 'done', dueDate: '2031-06-01' });
});

test('a hysterectomy or bilateral mastectomy makes the screening a discussion', () => {
  const cerv = item([proc('2015-05-01', { text: 'Total abdominal hysterectomy' }), obs('Pap smear')], 'cervical', female);
  expect(cerv).toMatchObject({ status: 'discuss', reason: expect.stringContaining('hysterectomy on 2015-05-01') });
  expect(item([proc('2015-05-01', { text: 'Supracervical hysterectomy' })], 'cervical', female).status).toBe('due');
  expect(item([proc('2018-02-01', { coding: [{ system: 'http://snomed.info/sct', code: '27865001' }] })], 'breast', female).status).toBe('discuss');
  expect(item([proc('2018-02-01', { text: 'Mastectomy, left' })], 'breast', female).status).toBe('due');
});

test('stopped procedures and absent results are not evidence', () => {
  expect(item([proc('2020-03-01', { text: 'Colonoscopy' }, { status: 'stopped' })], 'colorectal').status).toBe('due');
  expect(item([{ ...obs('FIT'), dataAbsentReason: { text: 'Specimen not received' } }], 'colorectal').status).toBe('due');
});

test('history counts without a date', () => {
  const undated = (extra: Record<string, unknown>, text = 'Total hysterectomy'): Resource => ({ resourceType: 'Procedure', status: 'completed', subject: {}, code: { text }, ...extra } as Procedure);
  for (const r of [
    undated({}),
    undated({ performedString: 'years ago' }),
    { resourceType: 'Condition', subject: {}, code: { text: 'History of hysterectomy' } } as Resource,
    { resourceType: 'Condition', subject: {}, code: { text: 'History of hysterectomy' }, onsetString: 'in her 40s' } as Resource,
    { resourceType: 'Condition', subject: {}, code: { text: 'History of hysterectomy' }, onsetAge: { value: 45, unit: 'a' } } as Resource,
    undated({ performedDateTime: '1900-01-01' }), // placeholder date before birth: counts, never shown
  ]) expect(item([r], 'cervical', female)).toMatchObject({ status: 'discuss', reason: expect.stringMatching(/^Your record shows hysterectomy;/) });
  expect(item([undated({}, 'Double mastectomy')], 'breast', female).status).toBe('discuss');
  expect(item([undated({ status: 'entered-in-error' })], 'cervical', female).status).toBe('due');
  expect(item([{ resourceType: 'Condition', subject: {}, code: { text: 'History of hysterectomy' }, verificationStatus: { coding: [{ code: 'refuted' }] } } as Resource], 'cervical', female).status).toBe('due');
});

test('HIV, lung, AAA and FIT names need the test itself', () => {
  for (const t of ['HIV counseling', 'HIV screening declined', 'HIV risk assessment']) expect(item([obs(t)], 'hiv').status).toBe('due');
  for (const t of ['HIV 1/2 Ab, with reflex to RNA', 'HIV-1/2 Ag/Ab screen with reflex to HIV-1 RNA']) expect(item([obs(t)], 'hiv').status).toBe('done');
  const older = { birthDate: '1960-01-01' };
  for (const t of ['Lung cancer screening shared decision making visit', 'Counseling for lung cancer screening']) expect(item([proc('2026-06-01', { text: t })], 'lung').last).toBeUndefined();
  expect(item([proc('2026-06-01', { text: 'CT CHEST LUNG SCREENING WO CONTRAST' })], 'lung').status).toBe('done');
  for (const t of ['Echo aortic root ultrasound', 'Ultrasound aortic valve']) expect(item([proc('2026-06-01', { text: t })], 'aaa', older).last).toBeUndefined();
  expect(item([proc('2026-06-01', { text: 'US aorta AAA screening' })], 'aaa', older).status).toBe('done');
  expect(item([obs('Fit for duty')], 'colorectal').status).toBe('due');
  expect(item([proc('2026-06-01', { text: 'Colonoscopy referral' })], 'colorectal').status).toBe('due');
});

test('common screening names in other spellings count', () => {
  for (const t of ['Mammography, bilateral', 'MAM SCREEN BILAT', 'Breast tomosynthesis screening']) expect(item([proc('2026-06-01', { text: t })], 'breast', female).status).toBe('done');
  expect(item([obs('Liquid-based gynecologic cytology')], 'cervical', female).status).toBe('done');
});

test('orders, refusals and conversations are never evidence', () => {
  for (const t of ['HIV test refused', 'HIV screen not performed', 'HIV screening ordered', 'HIV screening discussed']) expect(item([obs(t)], 'hiv').status).toBe('due');
  const never = { 'Colonoscopy scheduled': 'colorectal', 'FIT kit offered': 'colorectal', 'Colonoscopy deferred': 'colorectal', 'Sigmoidoscopy not done': 'colorectal',
    'Colonoscopy cancelled': 'colorectal', 'Colon cancer screening education: colonoscopy': 'colorectal', 'Reminder: colonoscopy due': 'colorectal', 'Colonoscopy overdue': 'colorectal' };
  for (const [t, id] of Object.entries(never)) expect(item([proc('2026-06-01', { text: t })], id).status, t).toBe('due');
  expect(item([proc('2026-06-01', { text: 'Mammogram ordered' })], 'breast', female).status).toBe('due');
  expect(item([obs('Pap smear declined')], 'cervical', female).status).toBe('due');
  expect(item([obs('Pap smear counseling')], 'cervical', female).status).toBe('due');
  expect(item([proc('2026-06-01', { text: 'Low dose CT chest: risk assessment' })], 'lung').last).toBeUndefined();
  expect(item([proc('2015-05-01', { text: 'Hysterectomy discussed' })], 'cervical', female).status).toBe('due');
  // "high risk" is part of the HPV test's own name.
  expect(item([obs('HPV, high risk')], 'cervical', female).status).toBe('done');
});

test('history reason prefers a dated match', () => {
  const p = (extra: Partial<Procedure>): Procedure => ({ resourceType: 'Procedure', status: 'completed', subject: {}, code: { text: 'Hysterectomy' }, ...extra });
  expect(item([p({}), p({ performedDateTime: '2015-05-01' })], 'cervical', female).reason).toContain('hysterectomy on 2015-05-01');
});

test('blood pressure: every 3 years under 40, every year from 40', () => {
  const bp = (date: string): Observation => ({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] }, effectiveDateTime: date, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] } });
  const at = (age: number, id: string, d: string) => item([bp(d)], id, { birthDate: `${2026 - age}-01-01` }).status;
  expect(at(30, 'blood-pressure', '2024-11-01')).toBe('done');
  expect(at(30, 'blood-pressure-40', '2024-11-01')).toBe('not for you');
  expect(at(45, 'blood-pressure-40', '2024-11-01')).toBe('overdue');
  expect(at(45, 'blood-pressure-40', '2026-06-01')).toBe('done');
  expect(at(45, 'blood-pressure', '2026-06-01')).toBe('not for you');
});
