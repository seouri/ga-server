import { describe, expect, it } from 'vitest';
import { codesFor, conceptOf, concepts, cvxFor, vitalSpecCode } from '../src/concepts.ts';

const LOINC = 'http://loinc.org';

describe('concepts', () => {
  it('matches by code with the member label', () => {
    expect(conceptOf([{ system: LOINC, code: '13457-7' }])).toMatchObject({ concept: { name: 'LDL' }, label: 'calculated' });
    expect(conceptOf([{ system: LOINC, code: '48642-3' }])).toMatchObject({ concept: { name: 'eGFR' }, label: 'race-based' });
    expect(conceptOf([{ system: 'x', code: 'nope' }, { system: LOINC, code: '98979-8' }])?.label).toBe('race-free');
  });
  it('does not match a urine glucose to blood glucose, or a code in another system', () => {
    expect(conceptOf([{ system: LOINC, code: '5792-7' }])).toBeUndefined();
    expect(conceptOf([{ system: 'http://snomed.info/sct', code: '2345-7' }])).toBeUndefined();
    expect(conceptOf(undefined)).toBeUndefined();
  });
  it('lists codes per concept; no code is in two concepts', () => {
    expect(codesFor('LDL')).toHaveLength(3);
    expect(codesFor('nothing')).toEqual([]);
    const all = concepts().flatMap((c) => c.members.map((m) => `${m.system}|${m.code}`));
    expect(new Set(all).size).toBe(all.length);
  });
  it('has the spec vital-sign codes', () => {
    expect(vitalSpecCode('Body weight')).toMatchObject({ system: LOINC, code: '29463-7' });
    expect(vitalSpecCode('weight', 'kg')?.code).toBe('29463-7');
    expect(vitalSpecCode('Oxygen saturation')?.code).toBe('2708-6');
    expect(vitalSpecCode('LDL')).toBeUndefined();
  });
  it('looks up CVX by short description', () => {
    expect(cvxFor('TDAP')).toMatchObject({ system: 'http://hl7.org/fhir/sid/cvx', code: '115' });
    expect(cvxFor('no such vaccine')).toBeUndefined();
  });
  it('has the colorectal screening procedure concept', () => {
    expect(concepts().find((c) => c.name === 'colorectal cancer screening')).toMatchObject({ kind: 'procedure' });
  });
});
