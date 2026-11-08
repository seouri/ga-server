import type { Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

test('a CO (coded ordinal) value is a code, not a quantity', () => {
  const [obs] = resourcesOf<Observation>(convertSections(`<component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title>
    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5" extension="LAB-CO"/>
      <code code="5778-6" codeSystem="2.16.840.1.113883.6.1" displayName="Color of Urine"/>
      <statusCode code="completed"/><effectiveTime value="20240210"/>
      <value xsi:type="CO" code="LA6576-8" codeSystem="2.16.840.1.113883.6.1" displayName="Positive"/>
    </observation></entry></section></component>`), 'Observation');
  expect(obs.valueQuantity).toBeUndefined();
  expect(obs.valueCodeableConcept).toEqual({ coding: [{ system: 'http://loinc.org', code: 'LA6576-8', display: 'Positive' }], text: 'Positive' });
});
