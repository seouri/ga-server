import type { Patient } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertCcdaToFhir } from '../ccda-to-fhir.ts';
import { convertXmlToCcda } from '../xml.ts';

const patientOf = (patientXml: string): Patient => {
  const xml = `<ClinicalDocument xmlns="urn:hl7-org:v3"><recordTarget><patientRole><patient>${patientXml}</patient></patientRole></recordTarget>
    <component><structuredBody/></component></ClinicalDocument>`;
  return convertCcdaToFhir(convertXmlToCcda(xml)).entry?.map((e) => e.resource).find((r): r is Patient => r?.resourceType === 'Patient') as Patient;
};

test('languageCommunication is Patient.communication: the BCP-47 code, its language name and preferenceInd', () => {
  const patient = patientOf(`<languageCommunication><languageCode code="es"/><preferenceInd value="true"/></languageCommunication>
    <languageCommunication><languageCode code="en"/></languageCommunication>`);
  expect(patient.communication).toEqual([
    { language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'es', display: 'Spanish' }] }, preferred: true },
    { language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en', display: 'English' }] } },
  ]);
  expect(patientOf('<languageCommunication><languageCode nullFlavor="UNK"/></languageCommunication>').communication).toBeUndefined();
});

test('the US Core race and ethnicity extensions carry their required text sub-extension', () => {
  const patient = patientOf(`<raceCode code="2106-3" codeSystem="2.16.840.1.113883.6.238" displayName="White"/>
    <ethnicGroupCode code="2186-5" codeSystem="2.16.840.1.113883.6.238" displayName="Not Hispanic or Latino"/>`);
  const [race, ethnicity] = patient.extension ?? [];
  expect(race.extension).toEqual([
    { url: 'ombCategory', valueCoding: { system: 'urn:oid:2.16.840.1.113883.6.238', code: '2106-3', display: 'White' } },
    { url: 'text', valueString: 'White' },
  ]);
  expect(ethnicity.extension?.[1]).toEqual({ url: 'text', valueString: 'Not Hispanic or Latino' });
  // A code that names nothing gives no text.
  expect(patientOf('<raceCode code="2106-3" codeSystem="2.16.840.1.113883.6.238"/>').extension?.[0].extension).toHaveLength(1);
});

test('a person name with no parts (a nullFlavor) is no name; a name given as text only is its text', () => {
  const xml = (name: string) => `<ClinicalDocument xmlns="urn:hl7-org:v3"><recordTarget><patientRole><patient/></patientRole></recordTarget>
    <legalAuthenticator><assignedEntity><id root="2.16.840.1.113883.19.5" extension="A"/><assignedPerson>${name}</assignedPerson></assignedEntity></legalAuthenticator>
    <component><structuredBody/></component></ClinicalDocument>`;
  const doctor = (name: string) => (convertCcdaToFhir(convertXmlToCcda(xml(name))).entry ?? []).map((e) => e.resource).find((r) => r?.resourceType === 'Practitioner') as { name?: unknown };
  expect(doctor('<name nullFlavor="UNK"/>').name).toBeUndefined();
  expect(doctor('<name>Pat Doe, MD</name>').name).toEqual([{ text: 'Pat Doe, MD' }]);
  expect(doctor('<name><given>Pat</given><family>Doe</family></name>').name).toEqual([{ family: 'Doe', given: ['Pat'] }]);
  // Text keeps the name's use; text with only a prefix or suffix keeps both; loose text beside parts is kept as text.
  expect(doctor('<name use="L">Pat Doe</name>').name).toEqual([{ use: 'official', text: 'Pat Doe' }]);
  expect(doctor('<name><prefix>Dr.</prefix>Pat Doe<suffix>MD</suffix></name>').name).toEqual([{ prefix: ['Dr.'], suffix: ['MD'], text: 'Pat Doe' }]);
  expect(doctor('<name>Pat<family>Doe</family></name>').name).toEqual([{ family: 'Doe', text: 'Pat' }]);
  // Loose text pieces on both sides of a part are joined with a space, whitespace collapsed.
  expect(doctor('<name>Dr. <given>John</given>   Smith</name>').name).toEqual([{ given: ['John'], text: 'Dr. Smith' }]);
  expect(doctor('<name use="L"><given>A</given>x<family>C</family>y</name>').name).toEqual([{ use: 'official', family: 'C', given: ['A'], text: 'x y' }]);
});
