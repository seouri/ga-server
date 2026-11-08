import type { ServiceRequest } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

test('a Reason for Referral entry becomes a ServiceRequest with its narrative text', () => {
  const bundle = convertSections(`<component><section>
    <templateId root="1.3.6.1.4.1.19376.1.5.3.1.3.1"/><templateId root="1.3.6.1.4.1.19376.1.5.3.1.3.1" extension="2014-06-09"/>
    <code code="42349-1" codeSystem="2.16.840.1.113883.6.1" displayName="Reason for referral"/><title>Reason for Referral</title>
    <text><paragraph ID="ref1">Referral to example ENT clinic.</paragraph></text>
    <entry><act classCode="PCPR" moodCode="INT"><templateId root="2.16.840.1.113883.10.20.22.4.140"/>
      <id root="2.16.840.1.113883.19.5" extension="REF-1"/>
      <code code="44383000" codeSystem="2.16.840.1.113883.6.96" displayName="Patient referral for consultation"/>
      <text><reference value="#ref1"/></text><statusCode code="active"/><effectiveTime value="20240210"/>
      <performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="0000000001"/>
        <assignedPerson><name><given>Example</given><family>Otolaryngologist</family></name></assignedPerson></assignedEntity></performer>
    </act></entry></section></component>`);
  const [req] = resourcesOf<ServiceRequest>(bundle, 'ServiceRequest');
  expect(req).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'REF-1' }],
    status: 'active',
    intent: 'plan',
    code: { coding: [{ system: 'http://snomed.info/sct', code: '44383000' }] },
    occurrenceDateTime: '2024-02-10',
    note: [{ text: 'Referral to example ENT clinic.' }],
  });
  expect(req.subject?.reference).toMatch(/^Patient\//);
  expect(req.performer?.[0].reference).toMatch(/^PractitionerRole\//);
});
