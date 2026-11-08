import type { CareTeam } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const performer = (fn: string, family: string) => `<performer typeCode="PRF"><functionCode code="${fn}" codeSystem="2.16.840.1.113883.5.88"/>
  <assignedEntity><id root="2.16.840.1.113883.4.6" extension="${family}"/><assignedPerson><name><given>Example</given><family>${family}</family></name></assignedPerson></assignedEntity></performer>`;
const member = (performers: string) => `<component><act classCode="PCPR" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.500.1" extension="2022-06-01"/>
  <code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/><effectiveTime><low value="20200101"/></effectiveTime>${performers}</act></component>`;

test('every care team member act and every performer of each becomes a participant', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.500" extension="2022-06-01"/>
    <code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/><title>Care Team</title><text>x</text>
    <entry><organizer classCode="CLUSTER" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.500" extension="2022-06-01"/>
      <id root="2.16.840.1.113883.19.5" extension="TEAM-1"/><code code="86744-0" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/>
      ${member(performer('PCP', 'Alpha'))}${member(performer('ATTPHYS', 'Beta') + performer('RNDPHYS', 'Gamma'))}
    </organizer></entry></section></component>`);
  const [team] = resourcesOf<CareTeam>(bundle, 'CareTeam');
  expect(team.participant?.map((p) => p.role?.[0].coding?.[0].code)).toEqual(['PCP', 'ATTPHYS', 'RNDPHYS']);
  expect(team.participant?.every((p) => p.member?.reference && p.period?.start)).toBe(true);
});
