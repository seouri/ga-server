# 13. Medication records keep the substanceAdministration id

No existing issue or PR. Builds on draft 12 (the fork fix for medplum#10847; only its `intent` parameter, not its behaviour). Nothing filed.

## Issue: @medplum/ccda: MedicationRequest has no identifier (the substanceAdministration id is dropped)

`processMedicationSubstanceAdministration` uses `substanceAdministration/id` only to pick the resource `id`, and only when the id is a bare UUID root. A Medication Activity's id is usually an OID root with an extension, for example Epic's `<id root="1.2.840.114350..." extension="..."/>`. In that case the resource gets a random id and no `identifier`. Every other clinical statement the library converts keeps its ids as `identifier` (Condition, AllergyIntolerance, Observation, Encounter, Procedure, Immunization). A consumer that imports a newer document of the same patient cannot tell that its medication is the one it already holds.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.1.1" extension="2014-06-09"/>
  <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Medications</title>
  <text><list><item><content ID="med1">Examplepril 10 mg tablet</content></item></list></text>
  <entry>
    <substanceAdministration classCode="SBADM" moodCode="INT">
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
    </substanceAdministration>
  </entry>
</section>
```

Expected FHIR (today: the same, without `identifier`):

```json
{
  "resourceType": "MedicationRequest",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "MED-1" }],
  "status": "active",
  "intent": "order",
  "medicationCodeableConcept": { "coding": [{ "system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "314076", "display": "lisinopril 10 MG Oral Tablet" }], "text": "lisinopril 10 MG Oral Tablet" }
}
```

## PR: fix(ccda): keep the substanceAdministration id on medication resources

- `processMedicationSubstanceAdministration`: `identifier: this.mapIdentifiers(substanceAdmin.id)`, the same helper the other statements use. A bare UUID root still becomes the resource `id` and is not repeated as an identifier.
- Test: `medication-activity.test.ts` (`a medication record keeps its substanceAdministration id as its identifier`).
