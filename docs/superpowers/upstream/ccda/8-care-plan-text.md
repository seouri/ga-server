# 8. Plan of Treatment act text by reference → CarePlan.description

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Uses medplum#11242 (`resolveNarrativeReference`). Nothing filed.

## Issue: @medplum/ccda: CarePlan from a Plan of Treatment act has no description when the act text is a narrative reference

`processCarePlanAct` sets `description: nodeToString(act.text)`. A Planned Act (`22.4.39`) normally carries `<text><reference value="#plan1"/></text>`, for which `nodeToString` returns undefined, so the plan's words ("Recheck blood pressure in three months") are lost from the CarePlan.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.10"/>
  <code code="18776-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Plan of Treatment</title>
  <text><paragraph ID="plan1">Recheck blood pressure in three months.</paragraph></text>
  <entry>
    <act classCode="ACT" moodCode="INT">
      <templateId root="2.16.840.1.113883.10.20.22.4.39"/>
      <id root="2.16.840.1.113883.19.5" extension="PLAN-1"/>
      <code code="409073007" codeSystem="2.16.840.1.113883.6.96" displayName="Education"/>
      <text><reference value="#plan1"/></text>
      <statusCode code="active"/>
      <effectiveTime value="20240510"/>
    </act>
  </entry>
</section>
```

Expected FHIR (fields this fix adds):

```json
{
  "resourceType": "CarePlan",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "PLAN-1" }],
  "description": "Recheck blood pressure in three months.",
  "extension": [{ "url": "https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference", "valueString": "#plan1" }]
}
```

## PR: fix(ccda): resolve the narrative reference in a Plan of Treatment act's text

- `description: nodeToString(act.text) || this.resolveNarrativeReference(act.text?.reference)`, and the narrative-reference extension as on other resources.
- Test: `care-plan-text.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 8 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 50f8b78 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 3 (PR medplum#11242)
- Status: issue-first. Nothing filed (the README has the approval process).
