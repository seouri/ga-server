import type { MedicationRequest } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

// A Medication Activity (22.4.16) in the Medications section; the drug name is in the narrative, by reference.
export const medications = (moodCode: string, inner = '') => `<component><section>
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
