// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedicationRequest, MedicationStatement } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { convertCcdaToFhir } from '../ccda-to-fhir.ts';
import { convertXmlToCcda } from '../xml.ts';

const PLAN_OF_TREATMENT_SECTION = `
  <templateId root="2.16.840.1.113883.10.20.22.2.10" extension="2014-06-09"/>
  <code code="18776-5" codeSystem="2.16.840.1.113883.6.1"/>`;

const MEDICATIONS_SECTION = `
  <templateId root="2.16.840.1.113883.10.20.22.2.1.1" extension="2014-06-09"/>
  <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>`;

function medicationRequestFromXml(sectionHeader: string, substanceAdministration: string): MedicationRequest {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget>
    <patientRole>
      <patient>
        <name use="L"><given>Test</given><family>Patient</family></name>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          ${sectionHeader}
          <entry>${substanceAdministration}</entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;
  const bundle = convertCcdaToFhir(convertXmlToCcda(xml));
  const medicationRequest = bundle.entry?.find((e) => e.resource?.resourceType === 'MedicationRequest')
    ?.resource as MedicationRequest;
  expect(medicationRequest).toBeDefined();
  return medicationRequest;
}

function substanceAdministrationXml(moodCode: string, templateId: string, effectiveTime: string): string {
  return `
    <substanceAdministration classCode="SBADM" moodCode="${moodCode}">
      <templateId root="${templateId}" extension="2014-06-09"/>
      <id root="00000000-0000-4000-8000-0000000000b1"/>
      <statusCode code="active"/>
      ${effectiveTime}
      <consumable>
        <manufacturedProduct classCode="MANU">
          <manufacturedMaterial>
            <code code="197806" displayName="Ibuprofen 600 MG Oral Tablet" codeSystem="2.16.840.1.113883.6.88"/>
          </manufacturedMaterial>
        </manufacturedProduct>
      </consumable>
    </substanceAdministration>`;
}

const PLANNED_MEDICATION_ACTIVITY = '2.16.840.1.113883.10.20.22.4.42';
const PLANNED_IMMUNIZATION_ACTIVITY = '2.16.840.1.113883.10.20.22.4.120';
const MEDICATION_ACTIVITY = '2.16.840.1.113883.10.20.22.4.16';

describe('planned medications in the Plan of Treatment section', () => {
  test.each([
    ['PRP', 'proposal'],
    ['INT', 'plan'],
    ['PRMS', 'plan'],
    ['RQO', 'order'],
  ])('maps moodCode %s to intent %s', (moodCode, intent) => {
    const medicationRequest = medicationRequestFromXml(
      PLAN_OF_TREATMENT_SECTION,
      substanceAdministrationXml(moodCode, PLANNED_MEDICATION_ACTIVITY, '<effectiveTime value="20250201"/>')
    );
    expect(medicationRequest.intent).toBe(intent);
  });

  test('maps the moodCode of a Planned Immunization Activity', () => {
    const medicationRequest = medicationRequestFromXml(
      PLAN_OF_TREATMENT_SECTION,
      substanceAdministrationXml('PRP', PLANNED_IMMUNIZATION_ACTIVITY, '<effectiveTime value="20250201"/>')
    );
    expect(medicationRequest.intent).toBe('proposal');
  });

  test('keeps the planned time from a single effectiveTime value', () => {
    const medicationRequest = medicationRequestFromXml(
      PLAN_OF_TREATMENT_SECTION,
      substanceAdministrationXml('INT', PLANNED_MEDICATION_ACTIVITY, '<effectiveTime value="20250201"/>')
    );
    expect(medicationRequest.dispenseRequest?.validityPeriod).toEqual({ start: '2025-02-01' });
  });
});

// GA: a Medication Activity in the Medications section is a MedicationStatement whatever its mood (PATCHES row 14), so the fork's
// "keeps intent order for a Medication Activity in INT mood" case now reads the statement.
describe('medications in the Medications section', () => {
  test('a Medication Activity in INT mood is a MedicationStatement with its period', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient><name use="L"><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>${MEDICATIONS_SECTION}<entry>${substanceAdministrationXml(
    'INT',
    MEDICATION_ACTIVITY,
    '<effectiveTime xsi:type="IVL_TS" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><low value="20250101"/><high value="20250301"/></effectiveTime>'
  )}</entry></section></component></structuredBody></component>
</ClinicalDocument>`;
    const types = convertCcdaToFhir(convertXmlToCcda(xml)).entry?.map((e) => e.resource);
    const statement = types?.find((r) => r?.resourceType === 'MedicationStatement') as MedicationStatement | undefined;
    expect(types?.some((r) => r?.resourceType === 'MedicationRequest')).toBe(false);
    expect(statement?.effectivePeriod).toEqual({ start: '2025-01-01', end: '2025-03-01' });
  });
});
