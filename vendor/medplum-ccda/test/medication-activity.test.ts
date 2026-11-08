import type { MedicationRequest, MedicationStatement } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

// A Medication Activity (22.4.16) in the Medications section; the drug name is in the narrative, by reference.
const medications = (moodCode: string, inner = '') => `<component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.1.1" extension="2014-06-09"/>
  <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/><title>Medications</title>
  <text><list><item><content ID="med1">Examplepril 10 mg tablet</content></item></list></text>
  <entry><substanceAdministration classCode="SBADM" moodCode="${moodCode}">
    <templateId root="2.16.840.1.113883.10.20.22.4.16" extension="2014-06-09"/>
    <id root="2.16.840.1.113883.19.5" extension="MED-1"/>
    <statusCode code="active"/>
    <effectiveTime xsi:type="IVL_TS"><low value="20230115"/></effectiveTime>
    <consumable><manufacturedProduct classCode="MANU"><templateId root="2.16.840.1.113883.10.20.22.4.23"/>
      <manufacturedMaterial><code code="314076" codeSystem="2.16.840.1.113883.6.88" displayName="lisinopril 10 MG Oral Tablet">
        <originalText><reference value="#med1"/></originalText></code></manufacturedMaterial>
    </manufacturedProduct></consumable>
    <author><time value="20230110"/><assignedAuthor><id root="2.16.840.1.113883.4.6" extension="1234567890"/></assignedAuthor></author>
    ${inner}
  </substanceAdministration></entry>
</section></component>`;

test('a medication record keeps its substanceAdministration id as its identifier', () => {
  const [request] = resourcesOf<MedicationRequest>(convertSections(medications('INT')), 'MedicationRequest');
  expect(request.identifier).toEqual([{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'MED-1' }]);
});

test('a taking entry (moodCode EVN) is a MedicationStatement with its source id, period, dosage and status', () => {
  const bundle = convertSections(medications('EVN', '<routeCode code="C38288" codeSystem="2.16.840.1.113883.3.26.1.1" displayName="Oral"/>'));
  expect(resourcesOf<MedicationRequest>(bundle, 'MedicationRequest')).toHaveLength(0);
  const [statement] = resourcesOf<MedicationStatement>(bundle, 'MedicationStatement');
  expect(statement).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'MED-1' }],
    status: 'active',
    medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076' }] },
    effectivePeriod: { start: '2023-01-15' },
    dateAsserted: '2023-01-10',
    dosage: [{ route: { coding: [{ code: 'C38288' }] } }],
  });
  expect(statement.subject?.reference).toMatch(/^Patient\//);
});

test('a taking entry has a MedicationStatement status for every C-CDA statusCode', () => {
  const status = (code: string) =>
    resourcesOf<MedicationStatement>(convertSections(medications('EVN').replace('<statusCode code="active"/>', `<statusCode code="${code}"/>`)), 'MedicationStatement')[0].status;
  expect(['active', 'completed', 'aborted', 'suspended', 'nullified', 'cancelled', 'obsolete', 'new'].map(status)).toEqual([
    'active', 'completed', 'stopped', 'on-hold', 'entered-in-error', 'unknown', 'unknown', 'unknown',
  ]);
});

test('an order (moodCode INT) is a MedicationRequest', () => {
  const bundle = convertSections(medications('INT'));
  expect(resourcesOf<MedicationStatement>(bundle, 'MedicationStatement')).toHaveLength(0);
  expect(resourcesOf<MedicationRequest>(bundle, 'MedicationRequest')[0]).toMatchObject({ status: 'active', intent: 'order', authoredOn: '2023-01-10' });
});
