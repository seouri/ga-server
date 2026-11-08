import type { Goal, ServiceRequest } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const plan = (entryXml: string) => `<component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.10"/><templateId root="2.16.840.1.113883.10.20.22.2.10" extension="2014-06-09"/>
  <code code="18776-5" codeSystem="2.16.840.1.113883.6.1"/><title>Plan of Treatment</title>
  <text><paragraph ID="p1">Fasting labs before the visit.</paragraph></text>
  <entry>${entryXml}</entry></section></component>`;
const planned = (mood: string, extra = '') => `<observation classCode="OBS" moodCode="${mood}">
  <templateId root="2.16.840.1.113883.10.20.22.4.44"/><templateId root="2.16.840.1.113883.10.20.22.4.44" extension="2014-06-09"/>
  <id root="2.16.840.1.113883.19.5" extension="PLANOBS-1"/>
  <code code="24323-8" codeSystem="2.16.840.1.113883.6.1" displayName="Comprehensive metabolic panel"/>
  <text><reference value="#p1"/></text>
  <statusCode code="active"/><effectiveTime value="20240510"/>${extra}</observation>`;

test('a planned observation (RQO) in Plan of Treatment is a ServiceRequest, not a Goal', () => {
  const bundle = convertSections(plan(planned('RQO')));
  expect(resourcesOf<Goal>(bundle, 'Goal')).toEqual([]);
  const [req] = resourcesOf<ServiceRequest>(bundle, 'ServiceRequest');
  expect(req).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'PLANOBS-1' }],
    status: 'active',
    intent: 'order',
    code: { coding: [{ system: 'http://loinc.org', code: '24323-8' }] },
    occurrenceDateTime: '2024-05-10',
    note: [{ text: 'Fasting labs before the visit.' }],
  });
  expect(req.subject?.reference).toMatch(/^Patient\//);
});

test('its intent follows moodCode: INT plan, PRP proposal, ARQ order', () => {
  const intent = (mood: string) => resourcesOf<ServiceRequest>(convertSections(plan(planned(mood))), 'ServiceRequest')[0]?.intent;
  expect([intent('INT'), intent('PRP'), intent('ARQ')]).toEqual(['plan', 'proposal', 'order']);
});

test('a goal (GOL) in Plan of Treatment stays a Goal', () => {
  expect(resourcesOf<Goal>(convertSections(plan(planned('GOL'))), 'Goal')).toHaveLength(1);
});
