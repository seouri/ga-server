# 30. Composition and CareTeam subject; section mode

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Touches the CareTeam builder of draft 4 (care team members) but not its lines. Nothing filed.

## Issue: @medplum/ccda: the Composition and CareTeam have no subject

`createComposition` sets author, custodian and sections but no `subject`, and `processCareTeamOrganizer` builds a CareTeam with only identifier and participants. Both resources belong to the patient compartment through `subject`; without it a server's `Patient/$everything`, compartment searches and access policies scoped to the patient miss them. The document's patient (`recordTarget`) is already converted as `this.patient`. Each Composition section also has no `mode`; a C-CDA summary section lists the record as of the document date, i.e. a `snapshot` (as other C-CDA → FHIR converters, e.g. Microsoft's FHIR-Converter, write it).

Reproduction (synthetic): any document with a `recordTarget` and a Care Teams section:

```xml
<organizer classCode="CLUSTER" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.500" extension="2022-06-01"/>
  <id root="2.16.840.1.113883.19.5" extension="TEAM-1"/>
  <code code="86744-0" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/>
  <component><act classCode="PCPR" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.500.1" extension="2022-06-01"/>
    <code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/>
    <performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="A"/></assignedEntity></performer>
  </act></component>
</organizer>
```

Expected: `Composition.subject` and `CareTeam.subject` = `{ "reference": "Patient/<the converted patient>" }`; each `Composition.section[].mode` = `snapshot`. Actual: no subject, no mode.

## PR: fix(ccda): set subject on the Composition and CareTeam, and section mode

- `ccda-to-fhir.ts`: `subject: createReference(this.patient)` (when a patient exists) on both; `mode: 'snapshot'` on each section.
- Test `document-subject.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 30 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): a043cda (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed (the README has the approval process).
