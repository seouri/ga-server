# Concept Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every covered record carries a standard code (LOINC, CVX, RxNorm, SNOMED CT or ICD-10), so tools and rules match concepts instead of names.

**Architecture:** One module decides the standard code for a record, in this order: the source's own code, then shipped spec tables, then a per-source FHIR ConceptMap stored in Medplum, then an agent mapping, otherwise unmapped. It runs inside the engine's `importResources` (one place for every importer) and in a backfill command. A named-concept file replaces `KEY_LABS`. Agents review and map terms through two MCP tools.

**Tech Stack:** Node 26 (strip-only TypeScript), Medplum 5.2.14, `conceptMapTranslate` from the installed `@medplum/core`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-concept-layer-design.md` (including its "Decisions from the builder check").

## Global Constraints

- Never change or remove a source's own coding or `text`. GA only adds one coding per record, after the source's codings, carrying extension `urn:ga-server:ext:concept-source` with valueCode `spec` | `source-map` | `agent`.
- Tags (system `urn:ga-server:tag`):
  - `concept-suggested`: an uncertain mapping.
  - `concept-unmapped`: nothing found.
- Equivalence:
  - Only `equivalent` adds a plain matching coding.
  - `wider`, `narrower` and `inexact` add the coding plus `concept-suggested`.
  - `unmatched` adds no coding and clears the term from review.
  - A non-confident agent mapping is always `concept-suggested`.
- ConceptMap per source: `url` = `urn:ga-server:conceptmap:<source key>`.
  - Source keys: `ehi:<org>`, `ccda:<org>`, `smart:<key>`, `apple-health`, `pdf`.
  - Term key: labs and vitals use normalised name + `|` + unit (+ `|` + specimen when stated). Immunization, Procedure and Condition use the normalised name. Medications use the name as written.
- Scope:
  - **Covered:** labs (category laboratory, or uncategorised and tagged `extracted-by-llm`), clinic vital signs (category vital-signs), Immunization, Procedure, MedicationStatement, MedicationRequest, Condition.
  - **Excluded:** Apple Health daily summaries, activity, sleep and ECG; social history; QuestionnaireResponse; Observations coded "Health maintenance: …"; DocumentReference; Communication.
- Target systems:
  - LOINC `http://loinc.org`
  - CVX `http://hl7.org/fhir/sid/cvx`
  - RxNorm `http://www.nlm.nih.gov/research/umls/rxnorm`
  - SNOMED CT `http://snomed.info/sct`
  - ICD-10-CM `http://hl7.org/fhir/sid/icd-10-cm`
  - CPT `http://www.ama-assn.org/go/cpt`
- **Network:** validation may send only the term name and unit (to `clinicaltables.nlm.nih.gov` for LOINC and `rxnav.nlm.nih.gov` for RxNorm), never values, dates or ids. If unreachable, mark the mapping `concept-suggested`; never fail the import.
- **Writes:** concept writes use GA's own client and never change `writer-*` tags or `meta.source`. `decide()` ignores codings that carry `concept-source`.
- **No new runtime dependency. No PHI in the repo:** learned maps live in Medplum only.
- **Testing:** tests use throwaway patients and throwaway sources (`tests/integration/helpers.ts`). Integration tests run one file at a time (`npm run test:int -- tests/integration/<file>.test.ts`).

## Review Focus

1. **Re-importing any source after concepts are applied** (C-CDA, EHI, Apple Health, portal sync) reports 0 updated and 0 conflicts. Test in Task 3.
2. **Same name, different unit or specimen** (a urine "Glucose" in mg/dL "urine" vs a serum entry) is never coded by the serum map entry. Test in Task 2.
3. **A wrong agent mapping corrected by a second `map_concept`** removes the old GA-added coding from every record and adds the new one; the source's own coding is untouched. Test in Task 5.
4. **Validation service unreachable** (injected failing fetch): `map_concept` applies the mapping marked `concept-suggested` and reports why. Test in Task 5.
5. **`map_concept` on an excluded kind** (an Apple daily summary term) is refused with a reason. On a term with more records than one batch, it applies to all of them. Test in Task 5.

---

### Task 1: Concept vocabulary and matcher

**Files:**
- Create: `config/concepts.json`, `config/cvx.json`, `src/concepts.ts`
- Test: `tests/concepts.test.ts`

**Interfaces:**
- Produces:
  - `type Concept = { name: string; kind: 'lab' | 'vital' | 'vaccine' | 'procedure' | 'medication' | 'condition'; members: { system: string; code: string; label?: string }[] }`
  - `concepts(): Concept[]`
  - `conceptOf(codings: Coding[] | undefined): { concept: Concept; label?: string } | undefined`. Only codings without a `concept-suggested` record count as plain; callers handle suggested ones.
  - `codesFor(name: string): Coding[]`
  - `vitalSpecCode(name: string, unit?: string): Coding | undefined`: the FHIR Vital Signs profile table from the spec.
  - `cvxFor(name: string): Coding | undefined`

- [ ] **Step 1:** Write `config/concepts.json` with at least:
  - every current `KEY_LABS` test (src/labs.ts:83) as LOINC members;
  - "eGFR" with race-free members 62238-1 and 98979-8 labelled `race-free`, and 48642-3 and 48643-1 labelled `race-based`;
  - "LDL" with 13457-7 labelled `calculated` and 18262-6 and 2089-1 labelled `direct`;
  - the vital-sign codes from the spec;
  - a "colorectal cancer screening" procedure concept (colonoscopy, FIT, FIT-DNA, CT colonography). Use CPT and SNOMED codes, each checked against a public source, and cite the source in a `_source` field per concept.

  Write `config/cvx.json` from the CDC CVX table (public domain): code, short description, and full vaccine name.
- [ ] **Step 2: Failing tests.**
  - `conceptOf([{system: LOINC, code: '13457-7'}])` is LDL, labelled `calculated`.
  - `conceptOf` for 48642-3 is eGFR, labelled `race-based`.
  - A urine glucose LOINC (5792-7) matches no blood-glucose concept.
  - `vitalSpecCode('Body weight')` gives 29463-7.
  - `cvxFor('TDAP')` gives 115.
  - `codesFor('LDL')` has 3 codes.

  Run `npx vitest run tests/concepts.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement `src/concepts.ts`, loading the JSON once.
- [ ] **Step 4:** Run the tests and expect PASS. Commit `feat: concept vocabulary (concepts.json, CVX, vital-signs spec table)`.

### Task 2: Term keys, source keys and per-source ConceptMaps

**Files:**
- Create: `src/conceptmap.ts`
- Test: `tests/conceptmap.test.ts`, `tests/integration/conceptmap.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `inScope(r: Resource): boolean`: the spec's covered and excluded lists.
  - `termKey(r: Resource): string | undefined`: normalisation (case, whitespace, punctuation) is the builder's choice, but the key must keep unit and specimen apart.
  - `sourceKey(src: SourceInfo, r: Resource): string`. For C-CDA, use the organisation GA already writes into the C-CDA identifiers. **[check]** Read src/ccda.ts; if there is none, use the custodian name from the document and record that choice in a comment.
  - `type MapEntry = { key: string; target?: Coding; equivalence: 'equivalent' | 'wider' | 'narrower' | 'inexact' | 'unmatched'; confident: boolean; by: 'source' | 'agent' }`
  - `loadMaps(client): Promise<Maps>`, cached per process and invalidated on write.
  - `lookup(maps, source, key): MapEntry | undefined`, using `conceptMapTranslate` from `@medplum/core` on that source's map.
  - `upsertEntry(client, source, entry): Promise<void>`: creates or updates `ConceptMap` `urn:ga-server:conceptmap:<source>`, one `group` per target system.

- [ ] **Step 1: Failing unit tests.**
  - `termKey` of the hospital "LOW DENSITY LIPOPROTEIN CHOL" in mg/dL differs from `termKey` of a "Glucose" with specimen urine, and differs from serum "Glucose".
  - `inScope` is false for an Apple "Heart rate, daily mean" summary, a QuestionnaireResponse and an Observation coded "Health maintenance: X".
  - `sourceKey` gives `pdf` for kind pdf and `apple-health` for Apple Health.
- [ ] **Step 2: Failing integration test** (throwaway source key `test-<uuid>`).
  - `upsertEntry` then `lookup` round-trips.
  - A second `upsertEntry` for the same key replaces the target.
  - **Review Focus 2:** the serum glucose entry is not returned for the urine key.
  - Delete the test ConceptMap afterwards.
- [ ] **Step 3:** Implement. **Step 4:** Run `npx vitest run tests/conceptmap.test.ts` and `npm run test:int -- tests/integration/conceptmap.test.ts`; expect PASS. Commit `feat: per-source ConceptMaps with term and source keys`.

### Task 3: Coding records at import (engine)

**Files:**
- Create: `src/concept-apply.ts`
- Modify: `src/engine.ts` (`body()` around line 65, `importResources` around line 237, `ImportReport`)
- Test: `tests/concept-apply.test.ts`, `tests/integration/engine.test.ts`, plus re-runs of `ccda`, `ehi`, `apple`, `smart-sync`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `codeRecord(r: Resource, src: SourceInfo, maps: Maps): { resource: Resource; status: 'source' | 'spec' | 'source-map' | 'suggested' | 'unmapped' | 'excluded'; learn?: { source: string; entry: MapEntry } }`. Pure; adds at most one coding, extension, tag.
  - `ImportReport` gains `unmapped: { source: string; type: string; name: string; unit?: string; count: number }[]`.
  - `stripConcept(r)`: a copy without GA-added codings or concept tags, used by `decide()` and re-apply.

- [ ] **Step 1: Failing unit tests.**
  - A coded hospital LDL returns status `source` plus a `learn` of the equivalent entry.
  - An uncoded PDF "LDL cholesterol" with no map is `unmapped` and tagged `concept-unmapped`.
  - With a map entry `equivalent`+confident, the coding is added with `concept-source: source-map`.
  - With `inexact`, it is tagged `concept-suggested`.
  - An excluded Apple summary is returned unchanged.
  - The source's coding stays first and unchanged.
- [ ] **Step 2: Failing integration tests** in `tests/integration/engine.test.ts`.
  - Importing a coded C-CDA-shaped LDL then an uncoded same-term LDL from the same source codes the second one.
  - **Review Focus 1:** re-importing the same batch gives `updated: 0, conflicts: 0`.
  - `decide()` on an existing record that has a GA-added coding vs the same incoming source content returns `skip`.
- [ ] **Step 3:** Implement.
  - `importResources` loads the maps once per call, runs `codeRecord` on every incoming resource before deciding, `upsertEntry`s learned entries, and fills `unmapped`.
  - `body()` applies `stripConcept`.
  - Updates that carry an existing record forward keep its GA-added coding when the new record has none.
- [ ] **Step 4:** Run `npm test`, then each of `engine`, `ccda`, `ehi`, `apple`, `smart-sync`. All must pass, and the re-import assertions in those files must still show no updates. Commit `feat: engine codes records at import (source, spec, source map)`.

### Task 4: Backfill, re-apply and the review list (CLI)

**Files:**
- Create: `src/concepts-cli.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/concepts-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `applyAll(client, patientId, opts?: { source?: string; key?: string }): Promise<{ scanned: number; coded: number; suggested: number; unmapped: number; changed: number }>`. Idempotent. With `source` and `key` it re-applies one map entry: it removes a stale GA-added coding and adds the new one, paging in batches of 500. Each write goes through `client.updateResource` with only the coding, extension and tag changed.
  - `reviewList(client, patientId, status: 'unmapped' | 'suggested', type?): Promise<{ source; type; name; unit?; count; examples: string[] /* dates only */ }[]>`, most frequent first.
  - CLI: `ga concepts [--suggested]` prints `reviewList`; `ga concepts apply` runs `applyAll` and prints the counts.

- [ ] **Step 1: Failing integration test** on a throwaway patient.
  - Two sources (one coded, one not) plus an excluded Apple summary.
  - `applyAll` codes the uncoded same-source term.
  - A second `applyAll` reports `changed: 0`.
  - `reviewList('unmapped')` lists only covered, unmapped terms with counts.
- [ ] **Step 2:** Implement. **Step 3:** Run it and expect PASS. Commit `feat: ga concepts (review list) and ga concepts apply (backfill, re-apply)`.

### Task 5: Agent tools and `ga_import` reporting

**Files:**
- Create: `src/tools/concepts.ts`, `src/concept-validate.ts`
- Modify: `src/mcp.ts` (register for both transports), `.claude/skills/ga-import/extract.md` (and its mirror in `AGENTS.md`)
- Test: `tests/concept-validate.test.ts`, `tests/integration/mcp.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `validate(system, code, term, deps?: { fetch? }): Promise<{ ok: boolean; display?: string; reason?: string }>`:
    - LOINC: clinicaltables `/api/loinc_items/v3/search?terms=<code>`.
    - RxNorm: RxNav `/REST/rxcui/<code>/properties.json`.
    - CVX: `config/cvx.json`.
    - SNOMED, ICD-10 and CPT: `{ok: true, reason: 'not validated'}`, so they're applied only as `concept-suggested` unless the source gave them.
    - On network error: `{ok: false, reason: 'validation unavailable'}`.
  - MCP `concepts_to_review {status?, type?}` (readOnlyHint) → `reviewList`.
  - MCP `map_concept {source, name, unit?, type, system, code, display, equivalence, confident}` (destructiveHint) → validates, `upsertEntry`s (by `agent`), then `applyAll({source, key})`, then writes one Provenance (target: the ConceptMap; agent: `deps.remote?.clientName ?? 'Claude Code'`; activity: `map_concept`) → `{changed, status: 'mapped' | 'suggested', reason?}`. It refuses out-of-scope kinds. A failed validation is applied as `suggested` with the reason.
  - `ga_import`'s report already carries `unmapped` (Task 3).
  - **`extract.md` rule:** "After `ga_import`, map each term in `unmapped` with `map_concept` (confident only when name, unit and specimen agree with the code's LOINC long name)."

- [ ] **Step 1: Failing unit tests for `validate`** with a fake fetch: a known LOINC passes; an unknown code fails; a fetch that throws gives `validation unavailable`.
- [ ] **Step 2: Failing MCP integration tests.**
  - `concepts_to_review` lists a seeded unmapped term.
  - `map_concept` confident and equivalent codes all matching records and empties that review entry.
  - **Review Focus 3:** a second `map_concept` with a different code moves every record to it and leaves the source codings untouched.
  - **Review Focus 4:** with validation forced unavailable, the mapping is applied as `suggested` with the reason.
  - **Review Focus 5:** an Apple summary term is refused. More than 500 seeded records are all re-applied.
  - A Provenance exists per mapping.
- [ ] **Step 3:** Implement. **Step 4:** Run `npm test` and `npm run test:int -- tests/integration/mcp.test.ts`; expect PASS. Commit `feat: concepts_to_review and map_concept (validated, provenance), ga_import reports unmapped terms`.

### Task 6: Tools match concepts instead of names

**Files:**
- Modify: `src/labs.ts` (remove `KEY_LABS`, `keyLabOf`, the name patterns), `src/health.ts`, `src/vitals.ts`
- Test: `tests/labs.test.ts`, `tests/integration/mcp.test.ts`

**Interfaces:**
- Consumes: Task 1 (`conceptOf`, `codesFor`, `concepts`).
- Produces:
  - `lab_results {name}`: when `name` names a concept, search by `codesFor(name)` (all codings, including GA-added ones), plus a literal-text fallback.
  - The summary groups by concept, labelled by member (eGFR shows its method; LDL shows calculated or direct).
  - A row matched only through a `concept-suggested` coding gets the flag `possibly <concept> (suggested mapping)`.
  - `health_summary` key labs come from the lab concepts in `concepts.json`.

- [ ] **Step 1: Failing tests.**
  - The integration fixture's coded hospital LDL plus a mapped PDF LDL give one LDL summary entry with count 2.
  - A urine glucose with a urine LOINC never appears under Glucose.
  - "TSH receptor antibody" never appears under TSH.
  - "LDL-P" never appears under LDL.
  - A suggested-only match carries the "possibly" flag.
- [ ] **Step 2:** Implement. **Step 3:** Run `npm test` and `npm run test:int -- tests/integration/mcp.test.ts`; expect PASS. Commit `refactor: tools match concepts; KEY_LABS name patterns removed`.

### Task 7: Backfill the real record, success tests, docs

**Files:**
- Modify: `AGENTS.md`, `.claude/skills/ga/SKILL.md`, `docs/usage.md`, `docs/chat-apps.md`, `docs/operations.md`

- [ ] **Step 1:** The controller takes a backup (`docker compose run --rm -e RUN_ONCE=1 ga-backup`), then runs `ga concepts apply` on the real record and prints the counts only.
- [ ] **Step 2:** The controller has an agent map the remaining unmapped terms (`concepts_to_review` / `map_concept`), then checks the spec's success tests, printing counts only:
  - "ldl" and the LDL key lab find 6 results;
  - urine glucose, TSH receptor antibody and LDL-P never match;
  - every covered record is coded or in `reviewList`.
- [ ] **Step 3: Docs.**
  - AGENTS.md and SKILL.md: the tool list, "ask for a concept", and the "possibly" flag meaning.
  - docs/usage.md and chat-apps.md: the new tools.
  - operations.md: `ga concepts`, `ga concepts apply`, and that learned maps live in the FHIR server and in backups.
- [ ] **Step 4:** Commit `docs: concept layer`.
