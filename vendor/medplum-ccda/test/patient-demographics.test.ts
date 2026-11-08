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
