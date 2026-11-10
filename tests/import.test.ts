import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectKind } from '../src/import.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'ga-import-'));

describe('detectKind', () => {
  it('pdf and images', () => {
    expect(detectKind('x.PDF')).toBe('pdf');
    expect(detectKind('a/b.png')).toBe('pdf');
  });
  it('ehi folder', () => {
    const d = tmp();
    mkdirSync(join(d, 'EHITables'));
    expect(detectKind(d)).toBe('ehi');
  });
  it('apple folder', () => {
    const d = tmp();
    writeFileSync(join(d, 'export.xml'), '<?xml version="1.0"?>\n<!DOCTYPE HealthData [\n]>');
    expect(detectKind(d)).toBe('apple');
  });
  it('ccda folder', () => {
    const d = tmp();
    writeFileSync(join(d, 'a.xml'), '<x/>');
    expect(detectKind(d)).toBe('ccda');
  });
  it('detects a .json file as fhir-export', () => expect(detectKind(join(tmp(), 'ehr-data.json'))).toBe('fhir-export'));
  it('detects a folder with DICOMDIR as dicom', () => {
    const d = tmp();
    writeFileSync(join(d, 'DICOMDIR'), '');
    expect(detectKind(d)).toBe('dicom');
  });
  it('treats .tif and .tiff as documents', () => {
    expect(detectKind('/x/a.tiff')).toBe('pdf');
    expect(detectKind('/x/a.TIF')).toBe('pdf');
  });
  it('zip is refused', () => {
    expect(() => detectKind('a.zip')).toThrow(/unzip export.zip first/);
  });
});
