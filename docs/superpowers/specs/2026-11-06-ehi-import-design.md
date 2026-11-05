# GA Milestone 2a: Epic EHI Export Import — Design

Builds on `docs/superpowers/specs/2026-11-05-ga-server-design.md` (milestone 1, shipped). Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first.

## Intent

"All of my health data that exists on earth in one place, no matter where it is or what format it is." **[user]** Epic's EHI export (the full Electronic Health Information export Epic must provide under the Cures Act) is the most complete copy of what one health system holds about the user. Milestone 1 imported Epic's C-CDA summaries, which leave out notes, messages, scanned documents, family history and much of the history tables. This milestone brings in everything else from the EHI export without duplicating what is already in GA.

**Success test [user]:** in Claude Code, `/ga Did I miss any vaccinations for my age?` gets a complete, cited answer: the full immunization history (EHI plus the C-CDA summaries plus the 2024 Korean checkup's hepatitis immunity), Epic's own health-maintenance status, and gaps against the current adult schedule.

## Goals, non-goals, anti-goals

**Goals**
- Nothing is lost: the whole EHI export is kept, linked to the patient. **[user]**
- Clinically meaningful tables become FHIR resources agents can search. **[user, scope as below is a call]**
- MyChart messages with the care team are readable by agents, like notes. **[user]**
- Clinical notes and media (PDF, TIF, JPG, HTML) are stored as documents agents can read.
- Dedup holds across sources: a lab, immunization, diagnosis, medication or visit present in both the C-CDA summaries and EHI ends up as one GA record listing both sources. Re-importing EHI is a no-op.

**Non-goals (this milestone)**
- Apple Health (next milestone, 2b). **[call]**
- Mapping billing, claims, insurance, scheduling, audit or other administrative tables to FHIR. They stay in the archive only. **[user]**
- Mapping all 570 non-empty tables. Map the clinical set below and archive the rest.
- Free-text understanding of notes and messages (summaries, extracted findings). Agents read them on demand.

**Anti-goals** (carried from milestone 1)
- No silent merges: an uncertain cross-source match is flagged `possible-duplicate`, never merged.
- No PHI in the repo: fixtures are synthetic; real-data tests read paths from `GA_REAL_DATA` and print counts only.
- Nothing leaves the machine: the importer makes no network calls except to the local Medplum and converter.
- No invented codes. A value without a standard code is stored by name (`code.text`), as with PDF extraction.

## What's in the export (recon of the user's file, counts only)

`ehi-export/`: 5,531 TSV tables (570 non-empty), `EHITables Schema/*.htm` (one page per table), `Rich Text/` (39 RTF notes), `Media/` (34 files: 25 PDF, 2 TIF, 1 JPG, 6 HTML), `readme.PDF`.

## Mapping [call; builder may refine]

| EHI source | FHIR | Key → GA identifier (`urn:ga-server:id:ehi:<org>`, value `<TABLE>|<pk>`) |
|---|---|---|
| `ORDER_RESULTS` (85) + `ORDER_PROC` (67) | `Observation` (LOINC when the component carries one, else `code.text` = `COMPONENT_ID_NAME`), `DiagnosticReport` per order | `ORDER_RESULTS|<ORDER_PROC_ID>-<LINE>`; `ORDER_PROC|<ORDER_PROC_ID>` |
| `IMM_ADMIN` (166) + `IMM_ADMIN_COMPONENTS` | `Immunization` (CVX when available, else `vaccineCode.text`) | `IMM_ADMIN|<DOCUMENT_ID>-<LINE>` |
| `PAT_ENC` (62) | `Encounter` | `PAT_ENC|<PAT_ENC_CSN_ID>` |
| `PAT_ENC_DX` (77) | `Condition` category `encounter-diagnosis` | `PAT_ENC_DX|<CSN>-<LINE>` |
| `PROBLEM_LIST` (6) | `Condition` category `problem-list-item` (status from `PROBLEM_STATUS_C_NAME`, `RESOLVED_DATE`) | `PROBLEM_LIST|<PROBLEM_LIST_ID>` |
| `ORDER_MED` (3) | `MedicationRequest` (name from `MEDICATION_ID_MEDICATION_NAME`) | `ORDER_MED|<ORDER_MED_ID>` |
| `FAMILY_HX` (72) | `FamilyMemberHistory` (relation, condition, age of onset) | `FAMILY_HX|<CSN>-<LINE>` |
| `IP_FLWSHT_MEAS` (99) / `V_EHI_FLO_MEAS_VALUE` | vital-signs `Observation` (LOINC for the standard vitals, else by name) | `IP_FLWSHT_MEAS|<FSD_ID>-<LINE>` |
| `HM_HISTORY` (124) + `HM_HISTORICAL_STATUS` | `Observation` "health maintenance topic status" by name (or `Procedure` for completions) | `HM_HISTORY|<LINE>` |
| `SOCIAL_HX` (6), `SOCIAL_ADL_HX` | smoking/alcohol `Observation` (LOINC 72166-2 etc.) | per row |
| `V_EHI_HQA_QUEST_ANSWER` (126) | `QuestionnaireResponse` per questionnaire | per answer set |
| `HNO_INFO` (79) + `Rich Text/*.RTF` | `DocumentReference` (note type, date, author; RTF content plus extracted plain text) | `HNO_INFO|<NOTE_ID>` |
| `MYC_MESG` (35) + `MYC_MESG_RTF_TEXT` / `MSG_TXT` | `Communication` (sent, sender, recipient, subject, payload text, thread via `PARENT_MESSAGE_ID`) **[user: readable]** | `MYC_MESG|<MESSAGE_ID>` |
| `Media/*` | `DocumentReference` with the file as Binary | file hash, as in milestone 1 |
| Whole export folder | one `DocumentReference` (zip of the folder, stored once by hash) | file hash |
| Everything else | archive only | — |

- **Org discriminator [call]:** `<org>` identifies the Epic organization the export came from (taken from the export itself; **[check]** which field, e.g. the instance OID in identifiers or the readme). A second Epic hospital's export can't collide with the first. Decided now because changing the identifier system later would break the re-import no-op for loaded data.
- **Source info [call]:** `SourceInfo.kind` gains `ehi`. Every EHI resource's source date is the export's creation date (**[check]** from the readme or folder metadata). A later, newer export updates records, and the same export re-imported is a no-op.
- **Medications [call]:** `ORDER_MED` stays `MedicationRequest`, linked by Epic order ID to C-CDA MedicationRequests where they match. The `/ga` skill and `AGENTS.md` define current medications as active MedicationStatements plus active MedicationRequests.
- The tables join on `PAT_ENC_CSN_ID` (encounter), `ORDER_PROC_ID` and `NOTE_ID`/`MESSAGE_ID`. Resources reference their Encounter where a CSN is present.
- Allowed resource types grow to include `FamilyMemberHistory`, `Communication` and `QuestionnaireResponse` in the write path. They are written by the importer, not by `ga_import`.
- **[check]** RTF note files are named `HNO_<NOTE_ID>_...`. Confirm the link from note record to file, and pick a plain-text extraction for RTF. Use an existing dependency if one fits; otherwise a minimal stripper is acceptable, with a test.
- **[check]** Whether `ORDER_RESULTS` components carry LOINC anywhere (`OBS_MTHD_ID`, component tables). If not, results are stored by name, and C-CDA linking (below) brings in the LOINC code from the matching C-CDA record.

## Dedup with milestone-1 data

- **Same order, two sources:** 19 of 24 EHI result orders appear verbatim as C-CDA entry identifiers (recon). An EHI result whose `ORDER_PROC_ID` matches a C-CDA Observation/DiagnosticReport identifier, and whose component and value match, merges into the existing record. The record gains the EHI identifier and keeps the C-CDA body (C-CDA came first and carries LOINC). A component match with a different value is flagged `possible-duplicate`. **[call]**
- **Everything else** goes through the existing engine: stable EHI identifiers make re-imports no-ops, and Observations use the content key with exact effective time. **[check]** EHI times (`RESULT_DATE`, `CONTACT_DATE`) may be local dates or datetimes without a zone. Normalize them the same way the C-CDA dates are, or exact-time matching will flag where it should merge. Count merges and flags on real data.
- **Identifier linking for every type [call]:** importers attach the Epic-native identifiers they know (order ID, CSN, problem list ID, immunization ID) as link identifiers. The engine looks up an existing record by its stable GA identifier first, then by any link identifier, for all resource types, not only Observations. Once linked, the normal `decide` rules apply: **the newer source's version wins** (so a problem EHI shows as resolved doesn't stay active from an older summary), an equal or older source only adds its identifier, and records a person or agent edited are protected as today. Old versions stay in history. **[check]** Measure the overlap per type (counts only). Where IDs don't overlap, a content key flags rather than merges.
- The single GA Patient absorbs the EHI patient identifiers and demographics, as in milestone 1.

## Vaccination gaps: shipped schedule plus tested tool [user]

- `data/` is gitignored for PHI, so the schedule lives at `src/schedules/cdc-adult-immunization-<year>.json`. It is a maintained, versioned copy of the CDC adult immunization schedule: per vaccine, age and sex applicability, dose count and spacing, and "immune if" evidence such as hepatitis A or B antibody positive. It records the CDC edition and URL it was transcribed from. Medical-condition branches (pregnancy, immunocompromise, etc.) are out of scope for v1 and are listed in the file as not evaluated. **[call]**
- New MCP tool `vaccine_gaps`, with the same pattern as `risk_score`: it reads the patient's Immunization records, immunity Observations and birth date/sex from GA itself, so values don't pass through the agent. It returns per vaccine: status (`complete` / `due` / `overdue` / `not-recommended` / `immune` / `not-evaluated`), the GA records it used (date, source), and the schedule edition. **[call: tool reads GA directly rather than taking inputs]**
- Vaccine matching uses CVX codes, with a name-based fallback table for records stored by name only. Unmatched records are listed, never guessed. **[call]**
- Tests: synthetic histories with expected per-vaccine status, written from the schedule's own rules, including an "immune by serology" case and an "unmatched name" case.
- Updating the schedule is a manual, reviewed change: a new JSON file per CDC edition. The tool uses the newest file and reports which edition it used.
- Epic's health-maintenance status (`HM_HISTORY`) is shown alongside the tool's result, as a second opinion, not as the source of truth. **[check]** Whether the export carries current due/overdue status or only completion history.

## Interfaces

- CLI: `ga import <ehi-folder>` detects an EHI export (presence of `EHITables/`) and runs the EHI importer. Existing C-CDA and PDF paths are unchanged.
- MCP: one new tool, `vaccine_gaps` (above). `fhir_search`/`fhir_read` cover the new types. Update the `/ga` skill and `AGENTS.md` with where notes, messages, family history and health-maintenance status live.

## Acceptance

1. Import the user's EHI export twice. The second report is `created:0 updated:0`, and exactly one Patient remains.
2. Per-type counts (counts only) match the source tables, minus documented skips. Every skip is counted with a reason.
3. Of the 19 linked orders, their results are not duplicated. Each merged record lists both a C-CDA and an EHI identifier.
4. The archive DocumentReference exists, and its Binary unpacks to the original folder (compare file count and total size).
5. `fhir_search` finds Communications (messages) and note DocumentReferences with readable text.
6. `vaccine_gaps` passes its synthetic tests. On real data, `/ga Did I miss any vaccinations for my age?` calls it and lists the immunization history with sources, Epic health-maintenance status, and gaps. Checked manually by the user.
7. Unit tests on synthetic EHI-shaped fixtures cover each mapper, the order-ID merge, and the RTF text extraction.

## Left to the builder

- Exact FHIR shapes and code systems per mapper, within the table above.
- Archive format (zip vs tar). Use what Node or an installed dependency provides.
- Order of mappers and how the importer is split into files (follow `src/ccda.ts` conventions).
- How to surface `HM_HISTORY` (Observation vs Procedure), whichever answers the vaccination question cleanly.
