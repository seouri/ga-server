# 46. A Result Organizer's procedures, specimens and encounter

No existing issue or PR. Builds on drafts 19 and 41. Nothing filed.

## Issue: @medplum/ccda: Result Organizer components other than observations are dropped

`processResultOrganizer` reads only observation components. Lab systems (Epic among them) also put a `procedure` component (the specimen collection, with the specimen as a `PRD` participant and an IHE Specimen Received act) and an `encounter` component (the ordering visit) in the organizer, and an `organizer/specimen`. All of them are dropped.

Reproduction (synthetic), inside a Result Organizer:

```xml
<specimen typeCode="SPC"><specimenRole><id root="2.16.840.1.113883.19.5.30" extension="SPEC-1"/></specimenRole></specimen>
<component><procedure classCode="PROC" moodCode="EVN"><code code="82078001" codeSystem="2.16.840.1.113883.6.96"/><effectiveTime value="20240210080000-0500"/>
  <participant typeCode="PRD"><participantRole classCode="SPEC"><id root="2.16.840.1.113883.19.5.30" extension="SPEC-1"/></participantRole></participant></procedure></component>
<component><encounter classCode="ENC" moodCode="EVN"><id root="2.16.840.1.113883.19.5.3" extension="VISIT-9"/></encounter></component>
```

Expected: a `Procedure` (code, performed time) whose `report` points at the DiagnosticReport; one `Specimen` `SPEC-1` with `collection.collectedDateTime` and `method`, in `DiagnosticReport.specimen`; `DiagnosticReport.encounter` pointing at an Encounter `VISIT-9` (the Encounters-section entry with that id when there is one). Actual: none of them.

## PR: fix(ccda): Result Organizer procedures, specimens and encounter

- `ccda-to-fhir.ts`: `processResultOrganizer` maps procedure components (`processProcedure` + `report`), `mapSpecimen` (one per specimen id), and `resolveReportEncounters` after all sections.
- `oids.ts`: `OID_SPECIMEN_RECEIVED`; `types.ts`: organizer `specimen`, component `procedure`/`encounter`, procedure `entryRelationship`, `specimenPlayingEntity`; `xml.ts`: the new arrays.
- Tests in `result-organizer.test.ts`.
