# 44. An assigned entity's code is the PractitionerRole specialty

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: assignedEntity/code is dropped

`mapAssignedEntityToReference` builds a Practitioner, an Organization and a PractitionerRole but never reads `assignedEntity/code`, the clinician's provider taxonomy (NUCC, e.g. `207R00000X` Internal Medicine), so every encounter performer, care team member or lab loses it.

Reproduction (synthetic), an encounter performer:

```xml
<performer><assignedEntity><id root="2.16.840.1.113883.4.6" extension="NPI-2"/>
  <code code="207R00000X" codeSystem="2.16.840.1.113883.6.101" displayName="Internal Medicine"/></assignedEntity></performer>
```

Expected: the PractitionerRole's `specialty: [{ coding: [{ system: "http://nucc.org/provider-taxonomy", code: "207R00000X", display: "Internal Medicine" }], text: "Internal Medicine" }]` (US Core binds PractitionerRole.specialty to the NUCC taxonomy). Actual: no specialty.

## PR: fix(ccda): PractitionerRole.specialty from the assigned entity's code

- `ccda-to-fhir.ts`: `specialty` in `mapAssignedEntityToReference`.
- Test `encounter.test.ts`.

## Filing metadata

- PATCHES rows: 44 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 82c08e9 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 33
- Status: issue-first. Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
