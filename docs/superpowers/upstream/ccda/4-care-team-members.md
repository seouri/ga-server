# 4. Care team: every member and every performer

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: C-CDA to FHIR keeps only the first act and first performer of a care team member component

`processCareTeamMember` reads `component.act?.[0]` and `act.performer?.[0]`. The parser makes both arrays (`component.act`, `act.performer` are in `ARRAY_PATHS`), and a Care Team Member Act may name several performers (for example a physician and the nurse who works with them). Every performer after the first, and any further act in a component, is dropped with no warning.

Reproduction (synthetic): a Care Team Organizer (`2.16.840.1.113883.10.20.22.4.500`) in a Care Teams section (`...22.2.500`) whose second component is:

```xml
<component>
  <act classCode="PCPR" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.500.1" extension="2022-06-01"/>
    <code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/>
    <statusCode code="active"/>
    <effectiveTime><low value="20200101"/></effectiveTime>
    <performer typeCode="PRF">
      <functionCode code="ATTPHYS" codeSystem="2.16.840.1.113883.5.88"/>
      <assignedEntity><id root="2.16.840.1.113883.4.6" extension="Beta"/><assignedPerson><name><given>Example</given><family>Beta</family></name></assignedPerson></assignedEntity>
    </performer>
    <performer typeCode="PRF">
      <functionCode code="RNDPHYS" codeSystem="2.16.840.1.113883.5.88"/>
      <assignedEntity><id root="2.16.840.1.113883.4.6" extension="Gamma"/><assignedPerson><name><given>Example</given><family>Gamma</family></name></assignedPerson></assignedEntity>
    </performer>
  </act>
</component>
```

- Actual: one participant for that component (ATTPHYS).
- Expected: two participants, roles ATTPHYS and RNDPHYS, each with its PractitionerRole member and the act's period.

Expected FHIR (that component's participants):

```json
"participant": [
  { "role": [{ "coding": [{ "system": "urn:oid:2.16.840.1.113883.5.88", "code": "ATTPHYS" }] }],
    "member": { "reference": "PractitionerRole/..." }, "period": { "start": "2020-01-01" } },
  { "role": [{ "coding": [{ "system": "urn:oid:2.16.840.1.113883.5.88", "code": "RNDPHYS" }] }],
    "member": { "reference": "PractitionerRole/..." }, "period": { "start": "2020-01-01" } }
]
```

(The library leaves this OID unmapped; no text, since the source has no displayName.)

## PR: fix(ccda): map every care team member and performer to CareTeam.participant

- `processCareTeamMember` becomes `processCareTeamMembers`, returning one participant per performer of each member act. Participant fields are unchanged.
- Test: `care-team-members.test.ts` (two components, the second with two performers: three participants).

## Filing metadata

- PATCHES rows: 4 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 0dc3444 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
