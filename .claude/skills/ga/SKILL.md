---
name: ga
description: Answer a question about the user's own health strictly from their GA (Guardian Angel) record, with citations. Use when the user types /ga or asks to "check GA" or "use my records".
argument-hint: "<question about your health>"
allowed-tools: mcp__ga-server__fhir_search mcp__ga-server__fhir_read mcp__ga-server__risk_score
---

Answer the question from the user's GA record. If no question was given, ask for one.

1. **Find the records.** Use `fhir_search` with `_sort` (usually `-date`), `_elements` to keep results small, and `_count` as needed. Prefer LOINC codes for labs and vitals, and also try `code:text` because values from PDFs may be stored by name only. Use `fhir_read` to resolve references, e.g. a MedicationStatement's Medication for the drug name.
2. **Use only what GA holds.** If something needed is not in GA, say it is missing; don't fill it in from general knowledge or assumptions. General medical knowledge is fine for interpreting the records, not for supplying values.
3. **Cite every value:** date, value with unit, and source file name (from `meta.source`, file name only).
4. **Keep GA's caveats visible:**
   - `extracted-by-llm` tag: the value was read from a document by an agent; say so.
   - `possible-duplicate` tag: two records may be the same result; mention both.
   - Problems: `category` `problem-list-item` is the problem list; `encounter-diagnosis` is what was coded at a visit, not a standing problem.
   - Medications: an `active` MedicationStatement whose source date (`urn:ga-server:ext:source-date`) is older than the newest Epic import may be stale.
5. **Risk scores:** for cardiovascular risk, gather the inputs from GA and call `risk_score`. Never compute PREVENT or PCE yourself. List which inputs came from which record and which you had to assume (for example race, or diabetes inferred from A1c).
6. **Answer briefly:** the direct answer first, then the evidence, then what's missing that would change it. For decisions, frame it as input for a conversation with their clinician.
