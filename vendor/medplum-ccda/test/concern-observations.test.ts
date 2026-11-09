import type { AllergyIntolerance, Condition } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const problem = (id: string, code: string) => `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.4"/><id root="2.16.840.1.113883.19.5" extension="${id}"/>
  <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/><statusCode code="completed"/><effectiveTime><low value="20190305"/></effectiveTime>
  <value xsi:type="CD" code="${code}" codeSystem="2.16.840.1.113883.6.96"/></observation></entryRelationship>`;

const allergy = (id: string, code: string) => `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.7"/><id root="2.16.840.1.113883.19.5" extension="${id}"/>
  <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><statusCode code="completed"/>
  <value xsi:type="CD" code="416098002" codeSystem="2.16.840.1.113883.6.96"/>
  <participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">
    <code code="${code}" codeSystem="2.16.840.1.113883.6.88"/></playingEntity></participantRole></participant></observation></entryRelationship>`;

test('a problem concern act with two problem observations becomes two Conditions, each keyed by its own observation id', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
    <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/><title>Problems</title><text>Problems</text>
    <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <id root="2.16.840.1.113883.19.5" extension="CONCERN-1"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/>
      ${problem('PROBLEM-1', '38341003')}${problem('PROBLEM-2', '44054006')}</act></entry>
  </section></component>`);
  const conditions = resourcesOf<Condition>(bundle, 'Condition');
  expect(conditions.map((c) => c.code?.coding?.[0].code)).toEqual(['38341003', '44054006']);
  expect(conditions.map((c) => c.identifier?.[0].value)).toEqual(['PROBLEM-1', 'PROBLEM-2']);
  expect(conditions[0].identifier?.map((i) => i.value)).toEqual(['PROBLEM-1', 'CONCERN-1']);
  expect(new Set(conditions.map((c) => c.id)).size).toBe(2);
});

test('an allergy concern act with two allergy observations becomes two AllergyIntolerances, each keyed by its own observation id', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
    <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/><title>Allergies</title><text>Allergies</text>
    <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.30"/>
      <id root="2.16.840.1.113883.19.5" extension="ALLERGY-CONCERN-1"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/>
      ${allergy('ALLERGY-1', '7980')}${allergy('ALLERGY-2', '2670')}</act></entry>
  </section></component>`);
  const allergies = resourcesOf<AllergyIntolerance>(bundle, 'AllergyIntolerance');
  expect(allergies.map((a) => a.code?.coding?.[0].code)).toEqual(['7980', '2670']);
  expect(allergies.map((a) => a.identifier?.[0].value)).toEqual(['ALLERGY-1', 'ALLERGY-2']);
  expect(new Set(allergies.map((a) => a.id)).size).toBe(2);
});
