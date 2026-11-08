# 23. Planned observations in Plan of Treatment → ServiceRequest, not Goal

No existing issue or PR. Builds on draft 6 (Reason for Referral → ServiceRequest: the status and intent maps are shared) and medplum#11244 (draft 17: the time helper). Nothing filed.

## Issue: @medplum/ccda: a planned test in Plan of Treatment becomes a Goal ("Unknown goal")

`processObservation` sends every observation in the Plan of Treatment section to `processGoalObservation`. A Planned Observation (`2.16.840.1.113883.10.20.22.4.44`, moodCode `RQO`, `INT`, `PRP` or `ARQ`) is a test or measurement someone intends or requests, not a goal: it has a code (what will be done) and usually no value. The result is a `Goal` with `description: { text: "Unknown goal" }`, the test code as its category, and the planned date as `startDate`. A planned lab panel reads as a patient goal.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.10" extension="2014-06-09"/>
  <code code="18776-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Plan of Treatment</title>
  <text><paragraph ID="p1">Fasting labs before the visit.</paragraph></text>
  <entry>
    <observation classCode="OBS" moodCode="RQO">
      <templateId root="2.16.840.1.113883.10.20.22.4.44" extension="2014-06-09"/>
      <id root="2.16.840.1.113883.19.5" extension="PLANOBS-1"/>
      <code code="24323-8" codeSystem="2.16.840.1.113883.6.1" displayName="Comprehensive metabolic panel"/>
      <text><reference value="#p1"/></text>
      <statusCode code="active"/>
      <effectiveTime value="20240510"/>
    </observation>
  </entry>
</section>
```

Expected FHIR (today: a Goal "Unknown goal"):

```json
{
  "resourceType": "ServiceRequest",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "PLANOBS-1" }],
  "status": "active",
  "intent": "order",
  "code": { "coding": [{ "system": "http://loinc.org", "code": "24323-8", "display": "Comprehensive metabolic panel" }], "text": "Comprehensive metabolic panel" },
  "subject": { "reference": "Patient/<the patient>" },
  "occurrenceDateTime": "2024-05-10",
  "note": [{ "text": "Fasting labs before the visit." }],
  "extension": [{ "url": "https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference", "valueString": "#p1" }]
}
```

## PR: fix(ccda): map planned observations to ServiceRequest

- `processObservation`: in the Plan of Treatment section, an observation without a goal template whose moodCode is `INT`, `PRP`, `RQO` or `ARQ` goes to the new `processPlannedObservation`. Goal templates, `GOL` observations and the Goals section stay Goals.
- `processPlannedObservation`: id and identifier; status from statusCode and intent from moodCode (INT → plan, PRP → proposal, RQO/ARQ → order), the maps the Reason for Referral builder already uses, moved to module constants; code; subject; `occurrenceDateTime` or `occurrencePeriod` from the effectiveTime (`mapObservationEffectiveTime`); authoredOn and requester from the first author; the observation's text, or the narrative it references, as a note.
- Tests (`planned-observation.test.ts`): an RQO Planned Observation gives that ServiceRequest and no Goal; INT, PRP and ARQ give plan, proposal and order; a GOL observation in the same section stays a Goal.

Not mapped: a value on a planned observation (unusual) and its child observations; GA names these in its own accounting.
