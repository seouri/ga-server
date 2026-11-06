---
name: ga
description: Answer a question about the user's own health strictly from their GA (Guardian Angel) record, with citations. Use when the user types /ga or asks to "check GA" or "use my records".
argument-hint: "<question about your health>"
allowed-tools: mcp__ga-server__fhir_search mcp__ga-server__fhir_read mcp__ga-server__cardiovascular_risk_10yr mcp__ga-server__vaccine_gaps
---

Answer the question from the user's GA record. If no question was given, ask for one.

0. **Check hospital portal sync first.** `fhir_search` `Endpoint` with `identifier=urn:ga-server:id:smart-source|`. A source is stale if its `status` is `off` or `error`, or its `urn:ga-server:ext:smart-last-success` is missing or older than 48 hours. If any is stale, start the answer with one line naming it, its last success and the fix, e.g. "Hospital A needs login (last synced Nov 2): run `ga connect <its address>`" when `off`, or `ga sync` when `error`. Error `disconnected` means the user disconnected it on purpose: say so instead of asking them to log in. Error `not_enabled` means it is connected but no record types are enabled yet, so GA holds nothing from it: the fix is `ga sync --enable <Type,...> <source>` after checking the dry-run counts. No Endpoints: say nothing.
1. **Find the records.** Use `fhir_search` with `_sort` (usually `-date`), `_elements` to keep results small, and `_count` as needed. Prefer LOINC codes for labs and vitals, and also try `code:text` because values from PDFs may be stored by name only. Use `fhir_read` to resolve references, e.g. a MedicationStatement's Medication for the drug name.
2. **Use only what GA holds.** If something needed is not in GA, say it is missing; don't fill it in from general knowledge or assumptions. General medical knowledge is fine for interpreting the records, not for supplying values.
3. **Cite every value:** date, value with unit, and source file name (from `meta.source`, file name only).
4. **Keep GA's caveats visible:**
   - `extracted-by-llm` tag: the value was read from a document by an agent; say so.
   - `possible-duplicate` tag: two records may be the same result; mention both.
   - Problems: `category` `problem-list-item` is the problem list; `encounter-diagnosis` is what was coded at a visit, not a standing problem.
   - Medications (also problems, allergies): with `urn:ga-server:ext:last-seen`, current only if `active` and `last-seen` equals the `urn:ga-server:ext:smart-last-success` of the Endpoint whose identifier value is the `<key>` of the record's `urn:ga-server:id:smart:<key>` identifier (any of them, if it has several); otherwise unconfirmed (the portal stopped returning it). Without `last-seen`: an `active` one whose source date (`urn:ga-server:ext:source-date`) is older than the newest Epic import (C-CDA, EHI or portal sync) is unconfirmed.
5. **Epic EHI data:** notes are DocumentReference (`text/plain` attachment; RTF original linked via `relatesTo`); MyChart messages are Communication (`payload`, `sent`, `inResponseTo` thread); family history is FamilyMemberHistory; Epic health maintenance is Observation `Health maintenance: <topic>` (Epic's status at export time) plus Procedure completions. Current medications = `active` MedicationStatement plus `active` MedicationRequest, confirmed by the rule in step 4.
6. **Apple Health data:** see "Apple Health data" in `AGENTS.md` (daily means/totals are summaries, home vs clinic readings are both real).
7. **Vaccinations:** call `vaccine_gaps` (optional `asOf`); never judge the schedule yourself. Report its schedule edition, statuses, records used, unmatched and possible-duplicate records. Show Epic health maintenance as a second opinion, dated as of the export.
8. **Risk scores:** for cardiovascular risk, gather the inputs from GA and call `cardiovascular_risk_10yr`. Never compute PREVENT or PCE yourself. List which inputs came from which record and which you had to assume (for example race, or diabetes inferred from A1c).
9. **Answer briefly:** the direct answer first, then the evidence, then what's missing that would change it. For decisions, frame it as input for a conversation with their clinician.
10. **Requests to share** ("share my labs from the last 2 years with Dr. Kim for a week"): build the `ga share` command (`--for doctor|family`, `--label`, `--scope` from labs, vitals, medications, problems, allergies, immunizations, visits, notes, procedures, family, messages, apple, or `all`, `--since`, `--until`, `--expires`). Show the parsed audience, scope, dates and expiry, and run it only after the user confirms: a share sends their records out. Then relay the link. Shares are CLI only; there is no MCP tool for them.
