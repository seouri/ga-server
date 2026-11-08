import type { Condition, Encounter } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

// Encounter Diagnosis act (22.4.80): Epic links it with typeCode SUBJ, the C-CDA IG with REFR.
const diagnosis = (typeCode: string, id: string, code: string) => `<entryRelationship typeCode="${typeCode}">
  <act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.80" extension="2015-08-01"/>
    <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/><statusCode code="completed"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/><id root="2.16.840.1.113883.19.5" extension="${id}"/>
      <code code="282291009" codeSystem="2.16.840.1.113883.6.96" displayName="Diagnosis"/><statusCode code="completed"/>
      <effectiveTime><low value="20240210"/></effectiveTime>
      <value xsi:type="CD" code="${code}" codeSystem="2.16.840.1.113883.6.96"/></observation></entryRelationship>
  </act></entryRelationship>`;

test('encounter diagnoses become Conditions linked to their encounter', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>Office visit</text>
    <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="2.16.840.1.113883.19.5" extension="ENC-1"/><code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <effectiveTime><low value="20240210093000-0500"/></effectiveTime>
      ${diagnosis('SUBJ', 'VISITDX-1', '36971009')}${diagnosis('REFR', 'VISITDX-2', '195662009')}
    </encounter></entry>
  </section></component>`);
  const [encounter] = resourcesOf<Encounter>(bundle, 'Encounter');
  const conditions = resourcesOf<Condition>(bundle, 'Condition');
  expect(conditions.map((c) => c.code?.coding?.[0].code)).toEqual(['36971009', '195662009']);
  expect(conditions.map((c) => c.identifier?.[0].value)).toEqual(['VISITDX-1', 'VISITDX-2']);
  for (const c of conditions) {
    expect(c.category?.[0].coding?.[0].code).toBe('encounter-diagnosis');
    expect(c.encounter?.reference).toBe(`Encounter/${encounter.id}`);
    expect(c.onsetDateTime).toBe('2024-02-10');
  }
  expect(new Set(conditions.map((c) => c.id)).size).toBe(2);
});
