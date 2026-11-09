import type { Condition } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

// A problem observation; `inner` goes inside it (a Problem Status observation), `time` is its effectiveTime.
const problem = (id: string, time: string, inner = '') => `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.4"/><id root="2.16.840.1.113883.19.5" extension="${id}"/>
  <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/><statusCode code="completed"/><effectiveTime>${time}</effectiveTime>
  <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96"/>${inner}</observation></entryRelationship>`;
const status = (code: string, name: string) => `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.6"/><code code="33999-4" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/>
  <value xsi:type="CD" code="${code}" codeSystem="2.16.840.1.113883.6.96" displayName="${name}"/></observation></entryRelationship>`;
let concerns = 0;
const concern = (statusCode: string, obs: string) => `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/>
  <id root="2.16.840.1.113883.19.5" extension="CONCERN-${++concerns}"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="${statusCode}"/>${obs}</act></entry>`;

test('problem clinical status: status observation, else an end date, else the concern act; resolved stays resolved', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
    <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/><title>Problems</title><text>Problems</text>
    ${concern('active', problem('P-STATUS', '<low value="2020"/><high value="2021"/>', status('73425007', 'Inactive')))}
    ${concern('active', problem('P-HIGH', '<low value="2020"/><high value="2021"/>'))}
    ${concern('active', problem('P-OPEN', '<low value="2020"/><high nullFlavor="UNK"/>'))}
    ${concern('completed', problem('P-DONE', '<low value="2020"/>'))}
    ${concern('completed', problem('P-NAME', '<low value="2020"/>', status('', 'Active')))}
  </section></component>`);
  const clinical = (c: Condition) => c.clinicalStatus?.coding?.[0]?.code;
  expect(resourcesOf<Condition>(bundle, 'Condition').map((c) => [c.identifier?.[0].value, clinical(c)])).toEqual([
    ['P-STATUS', 'inactive'],
    ['P-HIGH', 'resolved'],
    ['P-OPEN', 'active'],
    ['P-DONE', 'resolved'],
    ['P-NAME', 'active'],
  ]);
});

test('an encounter indication (RSON) diagnosis takes its status the same way: an end date resolves it', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>Visit</text>
    <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="2.16.840.1.113883.19.5" extension="ENC-1"/><code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <entryRelationship typeCode="RSON"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.19"/>
        <id root="2.16.840.1.113883.19.5" extension="RSON-1"/><code code="404684003" codeSystem="2.16.840.1.113883.6.96"/><statusCode code="completed"/>
        <effectiveTime><low value="20240101"/><high value="20240201"/></effectiveTime>
        <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96"/></observation></entryRelationship>
    </encounter></entry>
  </section></component>`);
  expect(resourcesOf<Condition>(bundle, 'Condition').map((c) => c.clinicalStatus?.coding?.[0]?.code)).toEqual(['resolved']);
});

test('a problem\'s verification status is in the condition-ver-status code system', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
    <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/><title>Problems</title><text>Problems</text>
    ${concern('active', problem('P-1', '<low value="2020"/>'))}
  </section></component>`);
  expect(resourcesOf<Condition>(bundle, 'Condition')[0].verificationStatus).toEqual({
    coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }],
  });
});
