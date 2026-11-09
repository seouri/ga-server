import type { Condition } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const concern = (section: string, code: string, id: string) => `<component><section><templateId root="${section}"/>
  <code code="${code}" codeSystem="2.16.840.1.113883.6.1"/><title>Concerns</title><text>Concerns</text>
  <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><id root="2.16.840.1.113883.19.5" extension="ACT-${id}"/>
  <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/><entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.4"/><id root="2.16.840.1.113883.19.5" extension="${id}"/>
  <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/><statusCode code="completed"/><effectiveTime><low value="2020"/></effectiveTime>
  <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96"/></observation></entryRelationship></act></entry></section></component>`;
const categories = (xml: string) => resourcesOf<Condition>(convertSections(xml), 'Condition').map((c) => c.category?.flatMap((x) => x.coding?.map((y) => `${y.system}|${y.code}`)));

test('a Health Concerns section entry is a US Core health-concern; a Problems section entry stays a problem-list item', () => {
  expect(categories(concern('2.16.840.1.113883.10.20.22.2.58', '75310-3', 'HC-1'))).toEqual([['http://hl7.org/fhir/us/core/CodeSystem/condition-category|health-concern']]);
  expect(categories(concern('2.16.840.1.113883.10.20.22.2.5.1', '11450-4', 'P-1'))).toEqual([['http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item']]);
});
