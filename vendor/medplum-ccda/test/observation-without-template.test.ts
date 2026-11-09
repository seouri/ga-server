import type { Goal, Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const section = (template: string, observation: string) =>
  `<component><section><templateId root="${template}"/><title>S</title><text>x</text><entry>${observation}</entry></section></component>`;

test('an observation without a templateId converts instead of throwing', () => {
  const obs = `<observation classCode="OBS" moodCode="EVN"><id root="2.16.840.1.113883.19.5" extension="OBS-1"/>
    <code code="72166-2" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/><effectiveTime value="20240210"/>
    <value xsi:type="CD" code="266919005" codeSystem="2.16.840.1.113883.6.96" displayName="Never smoker"/></observation>`;
  const [o] = resourcesOf<Observation>(convertSections(section('2.16.840.1.113883.10.20.22.2.17', obs)), 'Observation');
  expect(o.valueCodeableConcept?.coding?.[0].code).toBe('266919005');
});

test('a goal matched by any of its templateIds, without a statusCode, is active', () => {
  const goal = `<observation classCode="OBS" moodCode="GOL"><templateId root="2.16.840.1.113883.10.20.22.4.999"/><templateId root="2.16.840.1.113883.10.20.22.4.121"/>
    <id root="2.16.840.1.113883.19.5" extension="GOAL-1"/><code code="1" codeSystem="2.16.840.1.113883.6.1"/><value xsi:type="ST">Walk daily</value></observation>`;
  const [g] = resourcesOf<Goal>(convertSections(section('2.16.840.1.113883.10.20.22.2.17', goal)), 'Goal');
  expect([g.description.text, g.lifecycleStatus]).toEqual(['Walk daily', 'active']);
});
