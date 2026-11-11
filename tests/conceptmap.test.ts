import { basename } from 'node:path';
import type { Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { inScope, sourceKey, termKey } from '../src/conceptmap.ts';
import type { SourceInfo } from '../src/identity.ts';

const lab = (text: string, unit: string, specimen?: string): Observation => ({
  resourceType: 'Observation', status: 'final',
  category: [{ coding: [{ code: 'laboratory' }] }],
  code: { text },
  valueQuantity: { value: 1, unit },
  ...(specimen && { specimen: { display: specimen } }),
});
const src = (kind: SourceInfo['kind'], extra: Partial<SourceInfo> = {}): SourceInfo => ({ kind, file: '/x/y.pdf', date: '2026-01-01', writer: 'importer', ...extra });

test('termKey keeps unit and specimen apart and ignores case, spacing and punctuation', () => {
  const ldl = termKey(lab('LOW DENSITY LIPOPROTEIN CHOL', 'mg/dL'));
  expect(ldl).toBe(termKey(lab(' low-density  lipoprotein chol. ', 'mg/dL')));
  expect(ldl).not.toBe(termKey(lab('LOW DENSITY LIPOPROTEIN CHOL', 'mmol/L')));
  const urine = termKey(lab('Glucose', 'mg/dL', 'Urine'));
  expect(urine).not.toBe(termKey(lab('Glucose', 'mg/dL', 'Serum')));
  expect(urine).not.toBe(termKey(lab('Glucose', 'mg/dL')));
  expect(ldl).not.toBe(urine);
});

test('termKey: other types are Type|name, medications as written', () => {
  expect(termKey({ resourceType: 'MedicationStatement', status: 'active', subject: {}, medicationCodeableConcept: { text: ' Lisinopril 10 MG ' } })).toBe('MedicationStatement|Lisinopril 10 MG');
  expect(termKey({ resourceType: 'Condition', subject: {}, code: { text: 'Essential  Hypertension' } })).toBe('Condition|essential hypertension');
  expect(termKey({ resourceType: 'Immunization', status: 'completed', patient: {}, vaccineCode: { text: 'Influenza' } })).toBe('Immunization|influenza');
  expect(termKey({ resourceType: 'Observation', status: 'final', code: {} })).toBeUndefined();
});

test('inScope follows the spec boundary', () => {
  expect(inScope(lab('Glucose', 'mg/dL'))).toBe(true);
  expect(inScope({ resourceType: 'Observation', status: 'final', code: { text: 'Weight' }, category: [{ coding: [{ code: 'vital-signs' }] }] })).toBe(true);
  expect(inScope({ resourceType: 'Observation', status: 'final', code: { text: 'Glucose' }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'extracted-by-llm' }] } })).toBe(true);
  expect(inScope({ resourceType: 'Observation', status: 'final', code: { text: 'Glucose' } })).toBe(false);
  for (const text of ['Heart rate, daily mean (Apple Health)', 'Steps, daily total (Apple Health)', 'Activity rings, daily (Apple Health)', 'Sleep, nightly (Apple Health)', 'Apple Watch ECG classification', 'Health maintenance: Colonoscopy']) {
    expect(inScope({ ...lab(text, 'x'), category: [{ coding: [{ code: 'vital-signs' }] }] }), text).toBe(false);
  }
  expect(inScope({ resourceType: 'QuestionnaireResponse', status: 'completed' })).toBe(false);
  expect(inScope({ resourceType: 'DocumentReference', status: 'current', content: [] })).toBe(false);
  expect(inScope({ resourceType: 'Communication', status: 'completed' })).toBe(false);
  for (const rt of ['Immunization', 'Procedure', 'MedicationRequest', 'Condition'] as const) expect(inScope({ resourceType: rt } as never)).toBe(true);
});

test('sourceKey per kind', () => {
  expect(sourceKey(src('pdf'), lab('a', 'b'))).toBe('pdf');
  expect(sourceKey(src('apple-health'), lab('a', 'b'))).toBe('apple-health');
  expect(sourceKey(src('apple-clinical'), { ...lab('a', 'b'), identifier: [{ system: 'urn:ga-server:id:smart:h', value: 'Observation/1' }] })).toBe('apple-health'); // the map Apple clinical copies always used
  const ehi = { ...lab('a', 'b'), identifier: [{ system: 'urn:ga-server:id:ehi:acme', value: 'X|1' }] };
  expect(sourceKey(src('ehi'), ehi)).toBe('ehi:acme');
  const smart = { ...lab('a', 'b'), identifier: [{ system: 'urn:ga-server:id:smart:hosp1', value: 'Observation/1' }] };
  expect(sourceKey(src('smart'), smart)).toBe('smart:hosp1');
  expect(() => sourceKey(src('ehi'), lab('a', 'b'))).toThrow();
  expect(sourceKey(src('ccda', { org: 'Synthetic Clinic' }), lab('a', 'b'))).toBe('ccda:synthetic clinic');
  expect(sourceKey(src('ccda', { file: '/in/Acme Export/doc1.xml' }), lab('a', 'b'))).toBe('ccda:acme export');
  expect(sourceKey(src('ccda', { file: './doc1.xml' }), lab('a', 'b'))).toBe(`ccda:${basename(process.cwd()).toLowerCase().replace(/[^\p{L}\p{N}%/]+/gu, ' ').trim()}`); // relative: its real folder
  expect(() => sourceKey(src('ccda', { file: '/doc1.xml' }), lab('a', 'b'))).toThrow(); // no organisation: no catch-all map
});
