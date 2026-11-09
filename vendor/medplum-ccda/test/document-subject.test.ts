import type { CareTeam, Composition, Patient } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

test('the Composition and a CareTeam are about the document\'s patient; each section is a snapshot', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.500" extension="2022-06-01"/>
    <code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/><title>Care Team</title><text>x</text>
    <entry><organizer classCode="CLUSTER" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.500" extension="2022-06-01"/>
      <id root="2.16.840.1.113883.19.5" extension="TEAM-1"/><code code="86744-0" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/>
      <component><act classCode="PCPR" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.500.1" extension="2022-06-01"/>
        <code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/>
        <performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="A"/></assignedEntity></performer></act></component>
    </organizer></entry></section></component>`);
  const [patient] = resourcesOf<Patient>(bundle, 'Patient');
  const [composition] = resourcesOf<Composition>(bundle, 'Composition');
  const [team] = resourcesOf<CareTeam>(bundle, 'CareTeam');
  expect(composition.subject?.reference).toBe(`Patient/${patient.id}`);
  expect(team.subject?.reference).toBe(`Patient/${patient.id}`);
  expect(composition.section?.map((s) => s.mode)).toEqual(['snapshot']);
});
