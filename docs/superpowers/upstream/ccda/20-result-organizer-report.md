# 20. Result Organizer → DiagnosticReport

No existing issue or PR. Builds on medplum#11243 (draft 19: organizers routed by their own templateIds) and medplum#11244 (draft 17: `mapObservationEffectiveTime`). Nothing filed.

## Issue: @medplum/ccda: a Result Organizer (lab panel) becomes a value-less Observation instead of a DiagnosticReport

`processVitalsOrganizer` turns every organizer into an Observation with `hasMember`. For a Result Organizer (`2.16.840.1.113883.10.20.22.4.1`, V2 `.4.1.2`) that is a lab panel: an Observation with a panel code, no value and the results as members. FHIR models a panel of results as a `DiagnosticReport` with `result` references (the C-CDA on FHIR IG maps Result Organizer → DiagnosticReport; US Core's lab DiagnosticReport has category `LAB`). Applications that list Observations as results show the panel as an empty result row, and nothing produces a DiagnosticReport.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Results</title>
  <entry>
    <organizer classCode="BATTERY" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.1" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5" extension="PANEL-1"/>
      <code code="24323-8" codeSystem="2.16.840.1.113883.6.1" displayName="Comprehensive metabolic panel"/>
      <statusCode code="completed"/>
      <effectiveTime><low value="20240210091000-0500"/><high value="20240210091000-0500"/></effectiveTime>
      <component>
        <observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
          <id root="2.16.840.1.113883.19.5" extension="RES-1"/>
          <code code="2345-7" codeSystem="2.16.840.1.113883.6.1" displayName="Glucose"/>
          <statusCode code="completed"/>
          <effectiveTime value="20240210091000-0500"/>
          <value xsi:type="PQ" value="95" unit="mg/dL"/>
        </observation>
      </component>
    </organizer>
  </entry>
</section>
```

Expected FHIR (today: two Observations, the panel one with `hasMember` and no value):

```json
[
  {
    "resourceType": "DiagnosticReport",
    "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "PANEL-1" }],
    "status": "final",
    "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v2-0074", "code": "LAB", "display": "Laboratory" }] }],
    "code": { "coding": [{ "system": "http://loinc.org", "code": "24323-8", "display": "Comprehensive metabolic panel" }], "text": "Comprehensive metabolic panel" },
    "subject": { "reference": "Patient/<the patient>" },
    "effectiveDateTime": "2024-02-10T09:10:00-05:00",
    "result": [{ "reference": "Observation/<the glucose Observation>" }]
  },
  {
    "resourceType": "Observation",
    "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "RES-1" }],
    "code": { "coding": [{ "system": "http://loinc.org", "code": "2345-7", "display": "Glucose" }], "text": "Glucose" },
    "valueQuantity": { "value": 95, "unit": "mg/dL", "system": "http://unitsofmeasure.org", "code": "mg/dL" },
    "effectiveDateTime": "2024-02-10T09:10:00-05:00"
  }
]
```

## PR: fix(ccda): map Result Organizers to DiagnosticReport

- `processOrganizer`: a Result Organizer (root or V2 template, among any of the organizer's templates) goes to the new `processResultOrganizer`. Vital Signs and other organizers keep today's panel Observation.
- `processResultOrganizer`: id and identifier from the organizer; status from statusCode (completed → final, active → partial, aborted/cancelled → cancelled, otherwise unknown); category v2-0074 `LAB` (`DIAGNOSTIC_SERVICE_SECTION_CODE_SYSTEM` in `systems.ts`); code (absent: a data-absent-reason `unknown`, since FHIR requires it); subject; `effective[x]` from `mapObservationEffectiveTime`; `result` → the component Observations, made exactly as before by `processVitalsComponent`.
- Tests (`result-organizer.test.ts`): a Result Organizer gives one DiagnosticReport with the results and no panel Observation; the V2 template and an `active` status give `partial`; a Vital Signs Organizer stays a panel Observation. Existing tests that read the Result Organizer as an Observation (the #11243 and #11244 organizer cases) read the report.
