# Automatic concept mapping — Design

Builds on the concept layer (docs/superpowers/specs/2026-11-07-concept-layer-design.md). Legend: **[user]** decided by the user, **[call]** designer's call.

## Intent

Today an uncoded term (mostly from PDFs and Apple Health) waits in a review list until an agent maps it with `map_concept`, and the agent has to find the code itself. GA can only check LOINC, RxNorm and CVX codes. When the agent cannot find or check a code, the work falls to the person. "Manually search SNOMED CT and CPT every time would never work with non-clinical/technical users." **[user]**

Goal: the person never sees or looks up a code. GA finds candidates itself, maps exact matches on its own, hands the agent a short list for the rest, and asks the person only a plain-language question, and only when the choice changes an answer they asked for.

**Success test [call]:**
- After any import, a term whose name exactly matches one standard code is mapped with no agent and no person.
- Every term left over reaches the agent with ranked candidates (`ga_import`'s `unmapped`, `concepts_to_review`), so the agent maps it without searching.
- A procedure is mapped to SNOMED CT, and GA checks the code exists.
- When the terminology services are down or turned off, imports and mapping behave as today.

## Decisions

1. **GA searches [user].** A new module queries free public services by term name:
   - LOINC: NLM Clinical Tables (`clinicaltables.nlm.nih.gov/api/loinc_items/v3/search`).
   - RxNorm: NLM RxNav (`rxnav.nlm.nih.gov/REST/approximateTerm.json`, then `rxcui/<id>/properties.json` for the name).
   - SNOMED CT: HL7's public terminology server (`tx.fhir.org/r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs&filter=…`).
   - ICD-10-CM: NLM Clinical Tables (`api/icd10cm/v3/search`).

   Only the term's name goes out, never values, dates, units, ids or the source's name. CVX stays on GA's shipped table.
2. **Check SNOMED CT and ICD-10-CM too [call].** `validate` adds SNOMED CT (`tx.fhir.org/r4/CodeSystem/$lookup`) and ICD-10-CM (Clinical Tables, exact code) to LOINC and RxNorm. CPT and HCPCS stay unchecked.
3. **Procedures map to SNOMED CT, not CPT [user].** CPT is licensed by the AMA and cannot be searched or checked freely; it is a billing code. `map_concept` refuses a CPT target from an agent. A CPT code the source itself sent is kept, as today.
4. **A broader code is a good answer [user].** When the source lacks a detail the precise code needs (which finger, which machine), the agent maps to the closest broader concept with `equivalence: "wider"`. Records group correctly; no one is asked.
5. **Reuse a code the record already has [user, narrowed by call].** When the deduplication engine has already linked an uncoded record to another record (`possible-duplicate` with `DUP_OF`) that carries a trusted standard code (its source's own code, or a confident GA mapping), that code is the first candidate, marked `from: "linked record"`. No new matching heuristic: a guessed "same thing on the same day" match could pair different procedures.
6. **Map right after import [user].** After every import (CLI `ga import`, import jobs, `ga_import`, portal sync) and in `ga concepts apply`, GA runs automatic mapping over the terms the import left unmapped:
   - **Exactly one candidate whose name equals the term** (case, punctuation and spacing ignored), from the type's first vocabulary: mapped as `equivalent`, `confident: true`, by GA (Provenance agent "GA (automatic)"). Because LOINC long names never read like lab report names, labs in practice always go to the agent.
   - **Otherwise:** the term stays unmapped, and its candidates (up to 5, plus the linked-record code) go back with it.
   - Only terms with no map entry are touched; an agent's or source's mapping is never replaced.
   - At most 50 terms per run [call], 4 requests at a time, 10-second timeout each. A failure leaves that term unmapped with no candidates, and never fails the import.
7. **Questions only when they matter [user].** Agents never show codes. They pick from the candidates themselves (broader when unsure, `confident: false` when it is a judgment call). They ask the person only when two candidates would give a different answer to something the person asked (which test a result belongs to, whether a screening was done), and then in plain words, e.g. "Was this a colonoscopy or a sigmoidoscopy?" `concepts_to_review` becomes an audit trail, not a to-do list.
8. **An off switch [call].** `"terminologyLookup": false` in `.ga/config.json` turns off searching and automatic mapping (no term name leaves the machine). Code checks keep working as today (only the code goes out).

## Interfaces

- `searchCodes(system, term, deps?) → Candidate[]` where `Candidate = { system, code, display, from?: 'linked record' }`. An empty list on failure.
- `ga_import`'s report: `unmapped` rows gain `candidates`, and the report gains `autoMapped` (the number of terms GA mapped itself).
- `concepts_to_review` rows (status `unmapped` or `suggested`) gain `candidates` for the 25 most frequent terms.
- The portal-sync and CLI import reports gain `autoMapped`.

## Non-goals

- No bundled terminology files (licensing, size). No CPT support beyond codes sources send. No new matching between records across sources (decision 5). No change to how codes are applied, learned from sources, or shown ("possibly …").
