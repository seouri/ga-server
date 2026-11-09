# 15. A medication's supply orders and dispenses become MedicationRequest and MedicationDispense

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR (searched `ccda`, `ccda medication`, `supply`). Builds on drafts 13 (identifiers) and 14 (`processMedicationSubstanceAdministration` returns the statement or request). Nothing filed.

## Issue: @medplum/ccda: Medication Supply Order and Medication Dispense inside a Medication Activity are dropped

A Medication Activity (`2.16.840.1.113883.10.20.22.4.16`) can carry the prescription that goes with it and the fills against it, as `entryRelationship/supply`:

- **Medication Supply Order** (`22.4.17`, `moodCode="INT"`): quantity, number of fills (`repeatNumber`), validity period, prescriber (author).
- **Medication Dispense** (`22.4.18`, `moodCode="EVN"`): what was handed over, how much, when.

`processMedicationSubstanceAdministration` reads only the free-text sig from `entryRelationship`, so both are dropped. Epic documents carry a supply order on most prescribed medications. The Microsoft FHIR-Converter makes a MedicationRequest (intent `order`) from each.

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
      <entryRelationship typeCode="REFR">
        <supply classCode="SPLY" moodCode="INT">
          <templateId root="2.16.840.1.113883.10.20.22.4.17" extension="2014-06-09"/>
          <id root="2.16.840.1.113883.19.5" extension="ORDER-1"/>
          <statusCode code="completed"/>
          <effectiveTime xsi:type="IVL_TS"><low value="20230110"/><high value="20240110"/></effectiveTime>
          <repeatNumber value="4"/>
          <quantity value="90" unit="{tbl}"/>
          <author>
            <time value="20230110"/>
            <assignedAuthor>
              <id root="2.16.840.1.113883.4.6" extension="1234567890"/>
              <assignedPerson><name><given>Example</given><family>Prescriber</family></name></assignedPerson>
            </assignedAuthor>
          </author>
        </supply>
      </entryRelationship>
    </substanceAdministration>
  </entry>
</section>
```

Expected FHIR, in addition to the MedicationStatement (today: the statement only):

```json
{
  "resourceType": "MedicationRequest",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "ORDER-1" }],
  "status": "completed",
  "intent": "order",
  "medicationCodeableConcept": {
    "coding": [{ "system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "314076", "display": "lisinopril 10 MG Oral Tablet" }],
    "text": "lisinopril 10 MG Oral Tablet",
    "extension": [{ "url": "https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference", "valueString": "#med1" }]
  },
  "subject": { "reference": "Patient/<id>" },
  "authoredOn": "2023-01-10",
  "requester": { "reference": "Practitioner/<the prescriber>" },
  "dispenseRequest": {
    "validityPeriod": { "start": "2023-01-10", "end": "2024-01-10" },
    "numberOfRepeatsAllowed": 3,
    "quantity": { "value": 90, "unit": "{tbl}", "system": "http://unitsofmeasure.org", "code": "{tbl}" }
  }
}
```

The same supply with `moodCode="EVN"` (`22.4.18`):

```json
{
  "resourceType": "MedicationDispense",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "ORDER-1" }],
  "status": "completed",
  "medicationCodeableConcept": { "...": "as above" },
  "subject": { "reference": "Patient/<id>" },
  "quantity": { "value": 90, "unit": "{tbl}", "system": "http://unitsofmeasure.org", "code": "{tbl}" },
  "whenHandedOver": "2023-01-10",
  "performer": [{
    "function": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/medicationdispense-performer-function", "code": "dataenterer" }] },
    "actor": { "reference": "Practitioner/<the author>" }
  }]
}
```

## PR: feat(ccda): convert a medication's supply orders and dispenses

- **`processMedicationSupplies`** reads every `entryRelationship/supply` of a Medication Activity, whatever its typeCode.
  - **Medication.** The supply's own `product`, else the activity's drug.
  - **`moodCode="EVN"` → `MedicationDispense`:**
    - status: active → in-progress, completed → completed, aborted → stopped, cancelled → cancelled, suspended → on-hold, nullified → entered-in-error, any other → unknown.
    - `quantity`.
    - `whenHandedOver` from effectiveTime.
    - `performer`: the author as a performer with `function` `http://terminology.hl7.org/CodeSystem/medicationdispense-performer-function|dataenterer`, the person who entered the dispense data. R4 MedicationDispense has no recorder, and the author is neither the requester nor the dispenser. Each C-CDA `performer` (the dispensing party) is a performer of its own, with no function.
  - **Any other mood → `MedicationRequest`:**
    - intent `order`; inside a Plan of Treatment medication, that medication's intent (draft 12), so a planned prescription is not read as an authorized order.
    - status via `MEDICATION_STATUS_MAPPER`.
    - `authoredOn` and `requester` from the author.
    - `dispenseRequest`: `validityPeriod`, `quantity`, and `numberOfRepeatsAllowed` = `repeatNumber` − 1. C-CDA counts every allowed fill; FHIR counts the refills after the first.
- **Return values.** `processMedicationSubstanceAdministration` returns `[statement or request, ...supplies]`. `processSubstanceAdministration` may return an array, as `processAct` already can, and `processEntry` spreads it. The supplies are listed in the section's Composition entries.
- **Parsing.** `types.ts` gains `CcdaSupply` and `CcdaEntryRelationship.supply`. `xml.ts` parses `entryRelationship.supply`, `product.manufacturedProduct` and `supply.performer` as arrays.
- **Not converted.** A supply order's `instructions`, left for a follow-up.
- **Test.** `medication-activity.test.ts`: a supply order; a dispense with its own product; a dispense's author (dataenterer) and performer (dispenser).

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 15 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 1677fd3, 4512d3a, 1e31c57 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 12, 13, 14
- Status: issue-first. Nothing filed (the README has the approval process).
