# 14. A Medication Activity in the Medications section becomes a MedicationStatement

No existing issue or PR. medplum#10847 (draft 12) covers planned medications in the Plan of Treatment section and explicitly leaves the Medications section alone. Builds on drafts 12 (`intent` parameter) and 13 (identifier). Nothing filed. **This one may stay a GA patch:** upstream may prefer the C-CDA on FHIR mood → intent route (below). GA carries it either way, because its owner ruled that a medication list entry is what the patient takes.

## Issue: @medplum/ccda: the patient's medication list is converted to orders (MedicationRequest, intent order)

The Medications section (`2.16.840.1.113883.10.20.22.2.1`, `.1.1`) is the patient's medication list. Each entry is a Medication Activity (`2.16.840.1.113883.10.20.22.4.16`) in `moodCode="EVN"` or `"INT"`, and EHRs use both for the current regimen. medplum#10847's reporter notes that INT is how the current regimen is commonly expressed. `processMedicationSubstanceAdministration` always returns a `MedicationRequest` with `intent: "order"`, so the medication list reads as a list of prescriptions:

- the start of the period the patient takes it lands in `dispenseRequest.validityPeriod`
- the dosage lands in `dosageInstruction`

A MedicationStatement is FHIR's record of a medication a patient takes, has taken or intends to take. That is what a medication list entry is. The Microsoft FHIR-Converter also makes MedicationStatement from every Medications section entry, EVN or INT.

**The alternative.** C-CDA on FHIR's [`CF-MedActivityMood`](https://hl7.org/fhir/us/ccda/STU2/ConceptMap-CF-MedActivityMood.html) keeps MedicationRequest and maps mood loosely to `intent` (EVN → `plan`, INT → `order`). It notes that "CDA mood codes are more general than FHIR intent codes". A maintainer may prefer that.

Planned medications in the Plan of Treatment section are a different case. They stay MedicationRequest, with intent from mood (draft 12).

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

The same entry with `moodCode="INT"` gives the same MedicationStatement.

## PR: fix(ccda): Medications section entries become MedicationStatement

- `processMedicationSubstanceAdministration(substanceAdmin, intent)`: `intent` is undefined for a Medications section entry, or a planned medication's intent (draft 12). The medication (inline code or contained Medication), dosage, identifier, text reference and subject are built once. Then:
  - **Medications section** (intent undefined) → `MedicationStatement`, whatever the mood:
    - `status` from statusCode: active → active, completed → completed, aborted → stopped, suspended → on-hold, nullified → entered-in-error, any other → unknown. `MEDICATION_STATUS_MAPPER` gives MedicationRequest values such as `cancelled`, which a MedicationStatement does not allow, so it is not used here.
    - `effectivePeriod` from an IVL effectiveTime, or `effectiveDateTime` from a single value.
    - `dateAsserted` from the author time.
    - `dosage`: the dosage the request used to carry.
  - **Plan of Treatment** → `MedicationRequest` with its intent, as before.
- Tests:
  - `medication-activity.test.ts`: EVN → statement, INT → statement, the status for every statusCode.
  - Tests that build a Medications section entry and read the MedicationRequest now read the MedicationStatement: `medication-dose`, `nullflavor` (routeCode translation), `narrative-reference`, `section-template-order`, and draft 12's `keeps intent order for a Medication Activity in INT mood`. Their assertions are unchanged; `dosageInstruction` is read as `dosage`.
- **Breaking for consumers** that read the medication list only as MedicationRequest. The release notes should say so.
