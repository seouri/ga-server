import type { DiagnosticReport, Encounter, Observation, Organization, Practitioner, PractitionerRole, Procedure, Specimen } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const results = (organizerXml: string) => `<component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title>
  <entry>${organizerXml}</entry></section></component>`;
const result = (id: string, code: string) => `<component><observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="${id}"/>
  <code code="${code}" codeSystem="2.16.840.1.113883.6.1"/>
  <statusCode code="completed"/><effectiveTime value="20240210091000-0500"/>
  <value xsi:type="PQ" value="1" unit="mg/dL"/></observation></component>`;
const organizer = (template: string, status = 'completed') => `<organizer classCode="BATTERY" moodCode="EVN">
  <templateId root="${template}"/><templateId root="${template}" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="PANEL-1"/>
  <code code="24323-8" codeSystem="2.16.840.1.113883.6.1" displayName="Comprehensive metabolic panel"/>
  <statusCode code="${status}"/>
  <effectiveTime><low value="20240210091000-0500"/><high value="20240210091000-0500"/></effectiveTime>
  ${result('RES-1', '2345-7')}${result('RES-2', '2160-0')}</organizer>`;

test('a Result Organizer becomes a DiagnosticReport whose results are its Observations', () => {
  const bundle = convertSections(results(organizer('2.16.840.1.113883.10.20.22.4.1')));
  const [report] = resourcesOf<DiagnosticReport>(bundle, 'DiagnosticReport');
  const observations = resourcesOf<Observation>(bundle, 'Observation');
  expect(observations.map((o) => o.identifier?.[0].value)).toEqual(['RES-1', 'RES-2']); // no panel Observation
  expect(report).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'PANEL-1' }],
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '24323-8' }] },
    effectiveDateTime: '2024-02-10T09:10:00-05:00',
    result: observations.map((o) => ({ reference: `Observation/${o.id}` })),
  });
  expect(report.subject?.reference).toMatch(/^Patient\//);
});

test('the V2 Result Organizer too; its status follows statusCode', () => {
  const bundle = convertSections(results(organizer('2.16.840.1.113883.10.20.22.4.1.2', 'active')));
  expect(resourcesOf<DiagnosticReport>(bundle, 'DiagnosticReport')[0].status).toBe('partial');
});

test('a Vital Signs Organizer stays a panel Observation', () => {
  const bundle = convertSections(results(organizer('2.16.840.1.113883.10.20.22.4.26')));
  expect(resourcesOf<DiagnosticReport>(bundle, 'DiagnosticReport')).toEqual([]);
  expect(resourcesOf<Observation>(bundle, 'Observation').map((o) => o.identifier?.[0].value)).toEqual(['RES-1', 'RES-2', 'PANEL-1']);
});

test('a Result Organizer performer (the lab) is the DiagnosticReport performer: a role of its assigned entity and organization', () => {
  const lab = `<performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.7" extension="LAB-1"/>
    <representedOrganization><name>Test Lab</name><addr><city>Town</city></addr></representedOrganization></assignedEntity></performer>`;
  const bundle = convertSections(results(organizer('2.16.840.1.113883.10.20.22.4.1').replace('<statusCode', `${lab}<statusCode`)));
  const [report] = resourcesOf<DiagnosticReport>(bundle, 'DiagnosticReport');
  const [role] = resourcesOf<PractitionerRole>(bundle, 'PractitionerRole');
  const [lab1] = resourcesOf<Practitioner>(bundle, 'Practitioner');
  const [org] = resourcesOf<Organization>(bundle, 'Organization');
  expect(report.performer).toEqual([{ reference: `PractitionerRole/${role.id}` }]);
  expect(role.practitioner?.reference).toBe(`Practitioner/${lab1.id}`);
  expect(lab1.identifier).toEqual([{ system: 'urn:oid:2.16.840.1.113883.4.7', value: 'LAB-1' }]);
  expect(role.organization?.reference).toBe(`Organization/${org.id}`);
  expect(org).toMatchObject({ name: 'Test Lab', address: [{ city: 'Town' }] });
  // No performer: none.
  expect(resourcesOf<DiagnosticReport>(convertSections(results(organizer('2.16.840.1.113883.10.20.22.4.1'))), 'DiagnosticReport')[0].performer).toBeUndefined();
});

test('a Result Organizer\'s procedure and encounter components: a Procedure reporting in the panel, its specimen, and the panel\'s visit', () => {
  const extra = `<specimen typeCode="SPC"><specimenRole><id root="2.16.840.1.113883.19.5.30" extension="SPEC-1"/><specimenPlayingEntity><code code="119297000" codeSystem="2.16.840.1.113883.6.96"/></specimenPlayingEntity></specimenRole></specimen>`;
  const components = `<component><procedure classCode="PROC" moodCode="EVN"><code code="82078001" codeSystem="2.16.840.1.113883.6.96" displayName="Collection of blood specimen"/>
      <effectiveTime value="20240210080000-0500"/>
      <participant typeCode="PRD"><participantRole classCode="SPEC"><id root="2.16.840.1.113883.19.5.30" extension="SPEC-1"/>
        <playingEntity><code code="119297000" codeSystem="2.16.840.1.113883.6.96" displayName="Blood specimen"/></playingEntity></participantRole></participant>
      <entryRelationship typeCode="COMP"><act classCode="ACT" moodCode="EVN"><templateId root="1.3.6.1.4.1.19376.1.3.1.3"/>
        <code code="SPRECEIVE" codeSystem="1.3.5.1.4.1.19376.1.5.3.2"/><effectiveTime value="20240210090000-0500"/></act></entryRelationship></procedure></component>
    <component><encounter classCode="ENC" moodCode="EVN"><id root="2.16.840.1.113883.19.5.3" extension="VISIT-9"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/><effectiveTime><low value="20240210"/></effectiveTime></encounter></component>`;
  const xml = organizer('2.16.840.1.113883.10.20.22.4.1').replace('<statusCode', `${extra}<statusCode`).replace('</organizer>', `${components}</organizer>`);
  const bundle = convertSections(results(xml));
  const [report] = resourcesOf<DiagnosticReport>(bundle, 'DiagnosticReport');
  const [procedure] = resourcesOf<Procedure>(bundle, 'Procedure');
  const specimens = resourcesOf<Specimen>(bundle, 'Specimen');
  const [encounter] = resourcesOf<Encounter>(bundle, 'Encounter');
  expect(procedure.code?.coding?.[0].code).toBe('82078001');
  expect(procedure.report).toEqual([{ reference: `DiagnosticReport/${report.id}` }]);
  expect(specimens).toHaveLength(1); // the organizer's specimen and the procedure's participant are one specimen
  expect(specimens[0]).toMatchObject({
    identifier: [{ value: 'SPEC-1' }],
    type: { coding: [{ code: '119297000' }] },
    collection: { collectedDateTime: '2024-02-10T08:00:00-05:00', method: { coding: [{ code: '82078001' }] } },
    receivedTime: '2024-02-10T09:00:00-05:00',
  });
  expect(report.specimen).toEqual([{ reference: `Specimen/${specimens[0].id}` }]);
  expect(encounter.identifier?.[0].value).toBe('VISIT-9');
  expect(report.encounter).toEqual({ reference: `Encounter/${encounter.id}` });
});

test('a Result Organizer\'s encounter is the Encounters-section entry of the same id when there is one', () => {
  const enc = `<component><encounter classCode="ENC" moodCode="EVN"><id root="2.16.840.1.113883.19.5.3" extension="VISIT-9"/></encounter></component>`;
  const bundle = convertSections(results(organizer('2.16.840.1.113883.10.20.22.4.1').replace('</organizer>', `${enc}</organizer>`)) +
    `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/><code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>
    <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/><id root="2.16.840.1.113883.19.5.3" extension="VISIT-9"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12"/></encounter></entry></section></component>`);
  const encounters = resourcesOf<Encounter>(bundle, 'Encounter');
  expect(encounters).toHaveLength(1);
  expect(resourcesOf<DiagnosticReport>(bundle, 'DiagnosticReport')[0].encounter).toEqual({ reference: `Encounter/${encounters[0].id}` });
});
