import { join } from 'node:path';
import { expect, it } from 'vitest';
import { type DicomHeader, readHeader } from '../src/dicom/read.ts';
import { toImagingStudies } from '../src/dicom/map.ts';

const F = (p: string) => join(import.meta.dirname, 'fixtures', 'dicom', p);

it('builds one study with its series and instances', () => {
  const [s] = toImagingStudies([readHeader(F('ct/1')), readHeader(F('ct/2'))] as DicomHeader[]);
  expect(s.identifier).toEqual([{ system: 'urn:dicom:uid', value: 'urn:oid:1.2.3' }]);
  expect(s.numberOfSeries).toBe(1); expect(s.numberOfInstances).toBe(2);
  expect(s.series?.[0].instance?.map((i) => i.number)).toEqual([1, 2]);
});
it('keeps the date only and the time in the description', () => {
  const [s] = toImagingStudies([readHeader(F('ct/1')) as DicomHeader]);
  expect(s.started).toBe('2024-01-15');
  expect(s.description).toBe('CT CHEST (study time 09:30)');
});
it('groups series of one study and ignores a repeated instance', () => {
  const h = ['ct/1', 'ct/1', 'implicit/1'].map((p) => readHeader(F(p)) as DicomHeader);
  const [s] = toImagingStudies(h);
  expect(s.numberOfSeries).toBe(2); expect(s.numberOfInstances).toBe(2);
  expect(s.modality?.map((m) => m.code)).toEqual(['CT', 'MR']);
});
