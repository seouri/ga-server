import type { Coverage, Organization } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const policy = (seq: number, id: string, inner: string) => `<entryRelationship typeCode="COMP"><sequenceNumber value="${seq}"/>
  <act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.61" extension="2015-08-01"/>
    <id root="2.16.840.1.113883.19.5.7" extension="${id}"/>
    <code code="PPO" codeSystem="2.16.840.1.113883.5.4" displayName="Preferred provider organization policy"/><statusCode code="completed"/>${inner}</act></entryRelationship>`;
const payer = `<performer typeCode="PRF"><templateId root="2.16.840.1.113883.10.20.22.4.87"/>
  <assignedEntity><id root="2.16.840.1.113883.6.300" extension="99999"/><code code="PAYOR" codeSystem="2.16.840.1.113883.5.110"/>
  <representedOrganization><name>Example Insurance Co.</name><telecom value="tel:+1-555-555-0199"/><addr><city>Town</city></addr></representedOrganization></assignedEntity></performer>`;
const guarantor = `<performer typeCode="PRF"><templateId root="2.16.840.1.113883.10.20.22.4.88"/>
  <assignedEntity><id nullFlavor="NI"/><code code="GUAR" codeSystem="2.16.840.1.113883.5.111"/></assignedEntity></performer>`;
const parties = `<participant typeCode="COV"><templateId root="2.16.840.1.113883.10.20.22.4.89"/><time><low value="20230101"/><high value="20241231"/></time>
  <participantRole classCode="PAT"><id root="2.16.840.1.113883.19.5.8" extension="MEMBER-1"/><code code="SELF" codeSystem="2.16.840.1.113883.5.111" displayName="Self"/></participantRole></participant>
  <participant typeCode="HLD"><templateId root="2.16.840.1.113883.10.20.22.4.90"/><participantRole><id root="2.16.840.1.113883.19.5.9" extension="SUBSCRIBER-1"/></participantRole></participant>`;

test('each Policy Activity of a Payers coverage act becomes a Coverage', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.18"/><templateId root="2.16.840.1.113883.10.20.22.2.18" extension="2015-08-01"/>
    <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/><title>Insurance</title><text>x</text>
    <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.60" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5.6" extension="COVERAGE-1"/><code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/>
      ${policy(1, 'POLICY-1', payer + guarantor + parties)}${policy(2, 'POLICY-2', '')}
    </act></entry></section></component>`);
  const [primary, secondary] = resourcesOf<Coverage>(bundle, 'Coverage');
  // The payer is an Organization: its id, name, telecom and address.
  const [payerOrg] = resourcesOf<Organization>(bundle, 'Organization');
  expect(payerOrg).toMatchObject({ identifier: [{ system: 'urn:oid:2.16.840.1.113883.6.300', value: '99999' }], name: 'Example Insurance Co.',
    telecom: [{ system: 'phone', value: '+1-555-555-0199' }], address: [{ city: 'Town' }] });
  expect(primary).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5.7', value: 'POLICY-1' }, { system: 'urn:oid:2.16.840.1.113883.19.5.8', value: 'MEMBER-1' }],
    status: 'active',
    type: { coding: [{ code: 'PPO' }] },
    subscriberId: 'SUBSCRIBER-1',
    relationship: { coding: [{ code: 'SELF' }] },
    period: { start: '2023-01-01', end: '2024-12-31' },
    payor: [{ reference: `Organization/${payerOrg.id}`, display: 'Example Insurance Co.' }],
    order: 1,
  });
  expect(primary.beneficiary.reference).toMatch(/^Patient\//);
  expect(secondary).toMatchObject({ identifier: [{ value: 'POLICY-2' }], order: 2, payor: [{ extension: [{ valueCode: 'unknown' }] }] });
});
