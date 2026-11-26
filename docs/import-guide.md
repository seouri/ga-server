# Import guide

How to load a person's records into GA from every kind of source, check the result, and record what was learned. It is written for a person or an agent doing an import on any GA server. It holds no patient data, so it can be copied to another GA install as it is. Sections 1 to 8 and the scope lines of each lesson are stated in terms of the sources and of FHIR fields, so another implementation of a GA server can follow them; function and file names in a lesson's last two lines belong to this implementation and say where the fix lives here.

The rules for each tool are in [AGENTS.md](../AGENTS.md); this guide is the procedure around them and the list of things that have gone wrong.

## How to add to this guide

Every fix or correction goes in "Lessons" below as one entry, and each entry states its scope first:

- **Provenance**: the source it applies to. Be exact: "Epic FHIR export made by the health-skillz tool", not "FHIR"; "Apple Health, Health Records part", not "Apple Health".
- **Data type**: the record kinds it applies to (lab Observation, DocumentReference note, Encounter, ...). "All" only when it truly is all.
- **Symptom**: what the person or the import report showed.
- **Cause**: what was actually wrong, checked, not guessed.
- **What to do**: the step to take, or the code that now handles it.
- **Status**: `fixed in code` (name the function), `worked around` (the code still has the problem), or `open`.

Before generalising a fix, ask whether another provenance or data type has the same shape. A rule that is right for one source is often wrong for another: an Apple identifier on a document meant "Apple ECG file" until hospital notes arrived through Apple's Health Records carrying the same identifier (lesson 7). When a fix is applied in code, test the neighbouring provenances too, and say in the entry which ones were checked.

## 1. Before importing

1. **GA is running**: `docker compose ps` shows the services up, and `health_summary` answers. An empty summary (no patient details, no sources) means a new or different store, not a failure.
2. **Find the newest copy of each source.** Do not trust folder dates. Open each candidate and read its own dates: the export date inside an Apple `export.xml`, the newest record date in a FHIR export, the fetch time a tool recorded. Older copies of the same export add nothing; skip them.
3. **List what each folder really holds.** One folder often mixes sources (a FHIR export, an Apple export, DICOM, scanned PDFs). Each is imported on its own.
4. **Paths**: a file or folder path with a space in it fails (lesson 1). Use a path without spaces, or a link without spaces that points to it.
5. **Never guess the FHIR base address** of a portal export. Take it from the export, from the person, or from another record of the same hospital already in hand (Apple Health clinical records carry it as `sourceURL`). The same address must be used later for `ga connect`, so a portal sync links to these records.

## 2. Order

Import hospital sources first, then Apple Health, then imaging, then scanned documents:

1. Epic FHIR export, C-CDA or EHI export (the hospital's own records).
2. Apple Health export. Its Health Records part then links to the hospital records already stored (reported as `merged`) and only its wearable readings are new.
3. DICOM folders.
4. PDFs and photos, one at a time, by the extraction rules in AGENTS.md.

The other order also works (a hospital record takes over an Apple-only copy), but hospital-first gives a report that is easier to check.

Several export files of one hospital: import them **oldest first**, newest last. When the files carry no update dates, the one imported last decides every record they share (lesson 14). Before importing any second file of a hospital, take a snapshot of the record (every record, as stored) so the import can be compared field by field afterwards; the import report's `updated` count alone does not say whether an update was a gain or a loss.

## 3. By source

### Epic FHIR export file (`.json`)

`ga import <file.json> --fhir-base <FHIR base URL>`. GA expects one object, `{"fhir": {"<Type>": [...]}, "attachments": [...]}` ([fhir-export.md](fhir-export.md)).

- A file from the health-skillz tool differs in two ways and must be converted to a copy first (lesson 2). Never edit the original.
- Records with a blank comment are rejected (lesson 3).
- The report's `possibleDuplicates` are mostly not duplicates (lesson 5).
- A file without `meta.lastUpdated` gives medications, problems and allergies no source date. They read as current with nothing to judge them by; say so to the person.

### Apple Health export (folder with `export.xml`)

`ga import <unzipped folder>`. Import the whole unzipped folder (`export.xml`, `export_cda.xml`, `clinical-records/`), not a loose `export.xml`: the clinical records are the hospital data on the phone.

- It takes minutes (about 5 to 10 for a 170 MB export).
- Wearable readings are `created`. Hospital records already stored are `merged` on the first import and `skipped` after.
- Many Apple types are archived, not imported (`skips.archiveOnly`): energy, walking metrics, audio exposure, glucose samples. That is by design; report the counts.
- Records only the phone has (older reports, old medication-list entries) are kept, tagged `src-apple-clinical`. Their report text may be only a link to the hospital (lesson 8).

### DICOM (folder with `DICOMDIR`)

`ga import <folder>`. Point at the folder that holds `DICOMDIR`, which is often one level below the disc's top folder. One `ImagingStudy` per study, the encapsulated PDF as a document, the folder archived. No images are shown.

### C-CDA (Epic portal download, "IHE_XDM" folder)

`ga import <folder>`, pointing at the folder that holds the `DOC0001.XML ...` files (`IHE_XDM/<name>/`); `METADATA.XML` is skipped by design. One import per hospital.

- Before importing, read the patient named in every document (`recordTarget`): a download bundle can hold several people's folders (lesson 21). One GA install holds one person.
- Run it a second time only after a code fix: records rejected the first time are created, the rest are skipped or updated (lessons 17 to 19).
- The report's `notImported` lists what the converter left out, by section and reason. "observation without a code" under Results is Epic's own result-type marker (no test name, no value), not a result. Whole sections it does not read (Administered Medications, Medications at Time of Discharge, Discharge Instructions, Admitting Diagnoses, Ordered Prescriptions) and planned-test detail in Plan of Treatment are real content: name them to the person with their counts.
- `patient demographic conflict: name` on the error stream means a later document spells the name differently (a middle name present or absent); the first spelling is kept. `source id collision` means two entries of one document share an id and differ; both are kept.
- Two hospitals' exports use the same file names, which once hid most unmapped terms from review (lesson 20).

### Epic EHI export, PDFs and photos, portal sync

Follow AGENTS.md. No lessons are recorded for them here yet; add them as they come.

## 4. After every import

1. **Read the report, and account for every record.** `created + possibleDuplicates + merged + updated + skipped + invalid` equals the records read (a possible duplicate is created, with a flag). Anything `invalid` is printed on the error stream as `invalid <Type>/<field>`: find those records in the source and say which clinical results they are. Never report an import as clean while a count is unexplained.
2. **Re-run after a failure.** Records that failed validation were not stored; fixing the cause and importing again creates only them.
3. **Check the record**: `health_summary` shows the person's age and sex, problems, medications, key labs and the source.
4. **Unmapped terms**: map them from `concepts_to_review`, not from the import report (lesson 6).
5. **Duplicates**: judge them by pattern (section 5), not by the flag count.
6. **Categories**: check section 6 for the data types this source brought.

## 5. Checking for duplicates

Pull the records back and group them. Three questions, per data type:

- **Across sources**: is one event stored once? Records present in two sources should be one record carrying both identifiers.
- **GA's `possible-duplicate` flag**: group the flagged records by their links and look at what each group shares. Same name, same instant and same value from different sources is a duplicate. These are not:
  - separate panels of one blood draw (same instant, different names);
  - several tubes of one draw (Specimen);
  - repeated monitoring readings during a procedure (same value, minutes apart);
  - the same procedure in different years;
  - one question with several answers at one instant.
- **Recorded twice by the source, not flagged**: look for one real event with two records of different kinds. Known for Epic: a day procedure as a hospital encounter plus a surgery log; an endoscopy as an order-based Procedure plus a surgical Procedure.

GA has no delete or merge tool. Report what was found; presentation layers (the chronology page) pair such records themselves.

## 6. Checking categories

| Data type | What to check |
|---|---|
| Diagnoses | `problem-list-item` is the problem list; `encounter-diagnosis` repeats the same condition at each visit and is not a second problem. |
| Medications | Category `community` or `discharge` is a prescription. `inpatient` or `outpatient` alone is a drug given in a care setting (sedation on a procedure day), not a course of treatment. Intent `plan` is a list entry, not an order. |
| Encounters | Classify by class, then type, then length: inpatient, emergency, day procedure, visit, hospital outpatient (imaging, lab, echo), or contact with no visit (refill, orders only, telephone, system generated). Epic class names are its own (`Appointment`, `HOV`, `Discharge`, `Surgery Log`, `Support OP Encounter`); `Discharge` is not an admission unless the stay lasts a day or more. |
| Notes | `clinical-note` DocumentReferences are notes, by kind. `summary-document` is an encounter summary document; stored source files and archives are neither. |
| Labs | Category `laboratory` with a specimen-based result. Blood and urine tests of one name have different codes and stay apart. |
| Echo and ECG measurements | Epic files them under `laboratory` plus a section category (`Echo`, `ECG`). They are cardiology study measurements, shown with their report (lesson 4). |
| Imaging | A DiagnosticReport with an imaging category, a DICOM ImagingStudy, or an "imaging study" note. The same exam can appear as a report in one source and a note in another. |
| Wearables | Tag `src-apple-health`. Daily totals and means are summaries, not readings. A home reading and a clinic reading on one day are both real. |
| Undated records | Epic exam findings ("smartdata") have no `effective` date, only `issued` (when they were filed) and a `focus` naming the visit or note they belong to. Show them with that visit or note; do not place them on a time axis by `issued` as if it were when the finding was made. |

## 7. Checking that every detail can be retrieved

An import is not finished when the counts add up. A record can be stored whole and still be unreadable in practice, because no tool or page shows the field that matters (lessons 7, 9 and 10). After the first import from a new kind of source, and after any change to a view, check retrieval for every data type, not only the common ones.

1. **List what is stored.** For each record type, split by category and source, count how many records fill each field. This shows what the source actually sends, which differs from what the standard allows: one hospital puts pathology text in the report's attachment, another in a result's text value.
2. **Check reach.** Every stored record must be reachable from some view: on a lane, in the detail of the visit it was recorded at, or in a list of its kind. A type no view names (allergies, orders, care plans, pharmacy fills, specimens, assessments) is the usual miss.
3. **Check content.** For every record (sample the very large groups), compare each value a person can read (names, text, numbers, dates, people, places) with what its detail shows. What may be left out: codes, ids, addresses, account and member numbers, and labels that the view replaces with a plain word. Anything else missing is a defect or a decision to write down.
4. **Make the fallback complete.** A view should show every readable field it does not know by name, under a label made from the field's name, rather than only the fields it was written for. Then a new source's extra fields appear without code changes, and step 3 finds only real surprises.
5. **Look at one of each.** Counts do not show a wrong grouping. Open one detail per data type and read it (lesson 11 was found this way, not by the counts).

Choose the form by the kind of value, not by the record type:

| Kind of value | Examples | Form |
|---|---|---|
| A number measured a few times | lab results, clinic vitals, echo measurements | Chart on plain time with the usual range as a band and out-of-range points marked; under it every result with date, value, range and comment. In a report, each measurement next to the value of the time before. |
| A number measured thousands of times | home weight, steps, sleep, heart rate | Monthly means charted; one row per year (count, mean, lowest to highest); only the latest readings listed. Home and clinic readings stay separate series. |
| Several numbers in one reading | blood pressure, sleep stages, activity rings | One line per part when they share a unit; a chart per unit when they do not. |
| A word or short phrase result | "Negative", urine colour, smoking status, assessment answers | Dated rows; never forced onto a number axis. |
| Text | notes, report narrative, pathology diagnosis, messages, care plan | Read as text at a book line length, with who wrote it, when and at which visit above it. Long text found in a result belongs with its report as a titled passage. |
| Something that lasts | problems, medication courses, stays | A bar from start to end; the detail lists each order or change with its directions, prescriber and supply. |
| Something that happened once | visit, procedure, immunization | A sheet of facts (who, where, why, lot, site, outcome) and links to what was recorded with it. A visit is the hub: diagnoses, notes, orders, drugs, vitals, labs and findings of that visit are listed under it. |
| Files GA cannot render | DICOM images, C-CDA summary documents, archives | Say what the file is and that it is stored; list its series or kind; never a blank panel. |

Times: show an instant in the reader's time zone, a date as written. A UTC time shown bare is read as local time and is hours off.

## 8. Moving a record to another GA server

There are two ways. Choose by what the other server already holds.

**An exact copy (the other install will hold only this person).** Take a backup on this server and restore it on the other (docs/operations.md, "Backup" and "Restore"). It brings every record exactly as stored, including records an agent read from documents, the concept mappings, shares and portal connections. It replaces whatever record the other install holds, and both installs should run the same GA version. On a computer that already holds another person's record, restore into a second copy of the GA folder (docs/operations.md, "A second person"), never into the first.

**Importing the sources again (any GA server, any version).** Import the same original sources on the other server, in the order of section 2, following this guide. So that this gives the same record and not a fresh reading of it, keep these together in one folder per person:

- the originals (export folders, PDFs), untouched;
- any converted copy made for an import (a reshaped FHIR export file);
- for every document an agent read: the record set that was imported (the JSON list of resources passed to `ga_import`) and the name of the file it belongs to, so the other server imports the same records with one `ga_import` call per file instead of reading the document again;
- the scripts that built those record sets and the manifest that was shown before importing (found, already stored, repeated, created), so the choices can be checked;
- a note of the decisions made on the way: what was left out and why, and which terms were mapped to which concept (`ga concepts --agent` lists the mappings an agent made).

A record set built against one server leaves out what that server already held. Import the sources in the same order on the other server, or the sets will leave gaps (a result the first server had from the portal export is not in the document's set).

After importing, compare the two servers: record counts by type, `health_summary`, and one detail of each kind (section 7).

`ga share export` writes a FHIR file of a share's records for a recipient. Importing that file into another GA server has not been tested; do not rely on it until someone records the result here.

## Lessons

### 1. A path with a space rejects every record

- **Provenance**: any source imported by `ga import` from a path containing a space. Seen with Apple Health and DICOM; a FHIR export file under a space-free path was unaffected.
- **Data type**: all records of that import.
- **Symptom**: `created: 0`, `invalid` equal to nearly everything, error lines `invalid <Type>/<Type>.meta.source`.
- **Cause**: GA writes the source path into `meta.source`, a FHIR uri, which may not contain whitespace.
- **What to do**: import through a path or link without spaces, then import again; nothing was stored the first time except linked records.
- **Status**: worked around. Open in code (`stamp` in `src/identity.ts`).

### 2. health-skillz files need converting

- **Provenance**: Epic FHIR export made by the health-skillz tool (file named `<timestamp>-health-records.json`).
- **Data type**: the whole file; attachments of DocumentReference and DiagnosticReport.
- **Symptom**: "not a FHIR export", or after unwrapping, every attachment unplaced.
- **Cause**: the file is a list with one object per provider, and each attachment is `{source: {resourceType, resourceId}, originals: [{contentIndex, contentType, contentBase64}]}` where GA wants flat `{resourceType, resourceId, path, contentType, contentBase64}`.
- **What to do**: write a copy with the one provider object unwrapped and each original turned into an attachment whose `path` is `content.<contentIndex>.attachment` (DocumentReference) or `presentedForm.<contentIndex>` (DiagnosticReport). Check that the content type at that index matches before writing, then dry-read the copy and confirm `attachmentsUnplaced` is 0. A file with several providers needs one copy and one import per provider, each with its own FHIR base.
- **Status**: worked around. GA's reader (`src/fhir-export/read.ts`) does not take this layout.

### 3. A blank comment rejects a lab result

- **Provenance**: Epic FHIR export. The same records arriving through Apple Health's Health Records part fail the same way.
- **Data type**: Observation (seen on iron studies) with `note: [{text: " "}]`.
- **Symptom**: `invalid Observation/Observation.note[0].text`.
- **Cause**: a whitespace-only string is not valid FHIR.
- **What to do**: in the converted copy, drop notes whose text is blank (remove `note` when none is left), and import again. Name the rejected results to the person: they are real values.
- **Status**: worked around.

### 4. Echo and ECG measurements are not labs

- **Provenance**: Epic (FHIR export, portal sync, and Health Records on the phone).
- **Data type**: Observation with category `laboratory` plus Epic's section category `Echo` or `ECG`.
- **Symptom**: wall thicknesses, valve gradients and ECG intervals listed among lab results.
- **Cause**: Epic's own labelling.
- **What to do**: nothing at import. `cardiacStudy` (`src/identity.ts`) recognises them; `lab_results`, `whats_new` and shares leave them out of labs, and they are shown with their cardiology report.
- **Status**: fixed in code. Checked for Epic only; another vendor's echo measurements may be labelled differently.

### 5. Most "possible duplicates" from an Epic export are not duplicates

- **Provenance**: Epic FHIR export (one file checked against itself).
- **Data type**: DiagnosticReport, Specimen, vital-sign Observation, Procedure, MedicationRequest.
- **Symptom**: hundreds of `possibleDuplicates` in the report.
- **Cause**: GA flags records of one day that share a name or an instant; Epic legitimately has many (section 5).
- **What to do**: classify the groups by pattern before telling the person anything is duplicated.
- **Status**: open (the flags stay on the records).

### 6. Take unmapped terms from `concepts_to_review`

- **Provenance**: Apple Health import report, for terms that belong to hospital records in its Health Records part.
- **Data type**: Observation, Procedure.
- **Symptom**: `map_concept` answers "no records" for terms the import report listed as unmapped under source `apple-health`.
- **Cause**: those records were already stored under the hospital source; the report lists terms it saw, not terms it stored.
- **What to do**: after an import, call `concepts_to_review` and map from its list, with its `source` and `key`. A mapping made for a term with no records is kept for later imports and shows under agent mappings.
- **Status**: worked around.

### 7. Hospital notes that are also on the phone had no text

- **Provenance**: a hospital DocumentReference (Epic FHIR export or portal) that the Apple Health import linked to its Health Records copy, so it carries the Apple identifier next to the hospital one.
- **Data type**: DocumentReference clinical notes.
- **Symptom**: the note opens with no text; `notes_search` never finds it.
- **Cause**: `noteText` treated any document with the Apple identifier as an Apple ECG file.
- **What to do**: nothing at import. `noteText` (`src/notes.ts`) now leaves out only documents whose sole source identifier is Apple's.
- **Status**: fixed in code. Checked: Apple ECG documents (still left out), source files and archives (still left out).

### 8. A report whose text is only a link

- **Provenance**: Apple Health, Health Records part; and Epic FHIR exports whose tool did not fetch a report's attachment.
- **Data type**: DiagnosticReport `presentedForm` with a `url` at the hospital and no data.
- **Symptom**: an imaging or pathology report with a name and date but no text.
- **Cause**: the source carried the address of the text, not the text.
- **What to do**: before telling the person the text is missing, look in three places. (1) The same exam filed as a note: Epic also sends an imaging or EMG report's narrative and impression as DocumentReferences of kind "Diagnostic imaging study" dated the same day; that was the text of every link-only imaging report checked. (2) The report's results (lesson 13). (3) An older export file of the same hospital, which may hold the attachment a newer file or the phone lacks: compare the files' attachment lists by report id before deciding which to import. Only then say the text is at the hospital. A portal sync of that hospital fetches report text; do not fetch the address yourself.
- **Status**: fixed in code for the chronology page (`record` in `src/ui/detail.ts` shows the imaging note of that day as the report's text and says the match is by date; it warns when several link-only reports share the day). `notes_search` finds the text as a note of kind "Diagnostic imaging study", not under the report's name. The record itself still holds only the link.

### 9. Stored detail that no view showed

- **Provenance**: Epic FHIR export, and the same hospital's records arriving through Apple Health's Health Records part. Expect it of any source: it is a property of the views, found by the check in section 7.
- **Data type**: Immunization (lot, maker, site, route, dose, who gave it); MedicationRequest (directions, instructions to the patient, prescriber, quantity, refills, reason, ingredients); Procedure (who, where, outcome, drugs and materials used); Encounter (reason, who was seen and in which role, where the patient came from and went); lab Observation with a text value or a comparator (`<0.5`, "Negative") and result comments (`note`).
- **Symptom**: a vaccine shown as a name and a date; a medication shown without how to take it; a third of lab results (those without a plain number) shown only as tick marks.
- **Cause**: each view listed the few fields it was written for.
- **What to do**: nothing at import; the data is stored whole. Run the section 7 check and fill the views.
- **Status**: fixed in code. The chronology page (`src/ui/detail.ts`) labels known fields and lists every other readable one. The chat tools: `lab_results` rows carry the lab's `comment`, `current_medications` rows carry `directions`. Vaccine lot and site, procedure operator and encounter particulars are not in a summary tool; `fhir_read` gives the whole record.

### 10. Record types no view reached

- **Provenance**: Epic FHIR export.
- **Data type**: AllergyIntolerance, CarePlan, Goal, CareTeam, ServiceRequest (orders), MedicationDispense (pharmacy fills), Specimen, Coverage; Observation categories `survey` (nursing and fall-risk assessments), `exam`/`smartdata` (exam findings), `social-history`; clinic vital signs other than blood pressure and weight; `summary-document` DocumentReferences.
- **Symptom**: none, which is the problem: the records are imported, counted, and never seen.
- **Cause**: views were built from the common types outward.
- **What to do**: after an import, compare the import report's record types with the types each view reads. On the page, a visit lists everything that names it (`encounter`, `context.encounter`, `focus`), and "All records" lists every kind with its count, whatever its type.
- **Status**: fixed in code for the chronology page (`loadRecords` in `src/ui/timeline.ts`, `contents` and `list` in `src/ui/detail.ts`). Not on the time axis: these have no lane.

### 11. The first code on a vital sign is a generic one

- **Provenance**: Epic (FHIR export; expect the same from portal sync).
- **Data type**: Observation category `vital-signs`.
- **Symptom**: pulse, breathing rate and patient position merged into one series; "3 readings: 68 /min, 12 /min, Sitting".
- **Cause**: Epic lists the generic LOINC "vital signs" code (8716-3) before the specific one (heart rate, respiratory rate). Taking the first LOINC code as the identity of the measure merges them all.
- **What to do**: never take the first code. Skip generic panel codes (8716-3, 85353-1) and use the specific one, else the name. Do not group exam findings by code at all: one code there can cover the left and the right eye; group them by name.
- **Status**: fixed in code (`seriesKey` in `src/ui/timeline.ts`). Checked: lab results (no generic code, unaffected); GA's `vitals` tool matches by concept and by name and was not affected; Apple Health readings are grouped by name.

### 12. Readings written without their unit

- **Provenance**: Epic FHIR export, monitoring during a procedure (anaesthesia record).
- **Data type**: vital-sign Observation (pulse, SpO2, blood pressure readings a few minutes apart).
- **Symptom**: one measure split into two series, one with a unit and one without; many rows sharing one date.
- **Cause**: the monitoring rows carry a value and no unit, while the same measure taken in clinic has one.
- **What to do**: when every stated unit of a series is the same, a reading without a unit takes it; when stated units differ, keep them apart and say so. Show the time, not only the date, when a day has several readings. Never guess a unit for a series that has none.
- **Status**: fixed in code (`seriesDetail` in `src/ui/detail.ts`).

### 13. Where a report keeps its text

- **Provenance**: Epic FHIR export (compare lesson 8 for the Apple Health part, where only a link arrives).
- **Data type**: DiagnosticReport of pathology, microbiology, cardiology and imaging, with the Observations in its `result` and those sharing its order (`basedOn`).
- **Symptom**: a pathology report with a title and no diagnosis; an echo report with numbers and no findings.
- **Cause**: the text is spread over four places: `conclusion`; the attachment in `presentedForm`; long `valueString` results (pathology: clinical history, final diagnosis, gross description, each its own Observation); and echo findings as Observations of category `study-finding` whose content is the list of names in `hasMember`. A view that reads one of them shows a fraction.
- **What to do**: read all four, and show long result text as titled passages of the report, not as rows of a results table. List results the report names but the source did not include.
- **Status**: fixed in code: the chronology page (`record` in `src/ui/detail.ts`) and `notes_search` (`reportText` and the text-result rows in `src/notes.ts`), which now searches conclusions (written, or as named diagnoses in `conclusionCode`), report attachments, text results of 80 characters or more, and study findings, joined to their report through the shared order so an echo is one row. Checked: a finding with no order stays its own row; two Observation readings of one search are cached apart.

### 14. An older export imported after a newer one overwrites it

- **Provenance**: two Epic FHIR export files of the same hospital, neither with `meta.lastUpdated` (health-skillz files and files in GA's own export layout made from them).
- **Data type**: every record both files hold. Seen on MedicationRequest (8 orders went from `stopped` back to `active`, 5 lost changed directions), DocumentReference (15 notes lost their inline text for a link), Encounter and Observation names.
- **Symptom**: `updated` in the hundreds on a file expected to add only what was missing; medications the hospital had stopped listed as active again.
- **Cause**: a copy without an update date fills only onto a record that *another kind of source* wrote. Onto a record written by an earlier FHIR export it replaces, and with no dates to compare, the file imported last wins.
- **What to do**: import a hospital's export files oldest first. If an older file was imported last, import the newest file again: it restores every shared record (checked field by field against a snapshot: no clinical value and no note text differed afterwards), and records only the older file has stay. Never tell the person an export "only fills gaps" without checking which source wrote the records it will meet.
- **Status**: worked around (order of import). Open in code: `fillOnly` in `src/engine.ts` cannot tell an older export from a newer one; a file's newest clinical date could decide.

### 15. The same note under two ids

- **Provenance**: two Epic FHIR exports of one hospital taken months apart.
- **Data type**: DocumentReference clinical notes around procedures (sedation, anaesthesia, procedure, discharge instructions, operative notes).
- **Symptom**: 24 of 26 "new" notes from the second file were already stored: same day, kind and text, different id. GA created them and flagged each `possible-duplicate`.
- **Cause**: Epic issues a new DocumentReference id for a revision of a note (it names the other in its `clinical-note-other-revision` extension), and the two exports each returned a different one. Matching by identifier cannot join them.
- **What to do**: after importing a second file of a hospital, compare the text of each new note with the notes of the same day and kind. Identical text is the same note; report the count. GA has no delete or merge: both stay stored. Here the `possible-duplicate` flag was right (compare lesson 5, where it mostly is not): judge by content, not by the flag alone.
- **Status**: worked around at presentation: the chronology page draws such a note once (`buildTimeline` in `src/ui/timeline.ts`) and `notes_search` returns it once (`notesSearch` in `src/notes.ts`). Two such notes had a malformed revision extension and were rejected as `invalid`; both texts were already stored.

### 16. One export has the report text another lacks

- **Provenance**: Epic FHIR exports of one hospital made by different tool versions; Apple Health's Health Records part.
- **Data type**: DiagnosticReport (imaging, EMG, endoscopy) and the Observations named Narrative and Impression that carry its text.
- **Symptom**: a report stored with only a link (lesson 8) although an older export file on disk held its text.
- **Cause**: the older file carried each report's text as results (`valueString` of an Observation named Narrative or Impression, ordered under the report's name). The stored report, first written from Apple's copy, names those results by `display` only and was not rewritten, so the text arrives as new Observations that nothing links to the report.
- **What to do**: before importing, list for each file which reports have an attachment or text results, by report id; a file that is older overall can still be the only one with a given text. After importing, join text results to a link-only report by day and order name, and say the join was made that way. An endoscopy report that a Procedure names in `report` belongs with that procedure, not among imaging studies.
- **Status**: fixed in code for the chronology page (`record` in `src/ui/detail.ts`; `buildTimeline` folds a procedure's report into the procedure). `notes_search` finds the text as "report text: Narrative (<order>)".

### 17. A reference range without a plain number rejects the lab result

- **Provenance**: Epic portal C-CDA download (seen at two hospitals' Epic portals). Not checked: C-CDA from other vendors; Epic FHIR exports carry ranges differently and were unaffected.
- **Data type**: lab Observation with a `referenceRange`.
- **Symptom**: `invalid Observation/Observation.referenceRange[0]` on the error stream, 7 to 47 per hospital folder; the results missing were ordinary ones (WBC, platelets, AST, ALT, TSH, eGFR, tissue transglutaminase).
- **Cause**: Epic writes a range bound three ways the converter did not read: a unit that is not UCUM as `nullFlavor="OTH"` with the number in `translation/@value` and the unit in `originalText` ("38 - 234 IU/L"); an open bound as `nullFlavor="NINF"` or `"PINF"` ("<5 mcg/dL"); a range that is only text ("Negative", a growth-chart name). Each became a quantity without a number, or a range with no low, high or text, which FHIR forbids, and the whole result was rejected.
- **What to do**: nothing at import now. If the message appears again, convert the folder without storing and list the range shapes that fail before touching the data.
- **Status**: fixed in code (`mapIntervalBound`, `mapReferenceRange` in `vendor/medplum-ccda/ccda-to-fhir.ts`, PATCHES row 57; the range as written is now also kept in `referenceRange.text`). Checked after the fix: all four folders convert with no invalid range.

### 18. Results below or above a limit were dropped

- **Provenance**: Epic portal C-CDA download (the same two hospitals' portals).
- **Data type**: lab Observation whose value is an interval (`IVL_PQ`, `IVL_REAL`): "<0.2 mg/dL", ">90".
- **Symptom**: `notImported` rows "IVL_PQ value not converted" and "IVL_REAL value not converted" under Results (4 to 16 per folder); the result was stored with no value.
- **Cause**: the converter read only single numbers.
- **What to do**: nothing at import now. A `notImported` reason ending "value not converted" always names a real result: find which.
- **Status**: fixed in code (`mapIntervalValue`, same file and PATCHES row): one bound becomes a value with a comparator (`<`, `<=`, `>`, `>=`), two a range. `lab_results` and the chronology page already show comparators (lesson 9).

### 19. Pathology text arrives as encoded RTF

- **Provenance**: Epic portal C-CDA download; seen at one of two hospitals, the other's export had none.
- **Data type**: Observation results of a surgical pathology report: Final Diagnosis, Clinical Information, Gross Description, Disclaimer, Note.
- **Symptom**: `Unhandled observation value type: ED (text/rtf, B64)` on the error stream and "ED value not converted" in `notImported`; the pathology report had a title and no diagnosis.
- **Cause**: the text is carried only as base64 RTF in the value. After decoding, 3 gross descriptions were still rejected (`invalid Observation/Observation.value[x]`): they held a no-break space or a control character, which a FHIR string may not.
- **What to do**: nothing at import now. Read one stored Final Diagnosis after an import to confirm it is text (section 7, step 5).
- **Status**: fixed in code (`rtfToText` option of the converter, given GA's reader in `convertCcdaLocal`, `src/ccda.ts`; PATCHES row 58). Compare lesson 13: the same reports from an Epic FHIR export carry this text as `valueString`.

### 20. Two exports with the same file names hide unmapped terms

- **Provenance**: two C-CDA folders imported into one record whose files share names. Every Epic portal download names its files `DOC0001.XML` onwards, so any two hospitals do.
- **Data type**: Observation, Procedure and MedicationStatement terms awaiting a standard code.
- **Symptom**: `concepts_to_review` returned nothing (or a handful) while over a hundred records carried the `concept-unmapped` tag, and `map_concept` answered "no records" for terms the import report listed.
- **Cause**: a C-CDA record does not store its hospital. The review finds it through the stored source file with the same file name as the record's `meta.source`; with two stored files of that name from different hospitals it gave up and skipped the record.
- **What to do**: after importing a second C-CDA folder, compare the number of terms `concepts_to_review` lists with the count of records tagged `concept-unmapped`. A large gap means records are being skipped.
- **Status**: fixed in code while the source file is still at the path it was imported from (`sourceResolver` in `src/concepts-cli.ts` picks the stored file with the same content). Open when the file has moved or the review runs where that path does not exist (the gateway container, a chat app): those records are skipped as before. Storing the hospital, or the file's hash, on each record would close it.

### 21. One download bundle, several people

- **Provenance**: a zip of portal downloads collected by a family (one folder per person, each with two hospitals' C-CDA folders and PDFs).
- **Data type**: all.
- **Symptom**: none at import: GA would have loaded both people into one record without complaint.
- **Cause**: `ga import` attaches every document to the install's one patient; it compares the name only to log a difference.
- **What to do**: before importing, read `recordTarget` (name and birth year) in every document of every folder and confirm one person per folder. Give each person their own GA install (docs/operations.md, "A second person"), and import each folder into the right one by checking the install's address in `.ga/config.json` first.
- **Status**: worked around (procedure). Open in code: an import whose patient name and birth date both differ from the record's could refuse.

### 22. A hospital's "full record" PDF is mostly what the portal export already gave

- **Provenance**: Epic release-of-information PDF ("full record", hundreds to thousands of pages, one block per encounter with sections such as Clinical Notes, Labs, Imaging, Medication Administrations, Flowsheets, Messages), imported after the same hospital's portal C-CDA. Seen at one hospital.
- **Data type**: lab Observation, DiagnosticReport, DocumentReference notes, vital-sign Observation, MedicationAdministration, Communication.
- **Symptom**: none if imported blindly: thousands of duplicate records. Measured on a 631-page record: all 36 lab values, 20 of 21 imaging entries and 24 of 41 notes were already stored or were preliminary copies; what was new was 1 imaging report, 13 doses given, 15 notes (14 of them telephone notes), 71 portal messages and about 150 nursing vital signs.
- **Cause**: the PDF prints the whole chart, including every preliminary and in-process version of a result, the same message under several encounters, and per-visit copies of the medication, problem and allergy lists.
- **What to do**: never extract such a PDF page by page. Take its text (`pdftotext -layout`), split it by encounter and section, parse each section by its own layout, and build a manifest before writing anything: per kind, how many were found, how many are already stored, how many are repeats, how many would be created. Compare each candidate with the stored record (labs by test, value and the collected-to-resulted days, because the portal export dates some results by when they were resulted; vitals by kind, minute and value; notes and report text by their lines). Reconcile each parser against a raw count of the rows in the text before importing: a table header printed in a variant form ("Action / Reason", "Dose / Rate", "Route / Site") silently hides its rows. Leave out administrative sections (visit information, document lists, communication tracking, treatment team) and sections that repeat stored lists (medication list, orders, ED timeline, after-visit summary). Show the manifest to the person, take a backup, then import in one call.
- **Status**: worked around (procedure; the scripts used are kept with the person's source files, not in GA). Open in code: GA has no reader for this layout.

### 23. Table cells must be split on spacing, not at fixed columns

- **Provenance**: text of an Epic release-of-information PDF taken with `pdftotext -layout`.
- **Data type**: lab Observation from a component table; any value read from a table.
- **Symptom**: three lab values that were not in the record, each a single digit, each with a reference range missing its first digit (a range printed "22 - 30" read as "2 - 30").
- **Cause**: one page printed the table one character to the left of its header, so cutting each line at the header's column positions split the range and moved its first digit into the value column in place of the real value. The real values were already stored.
- **What to do**: split a table line on runs of two or more spaces and assign each cell to the nearest column; require every row to have its flag cell; check each value's shape (a number, a comparator and a number, or a known word) and reject the row otherwise. Treat any "new" value from a source the record already covers as a parsing error until shown otherwise: here the duplicate check found the mistake, because a wrong value does not match the stored one.
- **Status**: worked around (in the scripts). The mistake was caught before any import.

### 24. An import that turns out incomplete is undone by restoring, not patched

- **Provenance**: any PDF imported through `ga_import` (a file is imported once; GA has no delete).
- **Data type**: all records of that import.
- **Symptom**: after an import, a corrected parser found 4 more medication administrations in the same PDF; a second import of the file is refused.
- **Cause**: see lesson 22 (a table header variant).
- **What to do**: take a backup immediately before every PDF import (`docker compose run --rm -e RUN_ONCE=1 ga-backup`). If the import proves wrong or incomplete, restore that backup (docs/operations.md, "Restore"; also empty the stored-files volume before unpacking it and flush the FHIR server's cache, `docker compose exec redis redis-cli -a medplum FLUSHALL`, while the server is stopped), check the counts are back, and import again.
- **Status**: worked around (procedure).

### 25. Scanned pages: one text engine is not enough

- **Provenance**: a hospital's archive of an older record system printed as page images (seen: a "patient section" PDF from a hospital's previous record system, scans at about 195 dpi), read with Apple Vision and Tesseract.
- **Data type**: DocumentReference notes (ED visit notes, discharge summaries, clinic visits), DiagnosticReport (an ECG).
- **Symptom**: Apple Vision read the first digit of one temperature wrongly (a 3 as a 5), put a spurious leading 1 on another, turned a dense line into nonsense, and dropped three lines from the middle of a paragraph without any sign; Tesseract on the whole page merged the side column into the body text and clipped the first digit of values next to a table border (a temperature and a respiratory rate each lost their leading digit).
- **Cause**: small print, two-column pages and table borders; each engine fails differently, and neither reports low confidence.
- **What to do**: (1) such a PDF prints each document twice, once in small print and once in large print: take the text from the large-print copy and keep the other as a check, never import both. (2) Read each column of a page separately with Tesseract and use that as the text; use Apple Vision and the other copy as second readings. (3) Compare line by line in both directions (lines one reading lacks; numbers one reading lacks) and read every line without a second reading from the page image yourself. (4) Replace every vital-sign table by your own reading of the image: table borders defeat both engines. (5) A table that cannot be read reliably (a discharge medication table with wrapped cells) is left out with a line saying so, never stored half right. (6) Remove account numbers, the patient's address and billing lines from the note text; leave out consent forms, privacy notices and printed education handouts.
- **Status**: worked around (procedure; scripts kept with the person's source files).

### 26. Check that a verification query really filters

- **Provenance**: any import, at the step "check that every detail can be retrieved" (section 7).
- **Data type**: notes, messages and report text found through `notes_search`.
- **Symptom**: a search for a word from a newly imported note "found" rows, so the import was reported searchable; the rows were only the newest notes.
- **Cause**: the tool's parameter is `text`; a call with another name (`query`) is not refused, it returns the newest rows unfiltered.
- **What to do**: verify with a word that occurs only in the new record and confirm the returned row is that record (its date and kind), not merely that rows came back.
- **Status**: worked around (procedure). Open in code: an unknown parameter could be refused.

