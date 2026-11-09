# 53. Problem clinical status from the Problem Status observation and the problem's end date

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Same function as drafts 9 and 10 (`processConditionObservation`).

## Issue: @medplum/ccda: a resolved problem converts as an active Condition

`Condition.clinicalStatus` is read only from the Problem Concern Act's `statusCode`, through `PROBLEM_STATUS_MAPPER`. Three things go wrong:

- `completed`, the C-CDA IG's value for a concern that is no longer tracked, is not in the mapper, so it falls to the default `active`.
- The Problem Status observation (LOINC `33999-4`, template `2.16.840.1.113883.10.20.22.4.6`) inside the problem observation, which states the problem's status directly, is ignored.
- A problem observation with an end (`effectiveTime/high`) is resolved, yet reads `active` while its concern act is `active`.

The mapper also maps `resolved` to `inactive`, although FHIR's `condition-clinical` has `resolved`. An encounter's indication (`entryRelationship typeCode="RSON"`) Condition is always `active`, whatever its end date says.

Reproduction (synthetic):

```xml
<act classCode="ACT" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
  <id root="2.16.840.1.113883.19.5" extension="CONCERN-1"/>
  <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
  <statusCode code="completed"/>
  <entryRelationship typeCode="SUBJ">
    <observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <id root="2.16.840.1.113883.19.5" extension="PROBLEM-1"/>
      <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/>
      <statusCode code="completed"/>
      <effectiveTime><low value="20200101"/></effectiveTime>
      <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96"/>
    </observation>
  </entryRelationship>
</act>
```

Expected: `"clinicalStatus": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "resolved" }] }`. Actual: `"code": "active"`.

The same with an `active` concern act and a Problem Status observation valued `73425007` (Inactive) is expected `inactive`; with `<high value="20210101"/>` in the problem's effectiveTime, `resolved`.

## PR: fix(ccda): problem clinical status from the status observation, the end date, then the concern act

- `ccda-to-fhir.ts`: `mapProblemClinicalStatus(observation, act?)`: the Problem Status observation's value (SNOMED `55561003` active, `73425007` inactive, `413322009` resolved, or the same display names), else `resolved` when `effectiveTime/high` has a value, else the concern act's statusCode (`active` → active; `completed`, `resolved` → resolved); `PROBLEM_STATUS_MAPPER` only when none of them says. Used for problem and encounter diagnosis Conditions and for an encounter's indication (RSON) Condition (no concern act).
- Test `problem-status.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 53 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): the commit that adds this draft (`git log --oneline -- docs/superpowers/upstream/ccda/53-problem-status.md`)
- Moved from GA's post-conversion `repair` (src/ccda.ts, the rule GA's ledger calls R11), which now runs only on the Microsoft path.
