import { expect, test } from 'vitest';
import type { MedicationStatement, Resource } from '@medplum/fhirtypes';
import { decide } from '../src/engine.ts';
import { stamp, type SourceInfo } from '../src/identity.ts';

const src = (date: string, writer: SourceInfo['writer'] = 'importer'): SourceInfo => ({ kind: 'ccda', file: 'a.xml', date, writer });
const ID = { system: 'urn:ga-server:id:ccda', value: 'm1' };
const ms = (status: MedicationStatement['status']): MedicationStatement => ({
  resourceType: 'MedicationStatement',
  status,
  medicationCodeableConcept: { text: 'metformin' },
  subject: { reference: 'Patient/p' },
});
const existing = (r: Resource, s: SourceInfo): Resource => ({ ...stamp(r, s, ID), id: 'srv-1', meta: { ...stamp(r, s, ID).meta, versionId: '1' } });

test('create when none', () => {
  expect(decide(undefined, stamp(ms('active'), src('2024-01-01'), ID))).toBe('create');
});

test('older source does not overwrite', () => {
  const ex = existing(ms('stopped'), src('2024-06-01'));
  expect(decide(ex, stamp(ms('active'), src('2024-03-01'), ID))).toBe('skip');
  expect(decide(ex, stamp(ms('active'), src('2024-06-01'), ID))).toBe('skip');
});

test('equal content skips', () => {
  // existing carries an extra identifier from an earlier merge, in a different order
  const ex = existing({ ...ms('active'), identifier: [{ system: 'urn:ga-server:id:pdf', value: 'h' }] } as Resource, src('2024-01-01'));
  expect(decide(ex, stamp(ms('active'), src('2024-06-01T10:00:00Z'), ID))).toBe('skip');
});

test('newer different content updates', () => {
  const ex = existing(ms('active'), src('2024-01-01'));
  expect(decide(ex, stamp(ms('stopped'), src('2024-06-01'), ID))).toBe('update');
});

test('agent-written conflicts', () => {
  const ex = existing(ms('active'), src('2024-01-01', 'agent'));
  expect(decide(ex, stamp(ms('stopped'), src('2024-06-01'), ID))).toBe('conflict');
});

test('agent-written equal content skips', () => {
  const ex = existing(ms('active'), src('2024-01-01', 'agent'));
  expect(decide(ex, stamp(ms('active'), src('2024-06-01'), ID))).toBe('skip');
  expect(decide(ex, stamp(ms('stopped'), src('2023-06-01'), ID))).toBe('skip');
});

test('re-stamped Composition with singular identifier skips', () => {
  const comp = { resourceType: 'Composition', status: 'final', title: 't', identifier: { value: 'doc' } } as Resource;
  expect(decide(existing(comp, src('2024-01-01')), stamp(comp, src('2024-01-01'), ID))).toBe('skip');
  expect(decide(existing(comp, src('2024-01-01')), stamp({ ...comp, title: 'u' } as Resource, src('2024-02-01'), ID))).toBe('update');
});
