import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ccdaDate, ccdaFiles } from '../src/ccda.ts';

test('ccdaDate parses effectiveTime', () => {
  const doc = (v: string) => `<ClinicalDocument><code/><effectiveTime value="${v}"/><component><effectiveTime value="19990101"/></component></ClinicalDocument>`;
  expect(ccdaDate(doc('20240315120000-0500'))).toBe('2024-03-15T12:00:00-05:00');
  expect(ccdaDate(doc('20240315'))).toBe('2024-03-15');
  expect(ccdaDate(doc('202403151200+0100'))).toBe('2024-03-15T12:00:00+01:00');
  // No timezone: keep only the date rather than invent one.
  expect(ccdaDate(doc('20240315120000'))).toBe('2024-03-15');
  expect(() => ccdaDate('<ClinicalDocument/>')).toThrow(/effectiveTime/);
});

test('ccdaFiles keeps ClinicalDocument xml and skips other xml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-ccda-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'DOC0001.XML'), '<?xml version="1.0"?>\n<!-- c -->\n<ClinicalDocument xmlns="urn:hl7-org:v3"/>');
  writeFileSync(join(dir, 'METADATA.XML'), '<?xml version="1.0"?><SubmitObjectsRequest/>');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  expect(ccdaFiles(dir)).toEqual([join(dir, 'sub', 'DOC0001.XML')]);
});
