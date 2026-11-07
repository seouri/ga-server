import { describe, expect, it } from 'vitest';
import { codesFor, conceptNamed, conceptOf, concepts, CVX, cvxFor, LOINC, vitalSpecCode } from '../src/concepts.ts';


describe('concepts', () => {
  it('matches by code with the member label', () => {
    expect(conceptOf([{ system: LOINC, code: '13457-7' }])).toMatchObject({ concept: { name: 'LDL' }, label: 'calculated' });
    expect(conceptOf([{ system: LOINC, code: '48642-3' }])).toMatchObject({ concept: { name: 'eGFR' }, label: 'race-based' });
    expect(conceptOf([{ system: 'x', code: 'nope' }, { system: LOINC, code: '98979-8' }])?.label).toBe('race-free (CKD-EPI 2021)');
    expect(conceptOf([{ system: LOINC, code: '62238-1' }])?.label).toBe('CKD-EPI');
    expect(conceptOf([{ system: LOINC, code: '33914-3' }])?.label).toBe('MDRD');
    expect(conceptOf([{ system: LOINC, code: '18262-6' }])?.label).toBe('direct');
    expect(conceptOf([{ system: LOINC, code: '2089-1' }])).toMatchObject({ concept: { name: 'LDL' }, label: undefined });
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
    expect(vitalSpecCode('weight')?.code).toBe('29463-7');
    expect(vitalSpecCode('Oxygen saturation')?.code).toBe('2708-6');
    expect(vitalSpecCode('LDL')).toBeUndefined();
  });
  it('resolves a tool query to a concept by name, alias or synonym, alone or with filler words; look-alikes do not resolve', () => {
    const at = (q: string) => conceptNamed(q)?.name;
    for (const [q, c] of <[string, string | undefined][]>[['ldl', 'LDL'], ['LDL cholesterol', 'LDL'], ['LDL-C', 'LDL'], ['my ldl level', 'LDL'], ['HbA1c', 'A1c'], ['hemoglobin a1c', 'A1c'], ['glycated hemoglobin', 'A1c'],
      ['thyrotropin', 'TSH'], ['blood glucose', 'Glucose'], ['hemoglobin', 'Hemoglobin'], ['GFR', 'eGFR'], ['weight', 'Body weight'], ['non hdl', undefined]])
      expect([q, at(q)]).toEqual([q, c]);
    for (const q of ['ldl-p', 'LDL particle', 'tsh receptor antibody', 'urine glucose', 'glucose, urine', 'non-hdl cholesterol', 'resting heart rate', 'cholesterol/hdl ratio', 'bad cholesterol'])
      expect([q, at(q)]).toEqual([q, undefined]);
    expect(vitalSpecCode('my weight')).toBeUndefined(); // import coding stays exact
  });
  it('looks up CVX by short description', () => {
    expect(cvxFor('TDAP')).toMatchObject({ system: CVX, code: '115' });
    expect(cvxFor('no such vaccine')).toBeUndefined();
  });
  it('has the colorectal screening procedure concept', () => {
    expect(concepts().find((c) => c.name === 'colorectal cancer screening')).toMatchObject({ kind: 'procedure' });
  });
});
