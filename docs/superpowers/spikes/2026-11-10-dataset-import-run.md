# Dataset folder import: run log (2026-11-10)

Task Z of docs/superpowers/plans/2026-11-10-dataset-folder-import.md, run against a real personal dataset folder (manifest layout `<data_type>/<source>/<date>/`). Counts only.

| Step | Command / tool | Result |
|---|---|---|
| Apple Health export (181 MB) | `ga import <apple-health folder>` | created 29,520, merged 2, possible duplicates 348, invalid 8, archive stored, 1,021 s. 1,788 Health Records imported as `src-apple-clinical` (0 DSTU2, 0 unreadable). |
| Epic FHIR export (2,880 resources, 264 attachments) | `ga import <ehr-data.json> --fhir-base <MGB FHIR base>` | created 889, skipped 1,773, merged 7, possible duplicates 200, invalid 10, unplaced attachments 0, unmapped 0, 90 s. |
| personalrecord rebuild | dataset tool (`derived/ga-rebuild/<date>/tool`) then `ga import <rebuilt.json> --fhir-base <same>` | 109 records rebuilt (13 MedicationRequest, 79 Observation, 9 DocumentReference, 6 Condition, 1 Procedure, 1 DiagnosticReport) + 6 annotated hospital records; first import created 101, merged 7, invalid 8; after the tool fix (no nulls; DocumentReference annotations reported) a re-import created the remaining 7, invalid 0. Annotation notes on 6 records; 8 annotations unmatched (5 none, 2 several, 1 no-note-field). Held back by design: 151 records older than the export that the export lacks under those ids. |
| Dental CT (702 files, 836 MB) | `ga import <dicom folder>` | 1 ImagingStudy (5 series, 696 instances), 1 overview PDF, archive stored, 6 non-DICOM files skipped, 0 unsupported, 72 s. |
| Scanned documents | `ga_import` (agent extraction) | Owner decision: only the visit note (33 resources: 12 Observation, 11 Condition, 6 Procedure, 3 MedicationStatement, 1 DiagnosticReport; invalid 0; 14 terms mapped as suggestions, 3 left for review). The two lab PDFs and six PNG/TIFF scans were not imported: every value is already in the Epic export with its date. |
| Not imported | — | Apple `export_cda.xml` (same samples as export.xml; its recordTarget names a different person than the dataset), personalrecord app metadata, its LOINC table, its older annotation copy. |

## Findings

- **Invalid records (all reported, none fatal):**
  - 8 Observations with an empty `note.text`, which the hospital source data itself contains. They appear in both the Apple copies and the Epic export.
  - 2 Epic DocumentReferences with a malformed extension.
- **Identical copies keep the Apple label:** an Epic export record identical to an already-stored Apple copy is skipped. The stored record keeps `src-apple-clinical` and the export date as its source date, and gains no `src-fhir-export` tag. Content is the same. Labels and the currency date differ from a hospital-first import. This is a follow-up candidate: on an identical skip, add the hospital source tag.
- **Running services still on `main`:** the MCP server started for this session, `ga-gateway` and `ga-sync` all still run main's code. Until they restart on the merged code, `health_summary` shows new hospital records with setting "unknown" and lists no FHIR export source.

## Follow-up: identical hospital copies take the hospital label (commits 5a163ea, 94bf3c6)

Re-import of the Epic FHIR export after the engine change: updated 1,726, skipped 1,143, created 0, invalid 10 (the same 10). Apple clinical copies now carrying the hospital label (`src-fhir-export`): every Observation, Condition, MedicationRequest, Procedure, AllergyIntolerance and Immunization. 80 kept `src-apple-clinical` (13 DiagnosticReport, 67 DocumentReference): the export copy would drop something the Apple copy has (the "loses nothing" guard), so it only filled.
