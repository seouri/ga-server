# 56. A Health Concerns entry is a health-concern Condition

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR.

## Issue: @medplum/ccda: Health Concerns section entries become problem-list items

A Problem Concern Act in the Health Concerns section (`2.16.840.1.113883.10.20.22.2.58`) is converted by the same path as the Problems section, so its Condition gets `category` `problem-list-item`. US Core defines `health-concern` for these (`http://hl7.org/fhir/us/core/CodeSystem/condition-category`), and a reader listing problem-list items shows health concerns as problems.

Reproduction (synthetic; the fragment sits in a minimal ClinicalDocument):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.58"/>
  <code code="75310-3" codeSystem="2.16.840.1.113883.6.1"/>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <id root="2.16.840.1.113883.19.5" extension="ACT-HC-1"/>
    <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <id root="2.16.840.1.113883.19.5" extension="HC-1"/>
      <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/><statusCode code="completed"/>
      <effectiveTime><low value="2020"/></effectiveTime>
      <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96"/>
    </observation></entryRelationship>
  </act></entry>
</section>
```

Expected: `"category": [{ "coding": [{ "system": "http://hl7.org/fhir/us/core/CodeSystem/condition-category", "code": "health-concern", "display": "Health Concern" }] }]`. Actual: `problem-list-item`.

## PR: fix(ccda): Health Concerns section entries are health-concern Conditions

- `ccda-to-fhir.ts`: a `HEALTH_CONCERN` coding (US Core condition-category `health-concern`), passed to `processConditionAct` for the Health Concerns section.
- Test `health-concern-category.test.ts` (Health Concerns → `health-concern`; Problems unchanged).

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 56 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): the commit that adds this draft (`git log --oneline -- docs/superpowers/upstream/ccda/56-health-concern-category.md`)
- Replaces GA's post-conversion relabel to `encounter-diagnosis` (src/ccda.ts `localChoices`), removed in the same commit.
