# 24. A Goal gets no empty target or category

No existing issue or PR. Independent of the other drafts. Nothing filed.

## Issue: @medplum/ccda: a goal observation with an observation entryRelationship gets an empty target `{}`; a goal without a code gets `category: []`

`processGoalObservation` pushes one `target` per entryRelationship, reading only `entryRelationship.act[0]`. A Goal Observation commonly links observations (a reason, a priority, an author's note) rather than acts; each one becomes `{ measure: undefined, detailCodeableConcept: undefined, dueDate: undefined }`, serialized as `{}`. A goal with no `code` gets `category: []`, and one with no entryRelationship `target: []`. Empty objects and arrays are not valid FHIR JSON, so a server may refuse the Goal.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.10" extension="2014-06-09"/>
  <code code="18776-5" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Plan of Treatment</title>
  <entry>
    <observation classCode="OBS" moodCode="GOL">
      <templateId root="2.16.840.1.113883.10.20.22.4.121"/>
      <id root="2.16.840.1.113883.19.5" extension="GOAL-1"/>
      <statusCode code="active"/>
      <value xsi:type="ST">Walk daily</value>
      <entryRelationship typeCode="RSON">
        <observation classCode="OBS" moodCode="EVN">
          <code code="1" codeSystem="2.16.840.1.113883.6.1"/>
          <statusCode code="completed"/>
        </observation>
      </entryRelationship>
    </observation>
  </entry>
</section>
```

Expected: a Goal with `description: { text: "Walk daily" }` and neither `target` nor `category` (today: `"target": [{}]`, `"category": []`).

## PR: fix(ccda): no empty Goal target or category

- A target is added only when the relationship's act gives a code (`measure`, `detailCodeableConcept`) or a time (`dueDate`).
- `target` and `category` are left out when empty.
- Test: the goal above has no target and no category; a goal with an act relationship keeps its one target (code and due date).

## Filing metadata

- PATCHES rows: 24 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 02ce415 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
