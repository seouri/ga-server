# personalrecord rebuild

Standalone tool. Rebuilds typed FHIR resources from the personalrecord app's flattened export (every record an `Observation` in `bundle.json`, plus the owner's `annotations.json`), writing the `{ fhir, attachments }` file that `ga import` reads for a FHIR export. It imports nothing from GA (`src/`); only `node:*` and `@medplum/fhirtypes` types.

## Command

```
node --max-old-space-size=4096 tools/personalrecord/cli.ts <dir> --known <ehr-data.json> --out <file.json> [--include-before-cutoff]
```

`<dir>` holds `bundle.json` and `annotations.json`. `--known` is a FHIR export file you already have (`{ fhir: { <Type>: Resource[] }, attachments: [] }`). The bundle can be hundreds of MB and is parsed in one piece, so raise the memory limit as shown (`--max-old-space-size=4096`).

## Output

Prints the report as JSON:

- `emitted`: resources written, by type
- `alreadyKnown`: ids already in `--known`
- `beforeCutoff`: records dated on or before the cutoff (calendar day), the newest clinical date in `--known`; kept with `--include-before-cutoff`
- `notEpic`: ids that are not Epic ids or whose prefix has no mapping
- `otherSource`: records whose source is not `ehr_data` (Apple Health)
- `cutoff`: the date used
- `annotationsMatched`, `annotationsUnmatched` (`{ code, reason: 'none' | 'several' }`)

## Mapping

The id is the bundle id without its prefix. `date` is the Observation's `effectiveDateTime`. Never written: `subject`, `meta`, the app's `extension`s, `source`, `data_type`, `element_id`. `NOTE` = "Reconstructed from a personalrecord export; original structure lost."

| Prefix | Resource |
|---|---|
| none | `Observation`: the FHIR fields as they are, plus `NOTE` |
| `condition-` | `Condition`: `code`, `recordedDate`, notes `NOTE` and the value text when it differs from `code.text` |
| `medrx-` | `MedicationRequest`: status `unknown`, intent `order`, the code (or the value text when the code is empty), `authoredOn`, `NOTE` |
| `docref-` | `DocumentReference`: status `current`, `type`, `date`, the note text as a base64 `text/plain` attachment |
| `dr-` | `DiagnosticReport`: status `final`, `code`, `effectiveDateTime`, `conclusion` |
| `imm-` | `Immunization`: status `completed`, `vaccineCode`, `occurrenceDateTime` |
| `proc-` | `Procedure`: status `completed`, `code`, `performedDateTime` |
| other | not emitted (`notEpic`) |

## Annotations

Each owner annotation (ended, ongoing, date correction, comment) is matched to one resource by its code display (and the original date when several share it) and added as a `note` (author `Patient`). A match in `--known` is written as a verbatim copy of that resource with the note appended; a match among rebuilt resources gets the note directly. No match, or several, is reported and skipped.
