# Epic FHIR export import

Load a FHIR export file (one JSON file: `{"fhir": {"<Type>": [resources]}, "attachments": [...]}`) into GA:

    ga import <fhir-export.json> --fhir-base <FHIR base URL>

`--fhir-base` is required. Records get the identifier a portal sync of that server would give them
(`urn:ga-server:id:smart:<host key>` with value `<Type>/<id>`), so a later `ga connect <base>` and `ga sync` links to these
records instead of duplicating them. They carry the tag `src-fhir-export`. Importing the same file again changes nothing.

`attachments` (`resourceType`, `resourceId`, `path`, `contentType`, `contentBase64`) are placed at the dotted `path` under that
resource (for example `content.0.attachment` or `presentedForm.0`). HTML and RTF notes and report text become plain text, as
in a portal sync; PDFs and images (in a DocumentReference or a report's `presentedForm`) are stored as Binaries. A copy of a
record that only adds `note` entries updates the stored record and keeps its notes.

Dates and currency: the file counts as a whole-record Epic import, dated by its newest `meta.lastUpdated`. Medications,
problems and allergies take that file date (one date per file, as for C-CDA and EHI), not their own `lastUpdated`, so an
older active medication in the file still reads current. Two effects: a record the person edited after its own `lastUpdated`
but before the file date gets a `source-conflict` tag (the file now dates it after the edit), and a portal record identical
to the file's version may be updated once, to the file's date. A file with no `lastUpdated` gives these records no date.

The report gives the usual counts plus:
- `skippedTypes`: resource types GA does not import, with their counts. Imported: Patient, the patient-compartment types
  GA supports, Practitioner, PractitionerRole, Organization, Location and Medication.
- `attachmentsUnplaced`: attachments whose resource or path is missing from the file.

The file itself is stored once, by content hash. Errors never quote the file.
