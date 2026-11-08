# 22. CO (Coded Ordinal) observation values are codes

No existing issue or PR. Independent of the other drafts. Nothing filed.

## Issue: @medplum/ccda: a CO observation value is read as a quantity and its code is lost

`processVitalsObservation` handles `xsi:type="CO"` with `PQ` ("Count of individuals"), so it reads `@value`/`@unit`. In CDA R2 data types, CO is a Coded Ordinal: a code whose values are ordered (a urine dipstick's Negative / Trace / 1+, a scale's Mild / Moderate / Severe). It carries `@code`/`@codeSystem`, not `@value`. The result is `"valueQuantity": { "system": "http://unitsofmeasure.org" }` with no value and no unit, and the code is gone.

Reproduction (synthetic):

```xml
<observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="LAB-CO"/>
  <code code="20454-5" codeSystem="2.16.840.1.113883.6.1" displayName="Protein [Presence] in Urine by Test strip"/>
  <statusCode code="completed"/>
  <effectiveTime value="20240210"/>
  <value xsi:type="CO" code="LA6577-6" codeSystem="2.16.840.1.113883.6.1" displayName="Negative"/>
</observation>
```

Expected (today: `"valueQuantity": { "system": "http://unitsofmeasure.org" }`):

```json
{ "valueCodeableConcept": { "coding": [{ "system": "http://loinc.org", "code": "LA6577-6", "display": "Negative" }], "text": "Negative" } }
```

## PR: fix(ccda): map CO observation values as codes

- `ccda-to-fhir.ts`: `case 'CO'` moves from the quantity branch to the `CD`/`CE` branch (`mapCode`).
- `types.ts`: `'CO'` moves from `CcdaQuantity['@_xsi:type']` to `CcdaCode['@_xsi:type']`.
- Test `observation-coded-ordinal.test.ts`: the dipstick value above gives that `valueCodeableConcept` and no `valueQuantity`; fails on `main`.
