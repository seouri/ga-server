# 9. Concern acts with several observations → one record each

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: a concern act with several problem (or allergy) observations converts only the first

`processConditionAct` and `processAllergyIntoleranceAct` read `act.entryRelationship?.find((rel) => rel['@_typeCode'] === 'SUBJ')?.observation?.[0]`. The Problem Concern Act (`22.4.3`), Health Concern Act and Allergy Concern Act (`22.4.30`) allow `1..*` SUBJ observations, so every observation after the first is silently dropped. The AllergyIntolerance also gets no `identifier`, so the source observation id is lost.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
  <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Problems</title>
  <text>Problems</text>
  <entry>
    <act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <id root="2.16.840.1.113883.19.5" extension="CONCERN-1"/>
      <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
      <statusCode code="active"/>
      <entryRelationship typeCode="SUBJ">
        <observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
          <id root="2.16.840.1.113883.19.5" extension="PROBLEM-1"/>
          <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/>
          <statusCode code="completed"/>
          <effectiveTime><low value="20190305"/></effectiveTime>
          <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96"/>
        </observation>
      </entryRelationship>
      <entryRelationship typeCode="SUBJ">
        <observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
          <id root="2.16.840.1.113883.19.5" extension="PROBLEM-2"/>
          <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/>
          <statusCode code="completed"/>
          <effectiveTime><low value="20190305"/></effectiveTime>
          <value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96"/>
        </observation>
      </entryRelationship>
    </act>
  </entry>
</section>
```

Expected FHIR (two Conditions; today only the first):

```json
[
  {
    "resourceType": "Condition",
    "identifier": [
      { "system": "urn:oid:2.16.840.1.113883.19.5", "value": "PROBLEM-1" },
      { "system": "urn:oid:2.16.840.1.113883.19.5", "value": "CONCERN-1" }
    ],
    "code": { "coding": [{ "system": "http://snomed.info/sct", "code": "38341003" }] }
  },
  {
    "resourceType": "Condition",
    "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "PROBLEM-2" }],
    "code": { "coding": [{ "system": "http://snomed.info/sct", "code": "44054006" }] }
  }
]
```

The same for an Allergy Concern Act with two Allergy Intolerance Observations (`22.4.7`): two AllergyIntolerances, each with its observation id as `identifier`.

## PR: fix(ccda): one Condition / AllergyIntolerance per SUBJ observation of a concern act

- `getSubjectObservations(act)`: every observation of every SUBJ entryRelationship. `processConditionAct` and `processAllergyIntoleranceAct` map each to a record (`processConditionObservation`, `processAllergyIntoleranceObservation`); `processAct` already accepts an array.
- Identifiers: the observation ids first (they identify the problem; the act id is shared by its observations), then the act ids on the first record only, so two records never share an identifier. The first record keeps the act-based resource id as before.
- AllergyIntolerance gets `identifier` (it had none).
- Note for reviewers: the observation id now comes before the act id in `Condition.identifier`. Consumers keying on `identifier[0]` see the observation id.
- Test: `concern-observations.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 9 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): fb3e513 (docs 02d5e09, 9dcb59c) (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 29 touches the same allergy body
- Status: issue-first. Nothing filed (the README has the approval process).
