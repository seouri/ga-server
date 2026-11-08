import type { Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
const section = (templateXml: string, code: string, entryXml: string) => `<component><section>${templateXml}
  ${code}<title>T</title><entry>${entryXml}</entry></section></component>`;
const observation = (templateXml: string, idExt: string) => `<observation classCode="OBS" moodCode="EVN">${templateXml}
  <id root="2.16.840.1.113883.19.5" extension="${idExt}"/>
  <code code="11331-6" codeSystem="2.16.840.1.113883.6.1" displayName="History of alcohol use"/>
  <statusCode code="completed"/><effectiveTime value="20240210"/><value xsi:type="ST">Not currently</value></observation>`;
const codes = (o: Observation | undefined) => o?.category?.map((c) => `${c.coding?.[0].system === CATEGORY ? '' : `${c.coding?.[0].system}|`}${c.coding?.[0].code}`);
const one = (xml: string) => resourcesOf<Observation>(convertSections(xml), 'Observation')[0];

const SOCIAL = '<templateId root="2.16.840.1.113883.10.20.22.2.17"/><templateId root="2.16.840.1.113883.10.20.22.2.17" extension="2015-08-01"/>';
const SOCIAL_CODE = '<code code="29762-2" codeSystem="2.16.840.1.113883.6.1" displayName="Social history"/>';

test('an observation in Social History is social-history, also when its only template is a vendor one', () => {
  expect(codes(one(section(SOCIAL, SOCIAL_CODE, observation('<templateId root="1.2.840.114350.1.13.999.2.7.9.1"/>', 'S-1'))))).toEqual(['social-history']);
});

test('an assessment in Social History keeps its own category and gains its section\'s', () => {
  expect(codes(one(section(SOCIAL, SOCIAL_CODE, observation('<templateId root="2.16.840.1.113883.10.20.22.4.69"/>', 'S-2'))))).toEqual(['survey', 'social-history']);
});

test('an observation in Results or Vital Signs with a vendor template is laboratory or vital-signs', () => {
  const results = '<templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>';
  const vitals = '<templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>';
  expect(codes(one(section(results, '<code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>', observation('<templateId root="1.2.3.4"/>', 'R-1'))))).toEqual(['laboratory']);
  expect(codes(one(section(vitals, '<code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>', observation('<templateId root="1.2.3.4"/>', 'V-1'))))).toEqual(['vital-signs']);
});

test('an observation no template or section classifies (Reason for Visit) takes its section\'s code as category; with none, no category', () => {
  const rfv = section('<templateId root="2.16.840.1.113883.10.20.22.2.12"/>', '<code code="29299-5" codeSystem="2.16.840.1.113883.6.1" displayName="Reason for visit"/>',
    observation('<templateId root="2.16.840.1.113883.10.20.22.4.19"/>', 'V-2'));
  expect(codes(one(rfv))).toEqual(['http://loinc.org|29299-5']);
  expect(one(section('<templateId root="1.2.3.5"/>', '', observation('<templateId root="1.2.3.4"/>', 'X-1'))).category).toBeUndefined();
});
