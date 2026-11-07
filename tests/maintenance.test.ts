import { expect, test } from 'vitest';
import type { Basic, Observation } from '@medplum/fhirtypes';
import type { MedplumClient } from '@medplum/core';
import { byTheWay, healthMaintenance, combine, epicPlans, REMINDER, upcoming, vaccineItems } from '../src/maintenance.ts';
import type { Item } from '../src/maintenance.ts';
import { loadRules } from '../src/screenings.ts';
import type { GuidelineItem, Rules, Status } from '../src/screenings.ts';

const rules = { edition: 't', topics: [
  { id: 'colorectal', epic: ['COLORECTAL', 'CRCS'] }, { id: 'prostate', epic: ['PSA', 'PROSTATE'] },
] } as unknown as Rules;
const g = (topic: string, grade: string, status: Status, dueDate?: string): GuidelineItem =>
  ({ topic, name: topic, grade, status, ...(dueDate && { dueDate }), reason: 'r', why: 'w', cost: 'c', citation: 'USPSTF' });
const hm = (topic: string, next: string | undefined, valueString: string): Observation => ({
  resourceType: 'Observation', status: 'final', id: 'o1', code: { text: `Health maintenance: ${topic}` }, valueString,
  extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2026-10-15' }],
  ...(next && { component: [{ code: { text: 'Next due date' }, valueDateTime: next }] }),
});
const rem = (code: string, topic: string, created: string, ext: Basic['extension'] = []): Basic => ({
  resourceType: 'Basic', created, code: { coding: [{ system: REMINDER, code }] },
  extension: [{ url: 'urn:ga-server:ext:topic', valueString: topic }, ...ext],
});
const run = (gl: GuidelineItem[], plans = epicPlans([]), reminders: Basic[] = [], asOf = '2026-11-03', vax: Item[] = []) =>
  combine(gl, vax, plans, reminders, rules, asOf);

test("doctor's plan and guideline both shown, earlier date drives", () => {
  const [i] = run([g('colorectal', 'A', 'done', '2034-01-01')], epicPlans([hm('COLORECTAL SCREENING', '2027-05-01', 'Not Due')]));
  expect(i).toMatchObject({ dueDate: '2027-05-01', guideline: { dueDate: '2034-01-01' }, doctorsPlan: { due: '2027-05-01', asOf: '2026-10-15' } });
});

test('an Epic topic with no rule is its own follow-up', () => {
  const out = run([], epicPlans([hm('* LIPID PANEL - YEARLY', '2027-10-15', 'Not Due')]));
  expect(out).toHaveLength(1);
  expect(out[0].name).toBe('LIPID PANEL - YEARLY');
  expect(out[0]).toMatchObject({ kind: 'follow-up', importance: 'medium', status: 'done' });
});

test('Epic date before birth is not a date', () => {
  const [i] = run([], epicPlans([hm('CRCS', '1976-05-21', 'Overdue')], '1980-01-01'));
  expect(i.doctorsPlan?.due).toBeUndefined();
  expect(i).toMatchObject({ status: 'overdue', importance: 'high' });
});

test('postpone hides until its date, then not', () => {
  const r = [rem('postpone', 'colorectal', '2026-11-01', [{ url: 'urn:ga-server:ext:until', valueDate: '2026-12-01' }])];
  const gl = [g('colorectal', 'A', 'due')];
  expect(run(gl, [], r)[0]).toMatchObject({ status: 'postponed', nextMention: '2026-12-01' });
  expect(run(gl, [], r, '2026-12-02')[0]).toMatchObject({ status: 'due' });
});

test('not now by importance', () => {
  const r = (t: string) => [rem('not-now', t, '2026-11-01')];
  expect(run([g('colorectal', 'A', 'due')], [], r('colorectal'))[0].nextMention).toBe('2026-11-15');
  expect(run([], epicPlans([hm('X', '2027-10-15', 'Not Due')]), r('X'))[0].nextMention).toBe('2026-12-31');
  expect(run([g('prostate', 'C', 'discuss')], [], r('prostate'))[0].nextMention).toBe('2027-11-01');
});

test('dismiss only for low items', () => {
  const gl = [g('prostate', 'C', 'discuss'), g('colorectal', 'A', 'due')];
  const out = run(gl, [], [rem('dismiss', 'prostate', '2026-11-01'), rem('dismiss', 'colorectal', '2026-11-01')]);
  expect(out.find((i) => i.topic === 'prostate')!.nextMention).toBeNull();
  expect(out.find((i) => i.topic === 'colorectal')!.nextMention).toBeUndefined();
});

test('agent follow-up joins an engine topic and not-for-you drops without a plan', () => {
  const q = [rem('followup', 'colorectal', '2026-10-01', [{ url: 'urn:ga-server:ext:due', valueDate: '2026-12-01' }, { url: 'urn:ga-server:ext:quote', valueString: 'repeat in 6 weeks' }])];
  const out = run([g('colorectal', 'A', 'done', '2034-01-01'), g('prostate', 'C', 'not for you')], [], q);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ dueDate: '2026-12-01', status: 'due soon', doctorsPlan: { from: 'agent', quote: 'repeat in 6 weeks', asOf: '2026-10-01' } });
});

test('vaccine statuses map', () => {
  const rec = [{ date: '2020-01-01', source: 's' }];
  const v = { edition: '2025', results: [
    { vaccine: 'a', status: 'complete', records: rec, reason: 'ra' }, { vaccine: 'b', status: 'immune', records: [], reason: '' },
    { vaccine: 'c', status: 'due', records: [], reason: '' }, { vaccine: 'd', status: 'overdue', records: rec, reason: '' },
    { vaccine: 'e', status: 'overdue', records: [], reason: '' }, { vaccine: 'f', status: 'not-recommended', records: [], reason: '' },
    { vaccine: 'g', status: 'not-evaluated', records: [], reason: 'shared decision' },
  ] };
  const items = vaccineItems(v as unknown as Parameters<typeof vaccineItems>[0]);
  expect(items.map((i) => [i.status, i.importance])).toEqual([
    ['done', 'low'], ['done', 'low'], ['due', 'medium'], ['overdue', 'high'], ['overdue', 'medium'], ['not for you', 'low'], ['discuss', 'low'],
  ]);
  expect(items[6].why).toBe('shared decision');
  expect(items[0].guideline?.citation).toContain('2025');
  expect(run([], [], [], '2026-11-03', items).map((i) => i.topic)).toEqual(['d', 'e', 'c', 'g', 'a', 'b']);
});

const vax = (vaccine: string, status: string, records: { date: string; source: string }[] = []) => ({ vaccine, status, records, reason: 'r' });
const vitems = (...v: ReturnType<typeof vax>[]) => vaccineItems({ edition: '2025', results: v } as unknown as Parameters<typeof vaccineItems>[0]);

test('Epic vaccine topics join the vaccine items; Haemophilus is not flu and Aged Out is dropped', () => {
  const v = vitems(vax('zoster', 'due'), vax('covid-19', 'complete'), vax('influenza', 'due'), vax('td-tdap', 'complete'), vax('pneumococcal', 'complete'), vax('hepatitis-a', 'complete'));
  const plans = epicPlans([hm('ZOSTER VACCINE', '2026-12-01', 'Due Soon'), hm('COVID-19 Vaccine', '2027-10-15', 'Not Due'), hm('FLU "SEASONAL"', '2026-12-30', 'Due Soon'),
    hm('DTAP/TDAP/TD VACCINE', '2030-01-01', 'Not Due'), hm('PNEUMOCOCCAL VACCINE(S) 50+', '2031-01-01', 'Not Due'), hm('HEPATITIS A VACCINE', undefined, 'Completed'),
    hm('HAEMOPHILUS INFLUENZA VACCINE', undefined, 'Aged Out')]);
  const out = run([], plans, [], '2026-11-03', v);
  expect(out).toHaveLength(6);
  expect(out.every((i) => i.kind === 'vaccine' && i.doctorsPlan)).toBe(true);
  expect(out.find((i) => i.topic === 'influenza')!.doctorsPlan?.due).toBe('2026-12-30');
  expect(out.find((i) => i.topic === 'td-tdap')).toMatchObject({ status: 'done', dueDate: '2030-01-01' });
  expect(out.find((i) => i.topic === 'covid-19')!.doctorsPlan?.due).toBe('2027-10-15');
});

test('Epic Overdue without a date makes a future-dated guideline item overdue', () => {
  const [i] = run([g('colorectal', 'A', 'done', '2034-01-01')], epicPlans([hm('COLORECTAL SCREENING: FIT TESTING', undefined, 'Overdue')]));
  expect(i.status).toBe('overdue');
});

test('a dateless guideline status keeps its meaning against a plan date', () => {
  const plan = epicPlans([hm('COLORECTAL SCREENING: FIT TESTING', '2027-10-15', 'Not Due'), hm('PSA', '2027-10-15', 'Not Due'), hm('* LIPID PROFILE', '2027-10-15', 'Not Due')]);
  const out = run([g('colorectal', 'A', 'due'), g('prostate', 'C', 'discuss'), g('lipid', 'B', 'not for you')], plan);
  expect(out.find((i) => i.topic === 'colorectal')).toMatchObject({ status: 'due', dueDate: '2027-10-15' });
  expect(out.find((i) => i.topic === 'prostate')).toMatchObject({ status: 'discuss' });
  expect(out.find((i) => i.topic === 'lipid' || i.name === 'LIPID PROFILE')).toMatchObject({ status: 'done' });
  const od = run([g('prostate', 'C', 'discuss'), g('colorectal', 'A', 'overdue')], epicPlans([hm('PSA', undefined, 'Overdue'), hm('CRCS', '2027-10-15', 'Not Due')]));
  expect(od.map((i) => i.status)).toEqual(['overdue', 'overdue']);
  const soon = run([g('prostate', 'C', 'discuss')], epicPlans([hm('PSA', '2026-12-01', 'Due Soon')]));
  expect(soon[0].status).toBe('due soon');
});

test('Aged Out: follow-up dropped, joined item unchanged; reminders match the cleaned name', () => {
  const aged = epicPlans([hm('HAEMOPHILUS INFLUENZA VACCINE', undefined, 'Aged Out'), hm('CRCS', undefined, 'Aged Out')]);
  const out = run([g('colorectal', 'A', 'due')], aged);
  expect(out).toHaveLength(1);
  expect(out[0].status).toBe('due');
  const f = run([], epicPlans([hm('* LIPID PROFILE', '2027-10-15', 'Not Due')]), [rem('not-now', 'LIPID PROFILE', '2026-11-01')]);
  expect(f[0]).toMatchObject({ name: 'LIPID PROFILE', nextMention: '2026-12-31' });
});

// Epic topic names against the shipped rules: care and diagnostic checks never join a screening.
test('care-check names stay their own follow-ups; screening names join', () => {
  const real = loadRules();
  const gl = [g('diabetes', 'B', 'done'), g('prostate', 'C', 'done'), g('hiv', 'A', 'done'), g('breast', 'B', 'done')];
  const plans = epicPlans(['* LIPID PANEL - YEARLY', 'HEMOGLOBIN A1C', 'DIABETES FOOT EXAM', 'PSA MONITORING', 'HIV VIRAL LOAD', 'BREAST BIOPSY FOLLOW-UP'].map((t) => hm(t, '2028-01-01', 'Not Due')));
  const out = combine(gl, [], plans, [], real, '2026-11-03');
  expect(out.filter((i) => i.kind === 'screening').every((i) => !i.doctorsPlan)).toBe(true);
  expect(out.filter((i) => i.kind === 'follow-up')).toHaveLength(6);
  const joined = combine([g('diabetes', 'B', 'done')], [], epicPlans([hm('GLUCOSE OR A1C SCREENING', '2028-01-01', 'Not Due')]), [], real, '2026-11-03');
  expect(joined).toHaveLength(1);
  expect(joined[0].doctorsPlan).toMatchObject({ topic: 'GLUCOSE OR A1C SCREENING', due: '2028-01-01' });
});

test('an undated Epic Overdue is never hidden by a dated plan', () => {
  const plans = epicPlans([hm('COLORECTAL CANCER SCREENING', undefined, 'Overdue'), hm('CRCS FOLLOW-UP', '2028-01-01', 'Not Due')]);
  const [i] = run([g('colorectal', 'A', 'done')], plans);
  expect(i.status).toBe('overdue');
  expect(i.doctorsPlan?.topic).toBe('COLORECTAL CANCER SCREENING');
  const [j] = run([g('colorectal', 'A', 'done')], [...plans].reverse());
  expect(j.status).toBe('overdue');
});

test('a dateless Epic "Due" or "Due Soon" makes a done item due', () => {
  for (const s of ['Due', 'Due Soon']) expect(run([g('colorectal', 'A', 'done')], epicPlans([hm('COLORECTAL', undefined, s)]))[0].status).toBe('due');
  expect(run([g('colorectal', 'A', 'done')], epicPlans([hm('COLORECTAL', undefined, 'Not Due')]))[0].status).toBe('done');
});

test('Epic topics match whole words; a plan never revives a not-for-you item', () => {
  const real = loadRules();
  const cervical = g('cervical', 'A', 'not for you');
  const out = combine([cervical], [], epicPlans([hm('CPAP COMPLIANCE CHECK', '2027-01-01', 'Not Due')]), [], real, '2026-11-03');
  expect(out.map((i) => [i.topic, i.kind])).toEqual([['CPAP COMPLIANCE CHECK', 'follow-up']]);
  const matching = combine([cervical], [], epicPlans([hm('PAP SMEAR', '2027-01-01', 'Not Due')]), [], real, '2026-11-03');
  expect(matching.map((i) => [i.topic, i.kind])).toEqual([['PAP SMEAR', 'follow-up']]);
  const flu = combine([], vitems(vax('influenza', 'due')), epicPlans([hm('FLU VACCINE, SEASONAL', '2027-01-01', 'Not Due'), hm('INFLUENZA TYPE B TITER', undefined, 'Due')]), [], real, '2026-11-03');
  expect(flu.find((i) => i.topic === 'influenza')?.doctorsPlan?.topic).toBe('FLU VACCINE, SEASONAL');
});

test('an undated Due plan is not hidden by a later dated Not Due', () => {
  const plans = epicPlans([hm('CRCS FOLLOW-UP', '2028-01-01', 'Not Due'), hm('COLORECTAL CANCER SCREENING', undefined, 'Due')]);
  expect(run([g('colorectal', 'A', 'done')], plans)[0].status).toBe('due');
  expect(run([g('colorectal', 'A', 'done')], [...plans].reverse())[0].status).toBe('due');
});

test('byTheWay names the most important item to raise, counts the rest, and respects not-now', () => {
  const items = run([g('colorectal', 'A', 'overdue', '2026-03-01'), g('prostate', 'C', 'discuss')], epicPlans([hm('LIPID PANEL - YEARLY', '2026-12-01', 'Not Due')]));
  expect(byTheWay(items, '2026-11-03')).toEqual({ line: 'By the way, colorectal is overdue since March 2026, plus 1 other item. Want to review it now?', topic: 'colorectal' });
  const quiet = run([g('colorectal', 'A', 'overdue', '2026-03-01')], epicPlans([]), [rem('not-now', 'colorectal', '2026-11-01')]);
  expect(byTheWay(quiet, '2026-11-03')).toBeUndefined();
  expect(byTheWay(run([g('prostate', 'C', 'discuss')]), '2026-11-03')).toBeUndefined(); // low and discuss are never raised
});

test('upcoming lists items due within the window, soonest first', () => {
  const items = run([g('colorectal', 'A', 'done', '2027-02-01')], epicPlans([hm('LIPID PANEL - YEARLY', '2026-12-01', 'Not Due'), hm('EYE EXAM', '2028-01-01', 'Not Due')]));
  expect(upcoming(items, '2026-11-03').map((i) => [i.name, i.dueDate])).toEqual([['LIPID PANEL - YEARLY', '2026-12-01'], ['colorectal', '2027-02-01']]);
  expect(upcoming(items, '2026-11-03', 1).map((i) => i.name)).toEqual(['LIPID PANEL - YEARLY']);
});

test("Epic's note to clinicians is dropped from topic names", () => {
  expect(epicPlans([hm('PSA SCREEN DECISION: UPDATE W "EDIT MODIFIERS"', '2027-01-01', 'Not Due')])[0].topic).toBe('PSA SCREEN DECISION');
});

test('no Observation read of a health maintenance check includes Apple Health data', async () => {
  const qs: Record<string, string>[] = [];
  const client = {
    readResource: async () => ({ resourceType: 'Patient', birthDate: '1970-01-01', gender: 'female' }),
    searchResourcePages: async function* (type: string, q: Record<string, string>) { if (type === 'Observation') qs.push(q); yield []; },
  } as unknown as MedplumClient;
  await healthMaintenance(client, 'p', '2026-11-07');
  expect(qs.filter((q) => q['code:text'] !== 'Health maintenance').every((q) => q['_tag:not'] === 'urn:ga-server:tag|src-apple-health')).toBe(true);
  expect(qs.length).toBeGreaterThanOrEqual(4);
});

test('an Epic due date on the birth date is a placeholder, not a date', () => {
  expect(epicPlans([hm('CRCS', '1976-05-21', 'Overdue')], '1976-05-21')[0].due).toBeUndefined();
});

test('two reminders on the same day: the later save wins', () => {
  const nn = { ...rem('not-now', 'colorectal', '2026-11-01'), meta: { lastUpdated: '2026-11-01T09:00:00Z' } };
  const pp = { ...rem('postpone', 'colorectal', '2026-11-01', [{ url: 'urn:ga-server:ext:until', valueDate: '2027-06-01' }]), meta: { lastUpdated: '2026-11-01T15:00:00Z' } };
  for (const order of [[nn, pp], [pp, nn]]) expect(run([g('colorectal', 'A', 'overdue', '2026-03-01')], epicPlans([]), order)[0].status).toBe('postponed');
});
