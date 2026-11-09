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

test('a negated planned observation is a request not to do it (doNotPerform)', () => {
  const negated = planned('RQO').replace('moodCode="RQO">', 'moodCode="RQO" negationInd="true">');
  expect(resourcesOf<ServiceRequest>(convertSections(plan(negated)), 'ServiceRequest')[0].doNotPerform).toBe(true);
  expect(resourcesOf<ServiceRequest>(convertSections(plan(planned('RQO'))), 'ServiceRequest')[0].doNotPerform).toBeUndefined();
});

test('a goal (GOL, or the Goal Observation template) stays a Goal, with no empty target or category', () => {
  const goal = (extra: string) => `<observation classCode="OBS" moodCode="GOL">
    <templateId root="2.16.840.1.113883.10.20.22.4.121"/><id root="2.16.840.1.113883.19.5" extension="GOAL-1"/>
    <statusCode code="active"/><value xsi:type="ST">Walk daily</value>${extra}</observation>`;
  const child = '<entryRelationship typeCode="RSON"><observation classCode="OBS" moodCode="EVN"><code code="1" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/></observation></entryRelationship>';
  const [g] = resourcesOf<Goal>(convertSections(plan(goal(child))), 'Goal');
  expect(g.description).toEqual({ text: 'Walk daily' });
  expect(g.target).toBeUndefined(); // an observation-only entryRelationship is no target
  expect(g.category).toBeUndefined(); // no code: no category, never []
  const act = '<entryRelationship typeCode="REFR"><act classCode="ACT" moodCode="INT"><code code="229065009" codeSystem="2.16.840.1.113883.6.96"/><effectiveTime><low value="20240601"/></effectiveTime></act></entryRelationship>';
  expect(resourcesOf<Goal>(convertSections(plan(goal(act))), 'Goal')[0].target).toEqual([
    { measure: { coding: [{ system: 'http://snomed.info/sct', code: '229065009' }] }, detailCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: '229065009' }] }, dueDate: '2024-06-01' },
  ]);
  // A GOL observation without the template is a goal too.
  expect(resourcesOf<Goal>(convertSections(plan(planned('GOL'))), 'Goal')).toHaveLength(1);
});
