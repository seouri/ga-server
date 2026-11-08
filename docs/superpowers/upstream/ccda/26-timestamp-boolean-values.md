# 26. TS and BL observation values

No existing issue or PR. Independent of the other drafts (sits next to medplum#11241's REAL case). Nothing filed.

## Issue: @medplum/ccda: TS and BL observation values are dropped

`processVitalsObservation` has no case for `xsi:type="TS"` (a point in time, such as a last menstrual period date) or `xsi:type="BL"` (a yes/no answer). Both fall to `console.warn('Unhandled observation value type: ...')` and the Observation gets no value, although FHIR R4 has `valueDateTime` and `valueBoolean`.

Reproduction (synthetic):

```xml
<observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="LAB-1"/>
  <code code="8665-2" codeSystem="2.16.840.1.113883.6.1" displayName="Last menstrual period start date"/>
  <statusCode code="completed"/>
  <effectiveTime value="20240210"/>
  <value xsi:type="TS" value="20240101"/>
</observation>
```

Expected: `"valueDateTime": "2024-01-01"`; with `<value xsi:type="BL" value="true"/>`, `"valueBoolean": true`.

## PR: fix(ccda): map TS and BL observation values

- `ccda-to-fhir.ts`: `case 'TS'` → `valueDateTime` through `mapCcdaToFhirDateTime`; `case 'BL'` → `valueBoolean` for `true`/`false` only. A nullFlavor gives no value and no warning.
- `types.ts`: `CcdaTimestampOrBoolean` (`'@_xsi:type': 'TS' | 'BL'`) joins `CcdaValue`.
- Test `observation-ts-bl.test.ts`: TS, BL true and BL false give those values without a warning; nullFlavor gives none.
