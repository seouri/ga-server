# 37. A nullFlavor observation value is data-absent

No existing issue or PR. Builds on draft 26 (TS/BL) and sits next to medplum#11241 (REAL). Nothing filed.

## Issue: @medplum/ccda: a nullFlavor observation value becomes an empty value

`sanitizeNullFlavors` strips `@nullFlavor`, so `<value xsi:type="PQ" nullFlavor="UNK"/>` reaches `processVitalsObservation` as `{ "@_xsi:type": "PQ" }`. The PQ case then writes `valueQuantity: { system: "http://unitsofmeasure.org" }` (a quantity with no number), the ST case `valueString: ""` (invalid: FHIR strings may not be empty), and the others no value. FHIR's rule for a missing value is `Observation.dataAbsentReason`. A PQ whose `@value` does not parse writes `value: NaN` (serialized as `null`).

Reproduction (synthetic), a result observation with:

```xml
<value xsi:type="PQ" nullFlavor="UNK"/>
```

Expected: no `valueQuantity`, `"dataAbsentReason": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/data-absent-reason", "code": "unknown" }] }`; the same for CD, CE, CO, ST, INT, REAL, ED, TS, BL. `<value xsi:type="PQ" value="abc" unit="mg/dL"/>`: no value. Actual: `valueQuantity: { system: UCUM }` (and `{ value: NaN, unit, system, code }`).

## PR: fix(ccda): a value with no content is data-absent

- `ccda-to-fhir.ts`: before the type switch, a typed value with none of the content keys (`OBSERVATION_VALUE_CONTENT`, exported) gets `dataAbsentReason` `unknown`; PQ and INT write a number only when it parses.
- The nullFlavor code (UNK, ASKU, NAV, MSK, ...) could map to the matching data-absent-reason code if `sanitizeNullFlavors` kept it on values; out of scope here.
- Test `observation-ts-bl.test.ts`.
