import { expect, test } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { collapsePatients } from '../src/patient.ts';

test('collapsePatients rewrites nested references and returns MRNs', () => {
  const rs: Resource[] = [
    { resourceType: 'Patient', id: 'p1', identifier: [{ system: 'mrn', value: '1' }] },
    { resourceType: 'Patient', id: 'p2', identifier: [{ system: 'mrn', value: '2' }] },
    {
      resourceType: 'Observation',
      id: 'o',
      status: 'final',
      code: { text: 'x' },
      subject: { reference: 'Patient/p1' },
      performer: [{ reference: 'Patient/p2' }, { reference: 'Practitioner/d' }],
    },
    { resourceType: 'Encounter', id: 'e', status: 'finished', class: { code: 'AMB' }, subject: { reference: 'urn:uuid:p2' } },
  ];
  const { resources, patientIdentifiers } = collapsePatients(rs, 'GA');
  expect(resources.map((r) => r.resourceType)).toEqual(['Observation', 'Encounter']);
  const o = resources[0] as any;
  expect(o.subject.reference).toBe('Patient/GA');
  expect(o.performer.map((p: any) => p.reference)).toEqual(['Patient/GA', 'Practitioner/d']);
  expect((resources[1] as any).subject.reference).toBe('Patient/GA');
  expect(patientIdentifiers).toEqual([
    { system: 'mrn', value: '1' },
    { system: 'mrn', value: '2' },
  ]);
  expect((rs[2] as any).subject.reference).toBe('Patient/p1');
});
