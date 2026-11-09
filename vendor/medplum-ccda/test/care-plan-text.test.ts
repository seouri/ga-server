import type { CarePlan } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

test('a Plan of Treatment act keeps the narrative its text references as the CarePlan description', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.10"/>
    <code code="18776-5" codeSystem="2.16.840.1.113883.6.1"/><title>Plan of Treatment</title>
    <text><paragraph ID="plan1">Recheck blood pressure in three months.</paragraph></text>
    <entry><act classCode="ACT" moodCode="INT"><templateId root="2.16.840.1.113883.10.20.22.4.39"/>
      <id root="2.16.840.1.113883.19.5" extension="PLAN-1"/><code code="409073007" codeSystem="2.16.840.1.113883.6.96" displayName="Education"/>
      <text><reference value="#plan1"/></text><statusCode code="active"/><effectiveTime value="20240510"/></act></entry>
  </section></component>`);
  const [plan] = resourcesOf<CarePlan>(bundle, 'CarePlan');
  expect(plan.description).toBe('Recheck blood pressure in three months.');
  expect(plan.extension).toEqual([{ url: 'https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference', valueString: '#plan1' }]);
});
