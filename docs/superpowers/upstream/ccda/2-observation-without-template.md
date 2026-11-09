# 2. An observation without a templateId refuses the whole document

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

Same cause as medplum#10671 (`templateId[0]`), on the entry instead of the section. No existing issue or PR. Propose it as its own issue, or fold it into the #10671 PR if the maintainers prefer. Nothing filed.

## Issue: @medplum/ccda: C-CDA to FHIR throws on an observation without a templateId

`processObservation` reads `observation.templateId[0]['@_root']` to spot goal observations. `templateId` is optional on a CDA observation (only the C-CDA templates require it), and some senders omit it on nested or local observations. The conversion then throws `TypeError: Cannot read properties of undefined (reading '0')`, and the whole document is lost. `mapGoalLifecycleStatus` likewise reads `observation.statusCode['@_code']` unguarded.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.17"/>
  <title>Social History</title><text>x</text>
  <entry>
    <observation classCode="OBS" moodCode="EVN">
      <id root="2.16.840.1.113883.19.5" extension="OBS-1"/>
      <code code="72166-2" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime value="20240210"/>
      <value xsi:type="CD" code="266919005" codeSystem="2.16.840.1.113883.6.96" displayName="Never smoker"/>
    </observation>
  </entry>
</section>
```

- Actual: TypeError, no Bundle.
- Expected: one Observation (LOINC 72166-2, value SNOMED 266919005), as with a templateId.

Expected FHIR (abridged):

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "OBS-1" }],
  "status": "final",
  "code": { "coding": [{ "system": "http://loinc.org", "code": "72166-2" }] },
  "subject": { "reference": "Patient/..." },
  "valueCodeableConcept": { "coding": [{ "system": "http://snomed.info/sct", "code": "266919005", "display": "Never smoker" }], "text": "Never smoker" },
  "effectiveDateTime": "2024-02-10"
}
```

## PR: fix(ccda): convert observations without a templateId

- `processObservation` tests the goal templates with `getTemplateIds(observation)` (from the #10671 fix), so a goal is also recognised when its goal template is not listed first.
- `mapGoalLifecycleStatus` reads `statusCode?.['@_code']` (absent → `active`, as documented in its comment).
- Test: `observation-without-template.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 2 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 274250c (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 1 (same cause; may fold into its PR)
- Status: issue-first. Nothing filed (the README has the approval process).
