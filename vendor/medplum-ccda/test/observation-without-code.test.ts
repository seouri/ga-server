import type { Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const social = (code: string, value: string) => convertSections(`<component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.17" extension="2015-08-01"/>
  <code code="29762-2" codeSystem="2.16.840.1.113883.6.1"/><title>Social History</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.38"/>
    <id root="2.16.840.1.113883.19.5" extension="S-1"/>
    ${code}<statusCode code="completed"/><effectiveTime value="20240210"/>${value}
  </observation></entry></section></component>`);

test('an observation with a value but no code is kept, its code data-absent (FHIR requires one)', () => {
  const [obs] = resourcesOf<Observation>(social('<code nullFlavor="UNK"/>', '<value xsi:type="ST">Lives alone</value>'), 'Observation');
  expect(obs).toMatchObject({
    identifier: [{ value: 'S-1' }],
    code: { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }] },
    valueString: 'Lives alone',
  });
});

test('an observation with neither code nor value is still skipped', () => {
  expect(resourcesOf<Observation>(social('<code nullFlavor="NA"/>', ''), 'Observation')).toEqual([]);
  expect(resourcesOf<Observation>(social('<code nullFlavor="NA"/>', '<value xsi:type="CD" nullFlavor="UNK"/>'), 'Observation')).toEqual([]);
});
