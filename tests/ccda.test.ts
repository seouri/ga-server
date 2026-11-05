import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Condition, Encounter, MedicationStatement, Resource } from '@medplum/fhirtypes';
import { ccdaDate, ccdaFiles, repair } from '../src/ccda.ts';

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

const xml = `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody>
  <component><section><entry><substanceAdministration><id root="1.1" extension="m-active"/><statusCode code="active"/></substanceAdministration></entry>
    <entry><substanceAdministration><id root="1.1" extension="m-aborted"/><statusCode code="aborted"/></substanceAdministration></entry>
    <entry><substanceAdministration><id root="AB-CD"/><statusCode code="completed"/></substanceAdministration></entry></section></component>
  <component><section>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-active"/><statusCode code="completed"/></observation></entryRelationship></act></entry>
    <entry><act><statusCode code="completed"/><entryRelationship><observation><id root="2.2" extension="p-done"/><statusCode code="completed"/></observation></entryRelationship></act></entry>
  </section></component></structuredBody></component></ClinicalDocument>`;
const ms = (system: string, value: string): MedicationStatement =>
  ({ resourceType: 'MedicationStatement', identifier: [{ system, value }], subject: { reference: 'Patient/p' } }) as MedicationStatement;
const cond = (value: string): Condition => ({ resourceType: 'Condition', identifier: [{ system: 'urn:oid:2.2', value }], subject: { reference: 'Patient/p' } });

test('repair recovers statuses from the source entries and drops the converter DocumentReference', () => {
  const out = repair(
    [
      ms('urn:oid:1.1', 'm-active'),
      ms('urn:oid:1.1', 'm-aborted'),
      ms('urn:ietf:rfc:3986', 'urn:uuid:ab-cd'),
      ms('urn:oid:1.1', 'not-in-xml'),
      cond('p-active'),
      cond('p-done'),
      cond('not-in-xml'),
      { resourceType: 'Encounter', class: { code: 'AMB' } } as Encounter,
      { resourceType: 'DocumentReference', status: 'current', content: [] },
    ] as Resource[],
    xml,
  );
  expect(out.filter((r) => r.resourceType === 'MedicationStatement').map((r) => (r as MedicationStatement).status)).toEqual([
    'active',
    'stopped',
    'completed',
    'unknown',
  ]);
  const [a, d, n] = out.filter((r) => r.resourceType === 'Condition') as Condition[];
  expect(a.clinicalStatus?.coding?.[0]?.code).toBe('active');
  expect(d.clinicalStatus?.coding?.[0]?.code).toBe('resolved');
  expect(d.verificationStatus?.coding?.[0]?.code).toBe('confirmed');
  expect(n.clinicalStatus).toBeUndefined();
  expect((out.find((r) => r.resourceType === 'Encounter') as Encounter).status).toBe('unknown');
  expect(out.some((r) => r.resourceType === 'DocumentReference')).toBe(false);
});
