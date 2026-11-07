import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Resource } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { clinicalDate, kindOf, readLastSeen, tally, writeLastSeen } from '../src/whats-new.ts';

const TAG = 'urn:ga-server:tag';
const tag = (code: string) => ({ tag: [{ system: TAG, code }] });
const obs = (extra: object = {}) => ({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, ...extra }) as Resource;

test('kindOf covers each branch', () => {
  expect(kindOf(obs({ meta: tag('src-apple-health'), category: [{ coding: [{ code: 'vital-signs' }] }] }))).toBe('Apple Health readings');
  expect(kindOf(obs({ category: [{ coding: [{ code: 'vital-signs' }] }] }))).toBe('vital signs');
  expect(kindOf(obs({ category: [{ coding: [{ code: 'laboratory' }] }] }))).toBe('lab results');
  expect(kindOf(obs({ meta: tag('extracted-by-llm') }))).toBe('lab results');
  expect(kindOf(obs())).toBe('lab results');
  const t = (resourceType: string) => kindOf({ resourceType } as Resource);
  expect([t('MedicationStatement'), t('MedicationRequest'), t('Condition'), t('AllergyIntolerance'), t('Immunization'), t('Procedure'), t('Encounter'), t('DocumentReference'), t('Communication'), t('FamilyMemberHistory')])
    .toEqual(['medications', 'medications', 'problems', 'allergies', 'vaccines', 'procedures', 'visits', 'notes and messages', 'notes and messages', 'other']);
});

test('clinicalDate takes the first present field', () => {
  expect(clinicalDate(obs({ effectiveDateTime: '2024-01-02T10:00:00Z', issued: '2025-01-01' }))).toBe('2024-01-02');
  expect(clinicalDate(obs({ effectivePeriod: { start: '2024-03-04' }, issued: '2025-01-01' }))).toBe('2024-03-04');
  expect(clinicalDate({ resourceType: 'Condition', onsetDateTime: '2020-05-06', recordedDate: '2021-01-01' } as Resource)).toBe('2020-05-06');
  expect(clinicalDate({ resourceType: 'Communication', sent: '2023-07-08T01:00:00Z' } as Resource)).toBe('2023-07-08');
  expect(clinicalDate(obs())).toBeUndefined();
});

test('tally splits historical at 365 days and lists sources', () => {
  const smart = { identifier: [{ system: 'urn:ga-server:id:smart:portal-a', value: 'Observation/1' }] };
  const t = tally([
    obs({ effectiveDateTime: '2025-11-06', meta: tag('src-pdf') }),
    obs({ effectiveDateTime: '2025-11-07', ...smart }),
    { resourceType: 'Condition' } as Resource,
  ], '2026-11-07');
  expect(t).toEqual({ total: 3, historical: 1, byKind: { 'lab results': 2, problems: 1 }, sources: ['PDF or photo', 'portal-a'] });
});

test('last-seen file: missing, then round trip with mode 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wn-'));
  expect(readLastSeen(dir)).toBeUndefined();
  writeLastSeen('2026-11-07T01:02:03.000Z', dir);
  expect(readLastSeen(dir)).toBe('2026-11-07T01:02:03.000Z');
  expect(statSync(join(dir, 'whats-new.json')).mode & 0o777).toBe(0o600);
});
