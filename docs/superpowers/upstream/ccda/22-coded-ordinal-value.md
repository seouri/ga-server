# 22. CO (Coded Ordinal) observation values are codes

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Independent of the other drafts. Nothing filed.

## Issue: @medplum/ccda: a CO observation value is read as a quantity and its code is lost

`processVitalsObservation` handles `xsi:type="CO"` with `PQ` ("Count of individuals"), so it reads `@value`/`@unit`. In CDA R2 data types, CO is a Coded Ordinal: a code whose values are ordered (a urine dipstick's Negative / Trace / 1+, a scale's Mild / Moderate / Severe). It carries `@code`/`@codeSystem`, not `@value`. The result is `"valueQuantity": { "system": "http://unitsofmeasure.org" }` with no value and no unit, and the code is gone.

Reproduction (synthetic):

```xml
<observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="LAB-CO"/>
  <code code="5778-6" codeSystem="2.16.840.1.113883.6.1" displayName="Color of Urine"/>
  <statusCode code="completed"/>
  <effectiveTime value="20240210"/>
  <value xsi:type="CO" code="LA6576-8" codeSystem="2.16.840.1.113883.6.1" displayName="Positive"/>
</observation>
```

Expected (today: `"valueQuantity": { "system": "http://unitsofmeasure.org" }`):

```json
{ "valueCodeableConcept": { "coding": [{ "system": "http://loinc.org", "code": "LA6576-8", "display": "Positive" }], "text": "Positive" } }
```

## PR: fix(ccda): map CO observation values as codes

- `ccda-to-fhir.ts`: `case 'CO'` moves from the quantity branch to the `CD`/`CE` branch (`mapCode`).
- `types.ts`: `'CO'` moves from `CcdaQuantity['@_xsi:type']` to `CcdaCode['@_xsi:type']`.
- Test `observation-coded-ordinal.test.ts`: the dipstick value above gives that `valueCodeableConcept` and no `valueQuantity`; fails on `main`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 22 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 57c35ad (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed (the README has the approval process).
