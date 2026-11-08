# 25. An observation with a value but no code is kept

No existing issue or PR. Independent of the other drafts. Nothing filed.

## Issue: @medplum/ccda: an observation whose code is a nullFlavor is dropped even when it has a value

`processVitalsObservation` returns nothing when `mapCode(observation.code)` is empty ("Skip observations without a valid code (e.g., nullFlavor=\"NA\")"). That is right for an empty placeholder, but an observation can carry a real value with an uncoded name, for example a Social History entry `<code nullFlavor="UNK"/>` with `<value xsi:type="ST">Lives alone</value>`. The value is lost.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.17" extension="2015-08-01"/>
  <code code="29762-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Social History</title>
  <entry>
    <observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.38"/>
      <id root="2.16.840.1.113883.19.5" extension="S-1"/>
      <code nullFlavor="UNK"/>
      <statusCode code="completed"/>
      <effectiveTime value="20240210"/>
      <value xsi:type="ST">Lives alone</value>
    </observation>
  </entry>
</section>
```

Expected (today: no Observation):

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "S-1" }],
  "code": { "extension": [{ "url": "http://hl7.org/fhir/StructureDefinition/data-absent-reason", "valueCode": "unknown" }] },
  "effectiveDateTime": "2024-02-10",
  "valueString": "Lives alone"
}
```

## PR: fix(ccda): keep an uncoded observation that has a value

- `processVitalsObservation`: when the code maps to nothing but the value has content (`@value`, `@code`, `@displayName`, text, a reference or originalText), the code is a data-absent-reason `unknown`, as the Coverage payor and FamilyMemberHistory relationship already do for required elements. An observation with neither code nor value is still skipped.
- Test `observation-without-code.test.ts`: the entry above is kept with that code; an observation with a nullFlavor code and no value, or a nullFlavor value, is skipped.
