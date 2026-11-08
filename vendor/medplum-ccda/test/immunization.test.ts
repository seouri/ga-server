import type { Immunization } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const immunization = (inner = '') => resourcesOf<Immunization>(convertSections(`<component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.2.1" extension="2015-08-01"/>
  <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/><title>Immunizations</title>
  <entry><substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="false">
    <templateId root="2.16.840.1.113883.10.20.22.4.52" extension="2015-08-01"/>
    <id root="2.16.840.1.113883.19.5" extension="IMM-1"/>
    <statusCode code="completed"/><effectiveTime value="20231015"/>${inner}
    <consumable><manufacturedProduct classCode="MANU"><templateId root="2.16.840.1.113883.10.20.22.4.54"/>
      <manufacturedMaterial><code code="140" codeSystem="2.16.840.1.113883.12.292" displayName="Influenza, seasonal, injectable, preservative free"/></manufacturedMaterial>
    </manufacturedProduct></consumable>
  </substanceAdministration></entry></section></component>`), 'Immunization')[0];

test('a CVX vaccine code is in the FHIR CVX system http://hl7.org/fhir/sid/cvx', () => {
  expect(immunization().vaccineCode.coding?.[0]).toMatchObject({ system: 'http://hl7.org/fhir/sid/cvx', code: '140' });
});

test('an immunization keeps its route', () => {
  const route = '<routeCode code="C28161" codeSystem="2.16.840.1.113883.3.26.1.1" displayName="Intramuscular"/>';
  expect(immunization(route).route?.coding?.[0]).toMatchObject({ code: 'C28161', display: 'Intramuscular' });
  expect(immunization().route).toBeUndefined();
});
