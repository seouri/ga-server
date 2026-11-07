# GA Concept Layer — Design

Builds on milestones 1–6 (all shipped). Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first.

## Intent

The same clinical thing arrives under different names from different sources. LDL is "LOW DENSITY LIPOPROTEIN CHOL" with LOINC 13457-7 from the hospital, and "LDL cholesterol" with no code from a PDF. Tools that match by name miss results, and hand-made pattern lists produce false matches: urine glucose counted as blood glucose, TSH receptor antibody counted as TSH, LDL particle count counted as LDL, two race-based eGFR codes counted as one test.

"LDL-like issues will be frequently happening. There should be a key component. As important as the deduplication engine." **[user]**

The concept layer gives every record a standard code, so every tool and rule asks for a concept rather than a name. It comes before proactive health maintenance (milestone 7), whose screening rules need to know "has this person had a colonoscopy" across every source. **[user: order agreed]**

**Success test [call]:**
- "ldl" and the LDL key lab find all 6 of the user's LDL results (5 hospital, 1 PDF) through concepts, with no name patterns.
- Urine glucose, TSH receptor antibody and LDL-P never match the blood-test concepts.
- Every record of a type the layer covers either has a standard code or appears in the review list.

## Scope

- **In:**
  - The mechanism, for all record types.
  - Target vocabularies per US Core bindings:
    - Observation and DiagnosticReport: LOINC;
    - Immunization: CVX;
    - MedicationStatement and MedicationRequest: RxNorm;
    - Condition: SNOMED CT or ICD-10-CM;
    - Procedure: SNOMED CT or CPT.
  - Mapping at import for every importer: C-CDA, EHI, Apple Health, PDF via `ga_import`, and portal sync.
  - A one-time backfill of the existing record.
  - Agent mapping tools.
  - A review list.
  - Replacing the KEY_LABS name patterns with concepts.
- **Order [call]:**
  1. Observations (labs, vitals);
  2. Immunizations;
  3. Procedures (needed by screening rules);
  4. Medications and problems.

  One mechanism; each record type is a task.
- **Non-goals:**
  - A terminology server, or shipping SNOMED CT or UMLS (licence-restricted).
  - Mapping between vocabularies, e.g. ICD-10 to SNOMED.
  - Unit conversion.
  - Changing what the source said.

## Anti-goals

- **Never change or remove the source's own coding or text.** GA only adds a coding. (FHIR "Using Codes": several codings in one CodeableConcept mean the same thing; `text` is the original wording.)
- **No silent guesses.** Every GA-added code says where it came from. Uncertain ones are marked, and rules treat them as uncertain.
- **No new write path around the engine.** Adding codes goes through the engine, which must also never strip GA-added codings on a later re-import, or report them as a source conflict.
- **Nothing leaves the machine except test or medication names and units, and only for validation** (see "Validation"). Never values, dates or other record content.
- **No PHI in the repo.** Mapping tables learned from the user's record live in the FHIR server, not in the repo.

## How it works

### Where a standard code comes from, in order

1. **The source's own code:** a coding already in the target system. Nothing to add.
2. **Spec tables shipped in the repo:**
   - **Vital signs:** the FHIR core Vital Signs profile's fixed LOINC codes (BP panel 85354-9, systolic 8480-6, diastolic 8462-4, weight 29463-7, height 8302-2, BMI 39156-5, heart rate 8867-4, respiratory rate 9279-1, SpO2 2708-6, temperature 8310-5, head circumference 9843-4). Apple Health readings map here.
   - **CVX for vaccine names**, from the CDC CVX table.
   - Nothing for labs: those come from the source and the agent.
3. **The source's confirmed map:** one FHIR **ConceptMap** per source, e.g. `url urn:ga-server:conceptmap:<source key>`. Its entries map a source term to a standard code with an `equivalence` (equivalent, wider, narrower, inexact, unmatched).
   - **Source term key [user: source, name and unit]:** the normalised name plus the unit, plus specimen where the source states one.
   - **The map learns automatically:** every result the source codes itself adds or confirms an entry. So the hospital's "LOW DENSITY LIPOPROTEIN CHOL | mg/dL" teaches the map, and that hospital's uncoded copies of the same term then map.
   - Looked up with `$translate` if Medplum supports it **[check]**, otherwise by a simple lookup in GA.
4. **Agent mapping [user]:** what's left is mapped by the agent on its own when confident; the user reviews afterwards.
   - A **confident** mapping is applied and written into the source's ConceptMap.
   - A **less confident** one is applied but marked `concept-suggested`.
   - Each mapping gets a Provenance entry: agent, chat app or Claude Code, and time.
5. **Unmapped:** tagged `concept-unmapped` and listed for review.

### On the record

- **The added coding:** goes into the same CodeableConcept, after the source's codings, carrying a GA extension: `urn:ga-server:ext:concept-source` = `source-map` | `spec` | `agent`. Plus the tag `concept-suggested` when it's an uncertain agent mapping.
  - FHIR defines no confidence marker on Coding, so this is GA's own, in the same style as its duplicate and AI-read tags.
- **`userSelected: true`** on the source's own coding, if it isn't already set **[call]**.

### Applying, re-applying, backfill

- **At import:** importers call the concept layer before the engine writes, so new records arrive coded.
- **When a map entry is added or changed** (learned, agent-made or corrected), GA re-applies it to every matching record of that source. That's how a correction propagates.
- **One-time backfill:** `ga concepts apply` runs over the existing record. Idempotent.
- **Engine:** a re-import must keep GA-added codings, and must not treat them as a content change or a source conflict.
  - Today's comparison in `decide()` would see an added coding as different. The builder decides how to compare the source's content only (for example, ignore codings carrying `concept-source`).
  - **This is the riskiest part:** test re-imports of every importer.

### One matcher for every tool

- **Concepts:** named groups of codes, shipped in the repo. Examples: "LDL", with calculated and direct as members and a method label; "eGFR", with the race-free codes only and the race-based ones as a separate, labelled concept; "colorectal cancer screening", with colonoscopy, FIT, FIT-DNA and CT colonography.
- **Who uses them:** tools (`lab_results`, `health_summary`, `vitals`, the vaccine check) and later the health-maintenance rules ask for a concept or a code. `KEY_LABS` name patterns are removed.
- **Free-text `name` search** stays as a fallback for things outside the concept list.
- Results matched only through a `concept-suggested` coding are labelled so in tool output ("possibly …").

### Validation

- A code the agent proposes must exist in its system, and its display must make sense for the term. Checks:
  - **LOINC:** the NLM Clinical Table Search Service (`clinicaltables.nlm.nih.gov`, LOINC items, no login).
  - **RxNorm:** NLM RxNav.
  - **CVX:** the CDC table shipped in the repo.
- Only the term and unit are sent. **[check]** Availability and terms of these services. If unreachable, the mapping is marked `concept-suggested` instead of failing.
- **SNOMED CT:** not validated: GA ships no SNOMED content. Keep the code; mark it suggested unless the source gave it.

### Agent tools (MCP, stdio and remote)

- **`concepts_to_review {status?: 'unmapped'|'suggested', type?}`:** distinct source terms (source, name, unit, record type, how many records, example dates), most frequent first. No values.
- **`map_concept {source, name, unit?, type, system, code, display, equivalence, confident: boolean}`:** validates, then applies as above, writes the ConceptMap entry when confident, and records Provenance. Returns how many records changed.
  - Mapping a term to "unmatched" (it really has no standard code) clears it from the review list.
  - The tool's description tells agents to map only when the name, unit and specimen agree, and to mark anything else not confident.
- **CLI:** `ga concepts` (the review list), `ga concepts apply` (backfill and re-apply).

## Review [user]

- **The agent maps on its own when confident; the user reviews afterwards.**
- **What the review shows:** the agent-made mappings since a date, and every suggested mapping, through `concepts_to_review` in chat and `ga concepts` on the CLI.
- **Corrections:** a correction is another `map_concept` call. It updates the ConceptMap entry and re-applies.
- **Provenance** keeps who mapped what and when.

## Decisions from the builder check [call]

1. **No shared cross-source map.** A shared map would bring back the false matches this layer exists to stop. Maps stay per source. A PDF has no coded copy to learn from, so its terms are mapped by the agent that imported it, at the same moment:
   - `ga_import` returns the record's still-unmapped terms in its report.
   - The extraction rules tell the agent to map them right away with `map_concept`. PDF imports are agent-driven, so the agent is already there.
   - Extraction should still put a LOINC code on a result when it's confident (existing rule).
   - The success test therefore passes after an agent import or backfill, not from a file import alone.
2. **Scope boundary.** Covered: labs (category laboratory, plus uncategorised AI-extracted results), clinic vital signs (category vital-signs), Immunization, Procedure, MedicationStatement, MedicationRequest and Condition. Excluded, so never in the review list:
   - Apple Health daily summaries, activity rings, sleep and the ECG: GA generates these itself with fixed names. Give them fixed GA codes, or leave them; per-reading Apple vitals use the spec table.
   - Social history, QuestionnaireResponse, and the "Health maintenance: <topic>" Observations.
   - DocumentReference and Communication.
3. **Source key.**
   - C-CDA and EHI: the organisation GA already uses in their identifiers (`urn:ga-server:id:ehi:<org>`, and the C-CDA document's custodian or organisation).
   - Each hospital portal: its source key.
   - Apple Health: one source.
   - All PDFs and photos: one shared source, `pdf`, mapped by agents.
4. **Authorship.** Concept writes go through GA's own client, the same author as the importer, and never change `writer-*` tags or `meta.source`. `decide()` compares content without GA-added codings, so adding a code never turns a re-import into an update or a conflict. Test this across every importer's re-import.
5. **Equivalence.**
   - Only `equivalent` adds a plain coding that concepts match.
   - `wider`, `narrower` and `inexact` add the coding marked `concept-suggested`.
   - `unmatched` adds no coding and clears the term from the review list.
   - An agent mapping not marked confident is always `concept-suggested`, whatever its equivalence.
6. **Term key by type.**
   - Labs and vitals: name, unit and specimen when stated.
   - Immunization, Procedure and Condition: name.
   - Medications: name as written, mapped to RxNorm at the most specific level the name supports: clinical drug when strength and form are given, otherwise ingredient.
7. **eGFR.** One "eGFR" concept with labelled members, race-free and race-based. Summaries show the method of the value they report, so older race-based results stay in the trend with their label rather than disappearing.
8. **Governance.** Per the user, the agent maps on its own when confident. `map_concept` carries `destructiveHint`, so apps that confirm writes will ask. Every mapping has a Provenance entry and is reversible by a correcting `map_concept`. No other cap.

## Left to the builder

- The normalisation of names: case, spacing, punctuation, common abbreviations.
- The concept list's file format, and which concepts ship first (at least the current KEY_LABS, vitals, and the screening procedures milestone 7 needs).
- How `decide()` ignores GA-added codings.
- Whether ConceptMap lookups use `$translate` or GA's own lookup.
- Batch sizes for re-applying.

## Changes during build

- Map entries are written even when not confident: stored `confident: false` and applied as suggested.
- Validation sends only the code. A code the validator says does not exist is refused and nothing is written.
- HCPCS is accepted for procedures.
- Labels corrected: eGFR 62238-1 is CKD-EPI; LDL 2089-1 is unlabelled.
- The C-CDA source key is the custodian. Backfill recovers it from the stored source file.
- Map keys carry the record type for every type but Observation (`Condition|influenza`), and a target outside the type's vocabularies is never applied: one source's Condition "Influenza" (ICD-10) no longer codes its Immunization "Influenza". `ga concepts apply --migrate-keys` converts older keys once (type from the target system, else from the source's records; still ambiguous: dropped, back in review).
- An uncoded lab joins a coded twin of its name and unit only from the same source, never one its map calls unmatched (tagged `concept-unmatched`).
- A source that later codes a learned term another way demotes the entry to not confident (suggested, back in review).
- A re-import re-codes the records it skips or links with this batch's maps (a concept write, not counted as updated).
- Review of agent mappings: `concepts_to_review {status: 'agent', since?}`, `ga concepts --agent [--since]`.
