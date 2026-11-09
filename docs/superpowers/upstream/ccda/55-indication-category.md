# 55. An encounter's indication Condition has a category

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Same function as draft 53's indication case (`processEncounter`).

## Issue: @medplum/ccda: an encounter's indication Condition has no category

An Encounter Activity's `entryRelationship typeCode="RSON"` observation (Indication, `2.16.840.1.113883.10.20.22.4.19`) becomes a Condition referenced from `Encounter.diagnosis` (use `AD`). That Condition has no `category`. US Core Condition requires one, and a reader separating problem-list items from visit diagnoses cannot place it.

Reproduction (synthetic):

```xml
<encounter classCode="ENC" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
  <id root="2.16.840.1.113883.19.5" extension="ENC-1"/>
  <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
  <entryRelationship typeCode="RSON">
    <observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.19"/>
      <id root="2.16.840.1.113883.19.5" extension="RSON-1"/>
      <code code="404684003" codeSystem="2.16.840.1.113883.6.96"/>
      <statusCode code="completed"/>
      <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96"/>
    </observation>
  </entryRelationship>
</encounter>
```

Expected: `"category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/condition-category", "code": "encounter-diagnosis", "display": "Encounter Diagnosis" }] }]`. Actual: no `category`.

## PR: fix(ccda): an encounter's indication Condition is an encounter diagnosis

- `ccda-to-fhir.ts`: the RSON Condition in `processEncounter` gets `category` `encounter-diagnosis` (the existing `ENCOUNTER_DIAGNOSIS` coding).
- Test `problem-status.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 55 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): the commit that adds this draft (`git log --oneline -- docs/superpowers/upstream/ccda/55-indication-category.md`)
- Moved from GA's post-conversion `repair` (src/ccda.ts), which now runs only on the Microsoft path.
