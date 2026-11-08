import type { DiagnosticReport, Observation } from '@medplum/fhirtypes';
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
