import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encapsulatedPdf, readHeader } from '../src/dicom/read.ts';

const F = (p: string) => join(import.meta.dirname, 'fixtures', 'dicom', p);

it('reads study and series from explicit VR', () => expect(readHeader(F('ct/1'))).toMatchObject({ studyUid: '1.2.3', seriesUid: '1.2.3.4', modality: 'CT', instanceNumber: 1 }));
it('reads implicit VR', () => expect(readHeader(F('implicit/1'))).toMatchObject({ studyUid: '1.2.3' }));
it('skips undefined-length sequences', () => expect(readHeader(F('seq/1'))).toMatchObject({ seriesUid: '1.2.3.9' }));
it('skips non-DICOM files', () => expect(readHeader(F('Preview.jpg'))).toBe('not-dicom'));
it('marks big endian unsupported', () => expect(readHeader(F('big/1'))).toBe('unsupported'));
it('extracts the encapsulated PDF', () => expect(encapsulatedPdf(F('pdf/1'))?.subarray(0, 5).toString()).toBe('%PDF-'));
it('reads the remaining tags', () =>
  expect(readHeader(F('ct/1'))).toMatchObject({ sopClass: '1.2.840.10008.5.1.4.1.1.2', sopInstance: '1.2.3.4.1', transferSyntax: '1.2.840.10008.1.2.1', studyDate: '2024-01-15', studyTime: '09:30', studyDescription: 'CT CHEST', seriesDescription: 'AXIAL', seriesNumber: 2, bodyPart: 'CHEST' }));
it('has no PDF in a CT file', () => expect(encapsulatedPdf(F('ct/1'))).toBeUndefined());
it('survives deeply nested sequences', () => {
  const head = readFileSync(F('ct/1')).subarray(0, 132 + 40); // preamble, DICM and the meta group
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const open = Buffer.concat([Buffer.from([0x08, 0, 0x32, 0x10]), Buffer.from('SQ'), Buffer.alloc(2), u32(0xffffffff), Buffer.from([0xfe, 0xff, 0x00, 0xe0]), u32(0xffffffff)]);
  const dir = mkdtempSync(join(tmpdir(), 'ga-deep-'));
  const f = join(dir, 'deep');
  writeFileSync(f, Buffer.concat([head, ...Array.from({ length: 12000 }, () => open)]));
  expect(() => readHeader(f)).not.toThrow();
  expect(['not-dicom']).toContain(readHeader(f));
});
