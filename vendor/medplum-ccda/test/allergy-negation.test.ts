// GA patch row 52: a negated Allergy - Intolerance Observation (negationInd="true").
import type { AllergyIntolerance } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const allergy = (negated: boolean, participant: string): AllergyIntolerance =>
  resourcesOf<AllergyIntolerance>(convertSections(`<component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.6.1" extension="2015-08-01"/>
    <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/>
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.30" extension="2015-08-01"/>
      <id root="00000000-0000-4000-8000-0000000000b1"/>
      <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"${negated ? ' negationInd="true"' : ''}>
        <templateId root="2.16.840.1.113883.10.20.22.4.7" extension="2014-06-09"/>
        <id root="00000000-0000-4000-8000-0000000000b2"/>
        <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><statusCode code="completed"/>
        <value xsi:type="CD" code="419199007" codeSystem="2.16.840.1.113883.6.96" displayName="Allergy to substance"/>
        ${participant}
      </observation></entryRelationship>
    </act></entry>
  </section></component>`), 'AllergyIntolerance')[0];

const substance = (code: string) => `<participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">${code}</playingEntity></participantRole></participant>`;
const NKA = { coding: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text: 'No known allergy' };

test('a negated allergy observation with no substance ("no known allergies") is coded 716186003 No known allergy, active and confirmed', () => {
  for (const p of ['', substance('<code nullFlavor="NA"/>')]) {
    const a = allergy(true, p);
    expect(a.code).toEqual(NKA);
    expect(a.clinicalStatus?.coding?.[0]?.code).toBe('active');
    expect(a.verificationStatus?.coding?.[0]?.code).toBe('confirmed');
  }
});

test('a negated allergy observation naming a substance is that substance, refuted (not allergic to it)', () => {
  const a = allergy(true, substance('<code code="7980" codeSystem="2.16.840.1.113883.6.88" displayName="Penicillin G"/>'));
  expect(a.code?.coding?.[0]?.code).toBe('7980');
  expect(a.verificationStatus?.coding?.[0]?.code).toBe('refuted');
});

test('an allergy observation that is not negated is unchanged', () => {
  const a = allergy(false, substance('<code code="7980" codeSystem="2.16.840.1.113883.6.88" displayName="Penicillin G"/>'));
  expect(a.code?.coding?.[0]?.code).toBe('7980');
  expect(a.verificationStatus?.coding?.[0]?.code).toBe('confirmed');
  expect(allergy(false, '').code).toBeUndefined();
});
