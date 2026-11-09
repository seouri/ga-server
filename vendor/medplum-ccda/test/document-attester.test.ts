import type { Composition, Practitioner, PractitionerRole } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertCcdaToFhir } from '../ccda-to-fhir.ts';
import { convertXmlToCcda } from '../xml.ts';
import { resourcesOf } from './convert-sections.ts';

const entity = (ext: string) => `<assignedEntity><id root="2.16.840.1.113883.19.5" extension="${ext}"/><addr use="WP"><state>ST</state></addr>
  <telecom use="WP" value="tel:+1-555-555-0100"/><assignedPerson><name nullFlavor="UNK"/></assignedPerson></assignedEntity>`;

test('the legalAuthenticator is a legal attester and each authenticator a professional one, with time and party', () => {
  const xml = `<ClinicalDocument xmlns="urn:hl7-org:v3"><recordTarget><patientRole><patient/></patientRole></recordTarget>
    <legalAuthenticator><time value="20200102030400-0500"/><signatureCode code="S"/>${entity('LA')}</legalAuthenticator>
    <authenticator><time value="20200101"/><signatureCode code="S"/>${entity('AU')}</authenticator>
    <component><structuredBody/></component></ClinicalDocument>`;
  const bundle = convertCcdaToFhir(convertXmlToCcda(xml));
  const [composition] = resourcesOf<Composition>(bundle, 'Composition');
  const roles = new Map(resourcesOf<PractitionerRole>(bundle, 'PractitionerRole').map((r) => [`PractitionerRole/${r.id}`, r]));
  const doctors = new Map(resourcesOf<Practitioner>(bundle, 'Practitioner').map((p) => [`Practitioner/${p.id}`, p]));
  const who = (ref?: string) => doctors.get(roles.get(ref ?? '')?.practitioner?.reference ?? '');
  expect(composition.attester?.map((a) => [a.mode, a.time])).toEqual([['legal', '2020-01-02T03:04:00-05:00'], ['professional', '2020-01-01']]);
  const legal = who(composition.attester?.[0].party?.reference);
  expect(legal?.identifier).toEqual([{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'LA' }]);
  expect(legal?.address).toEqual([{ use: 'work', state: 'ST' }]);
  expect(legal?.telecom).toEqual([{ system: 'phone', value: '+1-555-555-0100', use: 'work' }]);
  expect(who(composition.attester?.[1].party?.reference)?.identifier?.[0].value).toBe('AU');
});

test('a document with no authenticator has no attester', () => {
  const xml = `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody/></component></ClinicalDocument>`;
  expect(resourcesOf<Composition>(convertCcdaToFhir(convertXmlToCcda(xml)), 'Composition')[0].attester).toBeUndefined();
});
