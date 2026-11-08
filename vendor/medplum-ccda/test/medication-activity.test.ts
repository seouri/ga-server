import type { Composition, MedicationDispense, MedicationRequest, MedicationStatement, Practitioner } from '@medplum/fhirtypes';
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
  const [statement] = resourcesOf<MedicationStatement>(convertSections(medications('INT')), 'MedicationStatement');
  expect(statement.identifier).toEqual([{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'MED-1' }]);
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

test('a medication list entry in INT mood is a MedicationStatement too (the list says what the patient takes)', () => {
  const bundle = convertSections(medications('INT'));
  expect(resourcesOf<MedicationRequest>(bundle, 'MedicationRequest')).toHaveLength(0);
  expect(resourcesOf<MedicationStatement>(bundle, 'MedicationStatement')[0]).toMatchObject({
    identifier: [{ value: 'MED-1' }], status: 'active', effectivePeriod: { start: '2023-01-15' }, dateAsserted: '2023-01-10',
  });
});

// Medication Supply Order (22.4.17, INT) and Medication Dispense (22.4.18, EVN) inside a Medication Activity.
const supply = (moodCode: string, template: string, id: string, product = '') => `<entryRelationship typeCode="REFR">
  <supply classCode="SPLY" moodCode="${moodCode}"><templateId root="${template}" extension="2014-06-09"/>
    <id root="2.16.840.1.113883.19.5" extension="${id}"/><statusCode code="completed"/>
    <effectiveTime xsi:type="IVL_TS"><low value="20230110"/><high value="20240110"/></effectiveTime>
    <repeatNumber value="4"/><quantity value="90" unit="{tbl}"/>${product}
    <author><time value="20230110"/><assignedAuthor><id root="2.16.840.1.113883.4.6" extension="1234567890"/>
      <assignedPerson><name><given>Example</given><family>Prescriber</family></name></assignedPerson></assignedAuthor></author>
  </supply></entryRelationship>`;

test('a supply order of a medication is a MedicationRequest with its own id, prescriber, quantity and refills', () => {
  const bundle = convertSections(medications('EVN', supply('INT', '2.16.840.1.113883.10.20.22.4.17', 'ORDER-1')));
  expect(resourcesOf<MedicationStatement>(bundle, 'MedicationStatement')).toHaveLength(1);
  const [order] = resourcesOf<MedicationRequest>(bundle, 'MedicationRequest');
  expect(order).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'ORDER-1' }],
    status: 'completed',
    intent: 'order',
    authoredOn: '2023-01-10',
    // No product of its own: the medication it belongs to.
    medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076' }] },
    dispenseRequest: { validityPeriod: { start: '2023-01-10', end: '2024-01-10' }, numberOfRepeatsAllowed: 3, quantity: { value: 90, unit: '{tbl}' } },
  });
  const prescriber = resourcesOf<Practitioner>(bundle, 'Practitioner').find((p) => `Practitioner/${p.id}` === order.requester?.reference);
  expect(prescriber?.name?.[0].family).toBe('Prescriber');
  // Listed in its section like the medication itself.
  const comp = resourcesOf<Composition>(bundle, 'Composition')[0];
  expect(comp.section?.[0].entry?.map((e) => e.reference?.split('/')[0])).toEqual(['MedicationStatement', 'MedicationRequest']);
});

test('a dispense of a medication is a MedicationDispense; a supply with its own product names that product', () => {
  const product = `<product><manufacturedProduct classCode="MANU"><manufacturedMaterial>
    <code code="197361" codeSystem="2.16.840.1.113883.6.88" displayName="amlodipine 5 MG Oral Tablet"/></manufacturedMaterial></manufacturedProduct></product>`;
  const bundle = convertSections(medications('INT', supply('EVN', '2.16.840.1.113883.10.20.22.4.18', 'FILL-1', product)));
  const [dispense] = resourcesOf<MedicationDispense>(bundle, 'MedicationDispense');
  expect(dispense).toMatchObject({
    identifier: [{ system: 'urn:oid:2.16.840.1.113883.19.5', value: 'FILL-1' }],
    status: 'completed',
    medicationCodeableConcept: { coding: [{ code: '197361' }] },
    quantity: { value: 90, unit: '{tbl}' },
    whenHandedOver: '2023-01-10',
  });
  expect(dispense.subject?.reference).toMatch(/^Patient\//);
  expect(resourcesOf<MedicationStatement>(bundle, 'MedicationStatement')).toHaveLength(1); // the INT medication itself
});

test('a supply order inside a planned medication carries the plan\'s intent, not order', () => {
  const plan = medications('INT', supply('INT', '2.16.840.1.113883.10.20.22.4.17', 'ORDER-2'))
    .replace('<templateId root="2.16.840.1.113883.10.20.22.2.1.1" extension="2014-06-09"/>', '<templateId root="2.16.840.1.113883.10.20.22.2.10" extension="2014-06-09"/>')
    .replace('<templateId root="2.16.840.1.113883.10.20.22.4.16" extension="2014-06-09"/>', '<templateId root="2.16.840.1.113883.10.20.22.4.42" extension="2014-06-09"/>');
  const requests = resourcesOf<MedicationRequest>(convertSections(plan), 'MedicationRequest');
  expect(requests.map((r) => [r.identifier?.[0].value, r.intent])).toEqual([['MED-1', 'plan'], ['ORDER-2', 'plan']]);
});

test('a dispense keeps who entered it (author, function dataenterer) and who dispensed it (performer)', () => {
  const pharmacy = `<performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.19.5" extension="PHARM-1"/>
    <representedOrganization><name>Example Pharmacy</name></representedOrganization></assignedEntity></performer>`;
  const fill = supply('EVN', '2.16.840.1.113883.10.20.22.4.18', 'FILL-2').replace('<author>', `${pharmacy}<author>`);
  const bundle = convertSections(medications('EVN', fill));
  const [dispense] = resourcesOf<MedicationDispense>(bundle, 'MedicationDispense');
  const [enterer, dispenser] = dispense.performer ?? [];
  expect(enterer.function?.coding).toEqual([{ system: 'http://terminology.hl7.org/CodeSystem/medicationdispense-performer-function', code: 'dataenterer' }]);
  const author = resourcesOf<Practitioner>(bundle, 'Practitioner').find((p) => `Practitioner/${p.id}` === enterer.actor.reference);
  expect(author?.name?.[0].family).toBe('Prescriber');
  expect(dispenser.function).toBeUndefined();
  expect(dispenser.actor.reference).toMatch(/^PractitionerRole\//);
  expect(dispense.performer).toHaveLength(2);
});
