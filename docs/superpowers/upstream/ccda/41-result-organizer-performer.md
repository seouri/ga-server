# 41. A Result Organizer's performer is the DiagnosticReport performer

No existing issue or PR. Builds on draft 19 (Result Organizer as DiagnosticReport). Nothing filed.

## Issue: @medplum/ccda: the lab that performed a result panel is dropped

A Result Organizer (`2.16.840.1.113883.10.20.22.4.1`) commonly names the performing lab as `organizer/performer/assignedEntity` (a CLIA id and a representedOrganization). The organizer's performer is never read, so the DiagnosticReport has no `performer`.

Reproduction (synthetic), inside the organizer:

```xml
<performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.7" extension="LAB-1"/>
  <representedOrganization><name>Test Lab</name></representedOrganization></assignedEntity></performer>
```

Expected: `DiagnosticReport.performer: [{ reference: "PractitionerRole/..." }]`, the role pointing at a Practitioner with the CLIA identifier and an Organization `Test Lab` (as other assigned entities). Actual: no `performer`.

## PR: fix(ccda): DiagnosticReport.performer from the organizer performer

- `ccda-to-fhir.ts`: the DiagnosticReport maps `organizer.performer` through `mapAssignedEntityToReference`.
- `types.ts`: `CcdaOrganizer.performer`; `xml.ts`: `organizer.performer` is an array.
- Test `result-organizer.test.ts`.
