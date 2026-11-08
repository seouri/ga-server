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
