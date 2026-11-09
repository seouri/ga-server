import type { Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const result = (interpretationXml: string) => `<component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
    <id root="2.16.840.1.113883.19.5" extension="LAB-1"/>
    <code code="2345-7" codeSystem="2.16.840.1.113883.6.1" displayName="Glucose"/>
    <statusCode code="completed"/><effectiveTime value="20240210"/>
    <value xsi:type="PQ" value="130" unit="mg/dL"/>
    ${interpretationXml}
  </observation></entry></section></component>`;

test('a result interpretation code becomes Observation.interpretation (HL7 v3 ObservationInterpretation)', () => {
  const [obs] = resourcesOf<Observation>(convertSections(result('<interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83" displayName="High"/>')), 'Observation');
  expect(obs.interpretation).toEqual([
    { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'H', display: 'High' }], text: 'High' },
  ]);
});

test('every interpretation code is kept; none, or a nullFlavor, gives no interpretation', () => {
  const two = '<interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/><interpretationCode code="A" codeSystem="2.16.840.1.113883.5.83"/>';
  const [obs] = resourcesOf<Observation>(convertSections(result(two)), 'Observation');
  expect(obs.interpretation?.map((i) => i.coding?.[0].code)).toEqual(['H', 'A']);
  expect(resourcesOf<Observation>(convertSections(result('')), 'Observation')[0].interpretation).toBeUndefined();
  expect(resourcesOf<Observation>(convertSections(result('<interpretationCode nullFlavor="UNK"/>')), 'Observation')[0].interpretation).toBeUndefined();
});
