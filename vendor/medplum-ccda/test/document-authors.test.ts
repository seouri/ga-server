import type { Bundle, Composition, Device, Organization, Practitioner } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertCcdaToFhir } from '../ccda-to-fhir.ts';
import { convertXmlToCcda } from '../xml.ts';
import { resourcesOf } from './convert-sections.ts';

const convert = (authors: string): Bundle => convertCcdaToFhir(convertXmlToCcda(`<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient><name><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  ${authors}
  <component><structuredBody/></component>
</ClinicalDocument>`));
const person = `<author><time value="20240612"/><assignedAuthor><id root="2.16.840.1.113883.4.6" extension="1111111111"/>
  <assignedPerson><name><given>Example</given><family>Clinician</family></name></assignedPerson></assignedAuthor></author>`;
const device = `<author><time value="20240612"/><assignedAuthor><id nullFlavor="NA"/>
  <assignedAuthoringDevice><manufacturerModelName>Example EHR</manufacturerModelName><softwareName>Example EHR Version 10</softwareName></assignedAuthoringDevice>
  <representedOrganization><id root="2.16.840.1.113883.19.5" extension="ORG-1"/><name>Example Health System</name></representedOrganization>
</assignedAuthor></author>`;

test('every document author is a Composition author; an authoring device is a Device owned by its organization, never a Practitioner', () => {
  const bundle = convert(person + device);
  const [composition] = resourcesOf<Composition>(bundle, 'Composition');
  const [practitioner, ...others] = resourcesOf<Practitioner>(bundle, 'Practitioner');
  const [dev] = resourcesOf<Device>(bundle, 'Device');
  const [org] = resourcesOf<Organization>(bundle, 'Organization');
  expect(others).toEqual([]);
  expect(composition.author?.map((a) => a.reference)).toEqual([`Practitioner/${practitioner.id}`, `Device/${dev.id}`]);
  expect(dev).toMatchObject({
    deviceName: [{ name: 'Example EHR', type: 'model-name' }],
    version: [{ value: 'Example EHR Version 10' }],
    owner: { reference: `Organization/${org.id}` },
  });
  expect(org).toMatchObject({ identifier: [{ value: 'ORG-1' }], name: 'Example Health System' });
});
