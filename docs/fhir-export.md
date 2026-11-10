# Epic FHIR export import

Load a FHIR export file (one JSON file: `{"fhir": {"<Type>": [resources]}, "attachments": [...]}`) into GA:

    ga import <fhir-export.json> --fhir-base <FHIR base URL>

`--fhir-base` is required. Records get the identifier a portal sync of that server would give them
(`urn:ga-server:id:smart:<host key>` with value `<Type>/<id>`), so a later `ga connect <base>` and `ga sync` links to these
records instead of duplicating them. They carry the tag `src-fhir-export`. Importing the same file again changes nothing.

`attachments` (`resourceType`, `resourceId`, `path`, `contentType`, `contentBase64`) are placed at the dotted `path` under that
resource (for example `content.0.attachment` or `presentedForm.0`). HTML and RTF notes and report text become plain text, as
in a portal sync; PDFs and images are stored as Binaries. A copy of a record that only adds `note` entries updates the stored
record and keeps its notes.

The report gives the usual counts plus:
- `skippedTypes`: resource types GA does not import, with their counts. Imported: Patient, the patient-compartment types
  GA supports, Practitioner, PractitionerRole, Organization, Location and Medication.
- `attachmentsUnplaced`: attachments whose resource or path is missing from the file.

The file itself is stored once, by content hash. Errors never quote the file.
