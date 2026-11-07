import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Condition, Encounter, Medication, MedicationStatement, Resource } from '@medplum/fhirtypes';
import { ccdaDate, ccdaFiles, custodian, repair } from '../src/ccda.ts';

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
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-status-inactive"/><statusCode code="completed"/>
      <effectiveTime><low value="2020"/><high value="2021"/></effectiveTime>
      <entryRelationship typeCode="REFR"><observation><code code="33999-4"/><value code="73425007" displayName="Inactive"/></observation></entryRelationship>
    </observation></entryRelationship></act></entry>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-high"/><statusCode code="completed"/>
      <effectiveTime><low value="2020"/><high value="2021"/></effectiveTime></observation></entryRelationship></act></entry>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-open"/><statusCode code="completed"/>
      <effectiveTime><low value="2020"/><high nullFlavor="UNK"/></effectiveTime></observation></entryRelationship></act></entry>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id nullFlavor="NI"/><statusCode code="completed"/>
      <entryRelationship typeCode="REFR"><observation><code code="33999-4"/><value code="413322009" displayName="Resolved"/></observation></entryRelationship>
    </observation></entryRelationship></act></entry>
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

test('condition status precedence: status observation > effectiveTime/high > concern act', () => {
  const out = repair(['p-status-inactive', 'p-high', 'p-open', ''].map(cond) as Resource[], xml) as Condition[];
  expect(out.map((c) => c.clinicalStatus?.coding?.[0]?.code)).toEqual(['inactive', 'resolved', 'active', undefined]);
  expect(out[1].verificationStatus?.coding?.[0]?.code).toBe('confirmed');
});

test('repair names medications from the narrative and labels problem-list vs visit diagnoses', () => {
  const doc = `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody>
  <component><section><text><list><item><content ID="med1">examplestatin 10 mg tablet</content></item></list></text>
    <entry><substanceAdministration><id root="9.9" extension="m1"/><statusCode code="active"/>
      <consumable><manufacturedProduct><manufacturedMaterial><code code="123" codeSystem="2.16.840.1.113883.6.88"><originalText><reference value="#med1"/></originalText></code></manufacturedMaterial></manufacturedProduct></consumable>
    </substanceAdministration></entry></section></component>
  <component><section><templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="8.8" extension="pl"/></observation></entryRelationship></act></entry></section></component>
  <component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <entry><encounter><entryRelationship><act><entryRelationship><observation><id root="8.8" extension="dx"/></observation></entryRelationship></act></entryRelationship></encounter></entry></section></component>
  </structuredBody></component></ClinicalDocument>`;
  const out = repair(
    [
      { resourceType: 'Medication', id: 'med-a', code: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.69', code: '0000-0000-00' }] } },
      { ...ms('urn:oid:9.9', 'm1'), medicationReference: { reference: 'Medication/med-a' } },
      { resourceType: 'Condition', identifier: [{ system: 'urn:oid:8.8', value: 'pl' }], subject: { reference: 'Patient/p' } },
      { resourceType: 'Condition', identifier: [{ system: 'urn:oid:8.8', value: 'dx' }], subject: { reference: 'Patient/p' } },
    ] as Resource[],
    doc,
  );
  const med = out[0] as Medication;
  expect(med.code?.text).toBe('examplestatin 10 mg tablet');
  expect(med.code?.coding).toContainEqual({ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '123', display: 'examplestatin 10 mg tablet' });
  expect(med.code?.coding?.[0].code).toBe('0000-0000-00');
  const [pl, dx] = out.slice(2) as Condition[];
  expect(pl.category?.[0].coding?.[0].code).toBe('problem-list-item');
  expect(dx.category?.[0].coding?.[0].code).toBe('encounter-diagnosis');
});

test('custodian: own element only, namespace prefix and entities handled, never a later patient name', () => {
  const doc = (custodianXml: string) => `<ClinicalDocument>${custodianXml}<recordTarget><patientRole><patient><name><given>Pat</given></name></patient></patientRole></recordTarget></ClinicalDocument>`;
  expect(custodian(doc('<custodian><assignedCustodian><representedCustodianOrganization><id root="1"/></representedCustodianOrganization></assignedCustodian></custodian>'))).toBeUndefined();
  expect(custodian(doc('<custodian><assignedCustodian><representedCustodianOrganization/></assignedCustodian></custodian>'))).toBeUndefined();
  expect(custodian(doc('<x:custodian><x:representedCustodianOrganization><x:name> A &amp; B &#233;</x:name></x:representedCustodianOrganization></x:custodian>'))).toBe('A & B \u00e9');
  // A malformed numeric entity falls back to no custodian (the folder name keys the source), never a throw.
  expect(custodian(doc('<custodian><representedCustodianOrganization><name>A &#99999999;</name></representedCustodianOrganization></custodian>'))).toBeUndefined();
});
