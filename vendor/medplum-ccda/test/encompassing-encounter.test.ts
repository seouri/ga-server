import type { Composition, Encounter, Location } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertCcdaToFhir } from '../ccda-to-fhir.ts';
import { convertXmlToCcda } from '../xml.ts';
import { resourcesOf } from './convert-sections.ts';

const doc = (body: string) => `<ClinicalDocument xmlns="urn:hl7-org:v3"><recordTarget><patientRole><patient/></patientRole></recordTarget>
  <componentOf><encompassingEncounter><id root="2.16.840.1.113883.19.5.3" extension="V1"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12"><translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/></code>
    <effectiveTime><low value="20200102"/><high value="20200102"/></effectiveTime>
    <encounterParticipant typeCode="ATND"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="NPI-1"/></assignedEntity></encounterParticipant>
    <location><healthCareFacility><id root="2.16.840.1.113883.19.5.4" extension="F1"/>
      <location><name>Test Clinic</name><addr><city>Town</city></addr></location></healthCareFacility></location>
  </encompassingEncounter></componentOf>
  <component><structuredBody>${body}</structuredBody></component></ClinicalDocument>`;

test('the encompassing encounter is the Composition encounter: a new Encounter with its class, type, period, facility and participant', () => {
  const bundle = convertCcdaToFhir(convertXmlToCcda(doc('')));
  const [composition] = resourcesOf<Composition>(bundle, 'Composition');
  const [encounter] = resourcesOf<Encounter>(bundle, 'Encounter');
  const [location] = resourcesOf<Location>(bundle, 'Location');
  expect(composition.encounter?.reference).toBe(`Encounter/${encounter.id}`);
  expect(encounter.identifier).toEqual([{ system: 'urn:oid:2.16.840.1.113883.19.5.3', value: 'V1' }]);
  expect(encounter.class.code).toBe('AMB');
  expect(encounter.type?.[0].coding?.[0].code).toBe('99213');
  expect(encounter.period).toEqual({ start: '2020-01-02', end: '2020-01-02' });
  expect(encounter.participant?.[0].type?.[0].coding?.[0].code).toBe('ATND');
  expect(encounter.location?.[0].location.reference).toBe(`Location/${location.id}`);
  expect(location).toMatchObject({ identifier: [{ value: 'F1' }], name: 'Test Clinic', address: { city: 'Town' } });
});

test('an entry Encounter with the same id is the Composition encounter: no second Encounter', () => {
  const bundle = convertCcdaToFhir(convertXmlToCcda(doc(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>
    <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="2.16.840.1.113883.19.5.3" extension="V1"/><code code="99213" codeSystem="2.16.840.1.113883.6.12"/></encounter></entry>
  </section></component>`)));
  const encounters = resourcesOf<Encounter>(bundle, 'Encounter');
  expect(encounters).toHaveLength(1);
  expect(resourcesOf<Composition>(bundle, 'Composition')[0].encounter?.reference).toBe(`Encounter/${encounters[0].id}`);
});

test('a document with no encompassing encounter has no Composition encounter', () => {
  const xml = `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody/></component></ClinicalDocument>`;
  expect(resourcesOf<Composition>(convertCcdaToFhir(convertXmlToCcda(xml)), 'Composition')[0].encounter).toBeUndefined();
});
