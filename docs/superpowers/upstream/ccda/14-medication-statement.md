# 14. A Medication Activity in EVN mood becomes a MedicationStatement

No existing issue or PR. medplum#10847 (draft 12) is about planned medications in the Plan of Treatment section and explicitly leaves the Medications section alone. Builds on drafts 12 (`intent` parameter) and 13 (identifier). Nothing filed.

## Issue: @medplum/ccda: medications the patient takes (moodCode EVN) are converted to orders (MedicationRequest, intent order)

A Medication Activity (`2.16.840.1.113883.10.20.22.4.16`) has `moodCode="EVN"` when it records a medication the patient takes or took, and `moodCode="INT"` when it records an intended or ordered one. `processMedicationSubstanceAdministration` ignores the mood and always returns a `MedicationRequest` with `intent: "order"`. So a patient's medication list reads as a list of prescriptions. The start of the period the patient was taking it lands in `dispenseRequest.validityPeriod`, and the dosage in `dosageInstruction`.

C-CDA on FHIR's [`CF-MedActivityMood`](https://hl7.org/fhir/us/ccda/STU2/ConceptMap-CF-MedActivityMood.html) maps EVN to a MedicationStatement. Other converters do the same; the Microsoft FHIR-Converter, for example, makes MedicationStatement from the Medications section.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.1.1" extension="2014-06-09"/>
  <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Medications</title>
  <text><list><item><content ID="med1">Examplepril 10 mg tablet</content></item></list></text>
  <entry>
    <substanceAdministration classCode="SBADM" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.16" extension="2014-06-09"/>
      <id root="2.16.840.1.113883.19.5" extension="MED-1"/>
      <statusCode code="active"/>
      <effectiveTime xsi:type="IVL_TS"><low value="20230115"/></effectiveTime>
      <routeCode code="C38288" codeSystem="2.16.840.1.113883.3.26.1.1" displayName="Oral"/>
      <consumable>
        <manufacturedProduct classCode="MANU">
          <templateId root="2.16.840.1.113883.10.20.22.4.23"/>
          <manufacturedMaterial>
            <code code="314076" codeSystem="2.16.840.1.113883.6.88" displayName="lisinopril 10 MG Oral Tablet">
              <originalText><reference value="#med1"/></originalText>
            </code>
          </manufacturedMaterial>
        </manufacturedProduct>
      </consumable>
      <author><time value="20230110"/><assignedAuthor><id root="2.16.840.1.113883.4.6" extension="1234567890"/></assignedAuthor></author>
    </substanceAdministration>
  </entry>
</section>
```

Expected FHIR (today: a `MedicationRequest` with `intent: "order"`, `authoredOn`, `dispenseRequest.validityPeriod.start` and `dosageInstruction`):

```json
{
  "resourceType": "MedicationStatement",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "MED-1" }],
  "status": "active",
  "medicationCodeableConcept": {
    "coding": [{ "system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "314076", "display": "lisinopril 10 MG Oral Tablet" }],
    "text": "lisinopril 10 MG Oral Tablet",
    "extension": [{ "url": "https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference", "valueString": "#med1" }]
  },
  "subject": { "reference": "Patient/<id>" },
  "effectivePeriod": { "start": "2023-01-15" },
  "dateAsserted": "2023-01-10",
  "dosage": [{ "route": { "coding": [{ "system": "http://ncithesaurus-stage.nci.nih.gov", "code": "C38288", "display": "Oral" }], "text": "Oral" }, "timing": {} }]
}
```

The same entry with `moodCode="INT"` stays a MedicationRequest (`intent: "order"`), unchanged apart from draft 13's identifier.

## PR: fix(ccda): Medication Activities in EVN mood become MedicationStatement

- `processMedicationSubstanceAdministration`: the medication (inline code or contained Medication), dosage, identifier, text reference and subject are built once. Then:
  - **`moodCode="EVN"`** → `MedicationStatement`:
    - `status` from statusCode: active → active, completed → completed, aborted → stopped, suspended → on-hold, nullified → entered-in-error, any other → unknown. `MEDICATION_STATUS_MAPPER` gives MedicationRequest values such as `cancelled`, which a MedicationStatement does not allow, so it is not used here.
    - `effectivePeriod` from an IVL effectiveTime, or `effectiveDateTime` from a single value.
    - `dateAsserted` from the author time.
    - `dosage` is the dosage the request used to carry.
  - **Any other mood** → `MedicationRequest`, as before.
- Tests:
  - `medication-activity.test.ts`: EVN → statement, the status for every statusCode, and INT → request.
  - Tests that build an EVN Medication Activity and read the MedicationRequest now read the MedicationStatement: `medication-dose`, `nullflavor` (routeCode translation), `narrative-reference` and `section-template-order`. Their assertions are unchanged; `dosageInstruction` is read as `dosage`.
- **Breaking for consumers** that read medications only as MedicationRequest. The release notes should say so.
