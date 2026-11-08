import { describe, expect, it } from 'vitest';
import { getSearchParameters, validateResource } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { PATIENT_COMPARTMENT_PARAMS, loadDefinitions, storedTypes } from '../definitions.ts';

describe('loadDefinitions (default: every R4 resource type)', () => {
  loadDefinitions();
  const obs: Observation = { resourceType: 'Observation', status: 'final', code: { text: 'LDL' }, subject: { reference: 'Patient/1' } };

  it('indexes the standard search parameters', () => {
    expect(Object.keys(getSearchParameters('Observation') ?? {})).toEqual(expect.arrayContaining(['code', 'date', 'category', 'subject', '_tag']));
  });

  it('validates offline: a minimal Observation passes, one without status names Observation.status', () => {
    expect(validateResource(obs)).toEqual([]);
    const { status: _s, ...noStatus } = obs;
    let issues: { expression?: string[] }[] = [];
    try { issues = validateResource(noStatus as Observation); } catch (e) { issues = (e as { outcome: { issue: typeof issues } }).outcome.issue; }
    expect(issues.flatMap((i) => i.expression ?? [])).toContain('Observation.status');
  });

  it('stores every Patient compartment type (with _tag)', () => {
    expect(Object.keys(PATIENT_COMPARTMENT_PARAMS).length).toBeGreaterThan(50);
    for (const t of Object.keys(PATIENT_COMPARTMENT_PARAMS)) expect(getSearchParameters(t)?._tag, t).toBeDefined();
  });

  it('every concrete R4 resource type, none abstract', () => {
    expect(storedTypes().length).toBeGreaterThan(140);
    for (const t of ['Questionnaire', 'ValueSet', 'Subscription', 'ResearchStudy', 'Binary']) expect(storedTypes(), t).toContain(t);
    for (const t of ['Resource', 'DomainResource']) expect(storedTypes()).not.toContain(t);
    expect(getSearchParameters('ResearchStudy')?.title).toBeDefined();
  });

  it('is loaded once per process: the same set again is a no-op, another set throws', () => {
    expect(() => loadDefinitions()).not.toThrow();
    expect(() => loadDefinitions([...storedTypes()].reverse())).not.toThrow();
    expect(() => loadDefinitions(['Patient'])).toThrow(/one type set per process/);
  });
});
