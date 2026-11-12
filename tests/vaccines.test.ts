import { expect, test } from 'vitest';
import type { Immunization } from '@medplum/fhirtypes';
import { CONCEPT_SRC } from '../src/concept-apply.ts';
import { addMonths, doseOf, evaluateVaccines, loadSchedule } from '../src/vaccines.ts';

// Synthetic histories; expected statuses follow the shipped schedule's own rules.
const schedule = loadSchedule();
const base = { birthDate: '1970-06-15', sex: 'male' as const, immunizations: [], immunity: [] };
const AS_OF = '2026-11-05';
const status = (r: ReturnType<typeof evaluateVaccines>, id: string) => r.results.find((x) => x.vaccine === id);

test('loads the newest schedule with its edition', () => {
  expect(schedule.edition).toMatch(/2025/);
  expect(evaluateVaccines(schedule, base, AS_OF).edition).toBe(schedule.edition);
});

test('influenza due when no dose this season', () => {
  // Last season's dose (2025-10-01) is before Aug 1 2026.
  const r = evaluateVaccines(schedule, { ...base, immunizations: [{ date: '2025-10-01', name: 'Influenza, Quadrivalent, Preservative Free', source: 'ehi' }] }, AS_OF);
  expect(status(r, 'influenza')).toMatchObject({ status: 'due', records: [{ date: '2025-10-01', source: 'ehi' }] });
  const now = evaluateVaccines(schedule, { ...base, immunizations: [{ date: '2026-09-20', cvx: '158', source: 'ccda.xml' }] }, AS_OF);
  expect(status(now, 'influenza')?.status).toBe('complete');
});

test('Td/Tdap overdue after 10 years', () => {
  const r = evaluateVaccines(schedule, { ...base, immunizations: [{ date: '2014-03-01', name: 'Tdap', source: 'ehi' }] }, AS_OF);
  expect(status(r, 'td-tdap')?.status).toBe('overdue');
  const none = evaluateVaccines(schedule, base, AS_OF);
  expect(status(none, 'td-tdap')?.status).toBe('due');
  const tdap = { date: '2012-03-01', cvx: '115', source: 'ccda.xml' };
  const td = { date: '2020-03-01', name: 'Td', source: 'ehi' };
  expect(status(evaluateVaccines(schedule, { ...base, immunizations: [tdap, td] }, AS_OF), 'td-tdap')?.status).toBe('complete');
  // Td boosters alone never satisfy the 1-dose Tdap rule.
  const tdOnly = status(evaluateVaccines(schedule, { ...base, immunizations: [td] }, AS_OF), 'td-tdap');
  expect(tdOnly).toMatchObject({ status: 'due', reason: expect.stringMatching(/No Tdap dose recorded/) });
});

test('zoster 2 doses complete at 50+', () => {
  const imms = [
    { date: '2024-01-10', cvx: '187', source: 'ccda.xml' },
    { date: '2024-04-10', name: 'Shingrix', source: 'ehi' },
  ];
  expect(status(evaluateVaccines(schedule, { ...base, immunizations: imms }, AS_OF), 'zoster')?.status).toBe('complete');
  // One dose more than 6 months ago: overdue for dose 2. Zostavax (live) never counts toward RZV.
  const one = evaluateVaccines(schedule, { ...base, immunizations: [imms[0], { date: '2015-01-01', name: 'Zoster Vaccine Live', source: 'ehi' }] }, AS_OF);
  expect(status(one, 'zoster')).toMatchObject({ status: 'overdue', records: [{ date: '2024-01-10' }] });
  expect(one.unmatched).toEqual([{ date: '2015-01-01', name: 'Zoster Vaccine Live', source: 'ehi' }]);
});

test('hepatitis B immune by surface antibody', () => {
  const young = { ...base, birthDate: '1990-01-01' };
  const imm = [{ name: 'Hepatitis B surface antibody', value: 'Positive (> 1000)', date: '2023-05-01', source: 'labs.pdf' }];
  expect(status(evaluateVaccines(schedule, { ...young, immunity: imm }, AS_OF), 'hepatitis-b')).toMatchObject({
    status: 'immune', records: [{ date: '2023-05-01', source: 'labs.pdf' }],
  });
  // Negated result and surface antigen are not immunity.
  const neg = [{ ...imm[0], value: 'Non-reactive' }, { name: 'Hepatitis B surface antigen', value: 'Positive', date: '2023-05-01', source: 'labs.pdf' }];
  expect(status(evaluateVaccines(schedule, { ...young, immunity: neg }, AS_OF), 'hepatitis-b')?.status).toBe('due');
  // Heplisav-B: 2 doses complete the series; Engerix-B needs 3.
  const hep = (name: string) => [{ date: '2020-01-01', name, source: 'x' }, { date: '2020-02-01', name, source: 'x' }];
  expect(status(evaluateVaccines(schedule, { ...young, immunizations: hep('Heplisav-B') }, AS_OF), 'hepatitis-b')?.status).toBe('complete');
  expect(status(evaluateVaccines(schedule, { ...young, immunizations: hep('Engerix-B') }, AS_OF), 'hepatitis-b')?.status).toBe('due');
});

test('unmatched immunization name is listed, not guessed', () => {
  const imms = [
    { date: '2019-05-01', name: 'Typhoid Vi', source: 'ehi' },
    { date: '2019-05-02', name: 'Hep A-Hep B', source: 'ehi' }, // name hits two vaccines
    { date: '2019-05-03', cvx: '104', source: 'ccda.xml' }, // the same combo by CVX counts for both
  ];
  const r = evaluateVaccines(schedule, { ...base, immunizations: imms }, AS_OF);
  expect(r.unmatched).toEqual([imms[0], imms[1]]);
  expect(status(r, 'hepatitis-a')?.records).toEqual([{ date: '2019-05-03', source: 'ccda.xml' }]);
  expect(status(r, 'hepatitis-b')?.records).toEqual([{ date: '2019-05-03', source: 'ccda.xml' }]);
});

test('not-recommended outside age range', () => {
  const r = evaluateVaccines(schedule, { ...base, birthDate: '1990-01-01' }, AS_OF); // age 36
  expect(status(r, 'zoster')?.status).toBe('not-recommended');
  expect(status(r, 'rsv')?.status).toBe('not-recommended');
  expect(status(r, 'pneumococcal')?.status).toBe('not-recommended');
  expect(status(r, 'hpv')?.status).toBe('not-evaluated'); // 27-45 shared clinical decision-making
  expect(status(evaluateVaccines(schedule, { ...base, birthDate: '1950-01-01' }, AS_OF), 'mmr')?.status).toBe('not-recommended');
});

test('same vaccine on the same day counts once', () => {
  const imms = [
    { date: '2024-01-10', cvx: '187', source: 'ccda.xml' },
    { date: '2024-01-10T09:30:00-05:00', name: 'Shingrix', source: 'ehi' },
  ];
  const r = evaluateVaccines(schedule, { ...base, immunizations: imms }, AS_OF);
  expect(status(r, 'zoster')).toMatchObject({ status: 'overdue' });
  expect(status(r, 'zoster')?.records).toHaveLength(2); // both records shown, one dose counted
});

test('COVID-19 and pneumococcal history are not guessed', () => {
  const old = { ...base, birthDate: '1950-01-01' };
  expect(status(evaluateVaccines(schedule, old, AS_OF), 'covid-19')).toMatchObject({ status: 'not-evaluated', reason: expect.stringMatching(/2024/) });
  expect(status(evaluateVaccines(schedule, old, AS_OF), 'pneumococcal')?.status).toBe('due');
  const pcv13 = evaluateVaccines(schedule, { ...old, immunizations: [{ date: '2016-01-01', cvx: '133', source: 'x' }] }, AS_OF);
  expect(status(pcv13, 'pneumococcal')?.status).toBe('not-evaluated');
  const pcv20 = evaluateVaccines(schedule, { ...old, immunizations: [{ date: '2023-01-01', name: 'Prevnar 20', source: 'x' }] }, AS_OF);
  expect(status(pcv20, 'pneumococcal')?.status).toBe('complete');
});

test('MMR immunity needs all three antibodies', () => {
  const pos = (name: string) => ({ name, value: 'Positive (immune)', date: '2020-01-01', source: 'x' });
  const two = evaluateVaccines(schedule, { ...base, immunity: [pos('Measles IgG'), pos('Mumps IgG')] }, AS_OF);
  expect(status(two, 'mmr')?.status).toBe('due');
  const three = evaluateVaccines(schedule, { ...base, immunity: [pos('Measles IgG'), pos('Mumps IgG'), pos('Rubella IgG')] }, AS_OF);
  expect(status(three, 'mmr')?.status).toBe('immune');
});

test('a record without a date is listed, never counted', () => {
  const dated = { date: '2024-01-10', name: 'Shingrix', source: 'ehi' };
  const undated = { date: '', name: 'Shingrix', source: 'ehi' };
  const r = evaluateVaccines(schedule, { ...base, immunizations: [dated, undated] }, AS_OF);
  expect(status(r, 'zoster')).toMatchObject({ status: 'overdue', records: [{ date: '2024-01-10' }] });
  expect(r.unmatched).toEqual([undated]);
  expect(status(evaluateVaccines(schedule, { ...base, immunizations: [undated] }, AS_OF), 'zoster')?.status).toBe('due');
});

test('doses under 28 days apart count once', () => {
  const imms = [{ date: '2024-01-10', cvx: '187', source: 'ccda.xml' }, { date: '2024-01-11', name: 'Shingrix', source: 'ehi' }];
  const r = status(evaluateVaccines(schedule, { ...base, immunizations: imms }, AS_OF), 'zoster');
  expect(r).toMatchObject({ status: 'overdue', reason: expect.stringMatching(/1 of 2 doses/) });
  expect(r?.records).toHaveLength(2);
});

test('records dated after asOf are ignored', () => {
  const imms = [{ date: '2024-01-10', cvx: '187', source: 'x' }, { date: '2024-04-10', cvx: '187', source: 'x' }];
  const r = evaluateVaccines(schedule, { ...base, immunizations: imms }, '2024-02-01');
  expect(status(r, 'zoster')).toMatchObject({ status: 'due', records: [{ date: '2024-01-10' }] });
  const lab = [{ name: 'Hepatitis B surface antibody', value: 'Positive', date: '2025-01-01', source: 'x' }];
  const young = { ...base, birthDate: '1990-01-01' };
  expect(status(evaluateVaccines(schedule, { ...young, immunity: lab }, '2024-12-31'), 'hepatitis-b')?.status).toBe('due');
  expect(status(evaluateVaccines(schedule, { ...young, immunity: lab }, '2025-01-01'), 'hepatitis-b')?.status).toBe('immune');
});

test('names match across punctuation and spacing (PCV-20, PCV 20)', () => {
  const old = { ...base, birthDate: '1950-01-01' };
  for (const name of ['PCV-20', 'PCV 20', 'Prevnar-20']) {
    const r = evaluateVaccines(schedule, { ...old, immunizations: [{ date: '2023-01-01', name, source: 'x' }] }, AS_OF);
    expect(status(r, 'pneumococcal')?.status, name).toBe('complete');
  }
  const sars = evaluateVaccines(schedule, { ...base, immunizations: [{ date: '2023-01-01', name: 'SARS-CoV-2 vaccine', source: 'x' }] }, AS_OF);
  expect(status(sars, 'covid-19')?.records).toHaveLength(1);
});

test('sex outside male/female still runs the schedule', () => {
  const r = evaluateVaccines(schedule, { ...base, sex: undefined }, AS_OF);
  expect(status(r, 'td-tdap')?.status).toBe('due');
});

test('immunity needs a leading positive word, no negation, and an antibody test for bare disease names (I2)', () => {
  const ev = (name: string, value: string) => ({ name, value, date: '2020-01-01', source: 'x' });
  const varicella = (e: ReturnType<typeof ev>) => status(evaluateVaccines(schedule, { ...base, birthDate: '1990-01-01', immunity: [e] }, AS_OF), 'varicella')?.status;
  expect(varicella(ev('Varicella IgG antibody', 'Positive'))).toBe('immune');
  expect(varicella(ev('VZV IgG', 'Immune'))).toBe('immune');
  expect(varicella(ev('Varicella IgG antibody', 'Immune status unknown'))).not.toBe('immune');
  for (const value of ['Uncertain', 'Borderline', 'Low positive', 'Insufficient', 'Indeterminate', 'Equivocal', 'Negative', 'Non-reactive', 'Not immune', 'See note: positive']) {
    expect(varicella(ev('Varicella IgG antibody', value))).not.toBe('immune');
  }
  expect(varicella(ev('Varicella IgM', 'Positive'))).not.toBe('immune'); // acute infection, not immunity
  expect(varicella(ev('Varicella zoster virus IgM antibody', 'Positive'))).not.toBe('immune');
  expect(varicella(ev('VZV PCR', 'Positive'))).not.toBe('immune'); // bare name, no antibody term
  expect(varicella(ev('Varicella', 'Positive'))).not.toBe('immune');
  const mmr = (names: string[]) => status(evaluateVaccines(schedule, { ...base, immunity: names.map((n) => ev(n, 'Positive')) }, AS_OF), 'mmr')?.status;
  expect(mmr(['Measles antibody', 'Mumps IgG', 'Rubella titer'])).toBe('immune');
  expect(mmr(['Measles IgM', 'Mumps IgG', 'Rubella titer'])).not.toBe('immune');
  expect(mmr(['Measles', 'Mumps', 'Rubella'])).not.toBe('immune');
});

test('doseOf: a GA-added CVX coding counts unless the record is concept-suggested; the CVX OID counts', () => {
  const ga = { system: 'http://hl7.org/fhir/sid/cvx', code: '187', extension: [{ url: CONCEPT_SRC, valueCode: 'agent' }] };
  const imm = (coding: object[], tags: string[] = []): Immunization => ({ resourceType: 'Immunization', status: 'completed', patient: {}, occurrenceDateTime: '2024-01-01', vaccineCode: { text: 'Shingles', coding: coding as never }, meta: { tag: tags.map((code) => ({ system: 'urn:ga-server:tag', code })) } });
  expect(doseOf(imm([ga])).cvx).toBe('187');
  expect(doseOf(imm([ga], ['concept-suggested'])).cvx).toBeUndefined();
  expect(doseOf(imm([{ system: 'urn:oid:2.16.840.1.113883.12.292', code: '187' }, ga], ['concept-suggested'])).cvx).toBe('187');
});

test('addMonths clamps to the last day of a shorter month', () => {
  expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
  expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
  expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
  expect(addMonths('2025-03-31', -1)).toBe('2025-02-28');
  expect(addMonths('2025-01-15', 1)).toBe('2025-02-15');
});
