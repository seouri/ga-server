# 18. Result interpretation codes → Observation.interpretation

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Independent of the other drafts. Nothing filed.

## Issue: @medplum/ccda: C-CDA to FHIR drops a result's interpretationCode (High, Low, Abnormal)

`processVitalsObservation` never reads `observation/interpretationCode`, so a lab result flagged High or Abnormal in the document reaches FHIR with no `interpretation`. The code system OID `2.16.840.1.113883.5.83` (HL7 v3 ObservationInterpretation) has no entry in `SYSTEM_MAPPER` either, so even where the code is carried it would read `urn:oid:2.16.840.1.113883.5.83` instead of the FHIR system URL.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Results</title>
  <entry>
    <observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5" extension="LAB-1"/>
      <code code="2345-7" codeSystem="2.16.840.1.113883.6.1" displayName="Glucose"/>
      <statusCode code="completed"/>
      <effectiveTime value="20240210"/>
      <value xsi:type="PQ" value="130" unit="mg/dL"/>
      <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83" displayName="High"/>
    </observation>
  </entry>
</section>
```

Expected FHIR (today: no `interpretation`):

```json
{
  "resourceType": "Observation",
  "code": { "coding": [{ "system": "http://loinc.org", "code": "2345-7", "display": "Glucose" }], "text": "Glucose" },
  "valueQuantity": { "value": 130, "unit": "mg/dL", "system": "http://unitsofmeasure.org", "code": "mg/dL" },
  "interpretation": [
    { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", "code": "H", "display": "High" }], "text": "High" }
  ]
}
```

## PR: fix(ccda): map result interpretation codes

- `types.ts`: `CcdaObservation.interpretationCode?: CcdaCode[]`; `xml.ts`: `observation.interpretationCode` is always an array (CDA allows several).
- `oids.ts`/`systems.ts`: `OID_OBSERVATION_INTERPRETATION_CODE_SYSTEM` (`2.16.840.1.113883.5.83`) ↔ `OBSERVATION_INTERPRETATION_CODE_SYSTEM` in `SYSTEM_MAPPER`, so both directions use the FHIR URL.
- `ccda-to-fhir.ts`: `mapInterpretation` maps each code with `mapCode`; a nullFlavor (no code, no text) maps to nothing, and no codes leave `interpretation` absent.
- Test `observation-interpretation.test.ts`: one High code (system, code, display); two codes kept in order; none, or a nullFlavor, gives none. Both fail on `main`.

FHIR to C-CDA is unchanged (it does not write interpretation today).

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 18 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): e8dd672 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed (the README has the approval process).
