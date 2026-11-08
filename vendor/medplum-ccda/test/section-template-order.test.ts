import type { Condition, MedicationStatement } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const medication = `<entry typeCode="DRIV"><substanceAdministration classCode="SBADM" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.16" extension="2014-06-09"/>
  <id root="2.16.840.1.113883.19.5" extension="MED-1"/><statusCode code="active"/>
  <consumable><manufacturedProduct classCode="MANU"><templateId root="2.16.840.1.113883.10.20.22.4.23" extension="2014-06-09"/>
    <manufacturedMaterial><code code="310793" codeSystem="2.16.840.1.113883.6.88" displayName="Examplamide 10 MG Oral Tablet"/></manufacturedMaterial>
  </manufacturedProduct></consumable></substanceAdministration></entry>`;
const medications = (templates: string[]) =>
  `<component><section>${templates.map((t) => `<templateId root="${t}"/>`).join('')}<code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/><title>Medications</title><text>x</text>${medication}</section></component>`;

test('a section is routed by any of its templateIds: Medications with the entries-optional root first (Epic)', () => {
  const bundle = convertSections(medications(['2.16.840.1.113883.10.20.22.2.1', '2.16.840.1.113883.10.20.22.2.1.1']));
  expect(resourcesOf<MedicationStatement>(bundle, 'MedicationStatement')).toHaveLength(1);
});

test('an entries-optional-only Medications section converts its medications', () => {
  expect(resourcesOf<MedicationStatement>(convertSections(medications(['2.16.840.1.113883.10.20.22.2.1'])), 'MedicationStatement')).toHaveLength(1);
});

test('a Problems section whose routed template is not first, and the V2 entries-required root', () => {
  const problem = `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><id root="2.16.840.1.113883.19.5" extension="CONCERN-1"/>
    <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <id root="2.16.840.1.113883.19.5" extension="PROB-1"/><code code="55607006" codeSystem="2.16.840.1.113883.6.96"/><statusCode code="completed"/>
      <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96" displayName="Hypertension"/></observation></entryRelationship></act></entry>`;
  for (const templates of [['2.16.840.1.113883.10.20.22.2.99', '2.16.840.1.113883.10.20.22.2.5.1'], ['2.16.840.1.113883.10.20.22.2.5.1.2']]) {
    const bundle = convertSections(`<component><section>${templates.map((t) => `<templateId root="${t}"/>`).join('')}<title>Problems</title><text>x</text>${problem}</section></component>`);
    expect(resourcesOf<Condition>(bundle, 'Condition').map((c) => c.code?.text)).toEqual(['Hypertension']);
  }
});

test('a section without a templateId does not throw with ignoreUnsupportedSections', () => {
  const bundle = convertSections(`<component><section><title>Medications</title><text>x</text>${medication}</section></component>`, { ignoreUnsupportedSections: true });
  expect(resourcesOf(bundle, 'Composition')).toHaveLength(1);
});
