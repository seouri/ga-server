import type { Encounter, Location } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const encounter = (inner: string) => resourcesOf<Encounter>(convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>Office visit</text>
    <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="2.16.840.1.113883.19.5" extension="ENC-1"/>${inner}
      <effectiveTime><low value="20240210093000-0500"/></effectiveTime>
    </encounter></entry></section></component>`), 'Encounter')[0];
const ABSENT = { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }] };

test('a CPT visit code is the encounter type, never its class; with no ActCode the class is data-absent', () => {
  const e = encounter('<code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office visit"/>');
  expect(e.type?.[0].coding?.[0]).toMatchObject({ system: 'http://www.ama-assn.org/go/cpt', code: '99213' });
  expect(e.class).toEqual(ABSENT);
  expect(encounter('').class).toEqual(ABSENT);
});

test('the class is the encounter code or translation in v3 ActCode', () => {
  const translated = encounter(`<code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office visit">
    <translation code="AMB" codeSystem="2.16.840.1.113883.5.4" displayName="ambulatory"/></code>`);
  expect(translated.class).toEqual({ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' });
  expect(encounter('<code code="IMP" codeSystem="2.16.840.1.113883.5.4" displayName="inpatient encounter"/>').class)
    .toEqual({ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' });
});

test('an encounter\'s service delivery location is a Location it points at', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>Office visit</text>
    <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="2.16.840.1.113883.19.5" extension="ENC-1"/><effectiveTime value="20240210"/>
      <participant typeCode="LOC"><participantRole classCode="SDLOC"><templateId root="2.16.840.1.113883.10.20.22.4.32"/>
        <id root="2.16.840.1.113883.19.5.9" extension="DEPT-1"/>
        <code code="1160-1" codeSystem="2.16.840.1.113883.6.259" displayName="Urgent Care Center"/>
        <addr><streetAddressLine>2 Example Plaza</streetAddressLine><city>Testville</city><state>ZZ</state><postalCode>00000</postalCode></addr>
        <telecom use="WP" value="tel:+1-555-555-0100"/>
        <playingEntity classCode="PLC"><name>Example Clinic</name></playingEntity>
      </participantRole></participant>
    </encounter></entry></section></component>`);
  const [e] = resourcesOf<Encounter>(bundle, 'Encounter');
  const [loc] = resourcesOf<Location>(bundle, 'Location');
  expect(e.location).toEqual([{ location: { reference: `Location/${loc.id}`, display: 'Example Clinic' } }]);
  expect(loc).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5.9', value: 'DEPT-1' }],
    name: 'Example Clinic',
    type: [{ coding: [{ code: '1160-1', display: 'Urgent Care Center' }] }],
    address: { line: ['2 Example Plaza'], city: 'Testville', state: 'ZZ', postalCode: '00000' },
    telecom: [{ system: 'phone', use: 'work' }],
  });
  expect(encounter('').location).toBeUndefined();
});
