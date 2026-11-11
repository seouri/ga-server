# Automatic Concept Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA finds standard codes for uncoded terms itself, maps exact matches automatically after every import, and hands agents ranked candidates for the rest, so no person ever looks up a code.

**Architecture:** A new `src/terminology.ts` searches free public terminology services by term name. `src/concept-validate.ts` gains SNOMED CT and ICD-10-CM checks. The body of the `map_concept` tool moves into `mapTerm` so GA's automatic mapper (`src/concept-auto.ts`) writes mappings exactly as agents do. A single `afterImport` hook runs the mapper after every import path and adds `candidates` to the unmapped terms it returns.

**Tech Stack:** Node ≥26 TypeScript run directly, Medplum client, vitest (unit and integration projects), global `fetch`.

**Spec:** docs/superpowers/specs/2026-11-11-automatic-concept-mapping-design.md

## Global Constraints

- Only the term's name leaves the machine for a search; never values, dates, units, ids or the source's name. A code check sends only the code (as today).
- Endpoints, verbatim: `https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search`, `https://rxnav.nlm.nih.gov/REST/approximateTerm.json`, `https://rxnav.nlm.nih.gov/REST/rxcui/<id>/properties.json`, `https://tx.fhir.org/r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs&filter=<term>`, `https://tx.fhir.org/r4/CodeSystem/$lookup?system=http://snomed.info/sct&code=<code>`, `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search`.
- Timeouts 10 s per request, at most 4 requests in flight, at most 50 terms per automatic run, at most 5 searched candidates per term, candidates in `concepts_to_review` for the 25 most frequent terms.
- Any network failure yields no candidates and never fails an import, a sync or a tool call.
- `.ga/config.json` `"terminologyLookup": false` → no search request is made and nothing is mapped automatically.
- GA's automatic mappings: `equivalence: "equivalent"`, `confident: true`, `by: "agent"`, Provenance agent display `GA (automatic)`.
- Only terms with no map entry are mapped automatically; an existing entry (agent or source) is never replaced.
- Integration tests run only through the lock script and only in the ga-test project. No personal data in code, tests, docs or commits; commits carry no attribution lines.

## Review Focus

1. A terminology service that is down, slow or returns HTML → the import report still returns, the term stays unmapped with `candidates: []`. (Task 1 and Task 4 tests.)
2. Two candidates with the same name as the term (a synonym listed twice under different codes) → nothing is mapped automatically. (Task 4 test.)
3. `terminologyLookup: false` → zero `fetch` calls during import and `concepts_to_review`. (Task 5 test.)
4. A first import with hundreds of unmapped terms → only the 50 most frequent are searched; the rest return without candidates. (Task 4 test.)
5. A term name with `&`, `/`, `%` or non-ASCII letters → correctly URL-encoded; no request to a different path. (Task 1 test.)

---

### Task 1: Terminology search

**Files:**
- Create: `src/terminology.ts`
- Test: `tests/terminology.test.ts`

**Interfaces:**
- Produces: `export type Candidate = { system: string; code: string; display: string; from?: 'linked record' }` and `export async function searchCodes(system: string, term: string, deps?: { fetch?: typeof fetch; limit?: number }): Promise<Candidate[]>` (default limit 5). Supported systems: `LOINC`, `RXNORM`, `SNOMED`, `ICD10CM` from `src/concepts.ts`; any other system → `[]` with no request.
- Produces: `export const sameName = (a: string, b: string): boolean` (lowercase; punctuation and repeated spaces ignored).

- [ ] **Step 1: Write the failing tests** (inject `fetch`, assert URL and parsing):
  - `searches LOINC by name and returns long common names`: the request URL starts with the Clinical Tables loinc_items URL, carries `terms=<encoded name>` and `df=LONG_COMMON_NAME`; the response `[2,["13457-7","2089-1"],null,[["Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation"],["Cholesterol in LDL [Mass/volume] in Serum or Plasma"]]]` gives two candidates with `system: LOINC`.
  - `searches RxNorm and names each rxcui`: `approximateTerm` returns candidates with rxcui 308297 twice; one `properties` call per distinct rxcui; display = its `name`.
  - `searches SNOMED CT on tx.fhir.org`: the request URL contains `ValueSet/$expand`, `url=http://snomed.info/sct?fhir_vs` and `filter=`; `expansion.contains` `[{code:'73761001',display:'Colonoscopy'}]` → one candidate.
  - `retries SNOMED once without laterality, ordinals and small words when the first search finds nothing`: first response empty, second request's filter is `pinning finger fracture` for the term `pinning of left 5th finger fracture`.
  - `searches ICD-10-CM`: Clinical Tables icd10cm response `[1,["E11.9"],null,[["E11.9","Type 2 diabetes mellitus without complications"]]]` → `{system: ICD10CM, code:'E11.9', display:'Type 2 diabetes mellitus without complications'}`.
  - `encodes the term`: for `A&B / 50% café` the requested URL's query value decodes back to exactly that string and the path is unchanged.
  - `a failure gives no candidates`: `fetch` throws, returns 500, or returns `<html>` → `[]` each.
  - `an unsupported system makes no request`: `CPT` → `[]`, `fetch` not called.
- [ ] **Step 2: Run** `npx vitest run --project unit tests/terminology.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `searchCodes` and `sameName` in `src/terminology.ts`. Reuse the `get` helper pattern of `src/concept-validate.ts` (accept header, 10 s `AbortSignal.timeout`, non-OK throws), catching every error to `[]`. Header comment: what is sent (the name only) and where.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `git add src/terminology.ts tests/terminology.test.ts && git commit -m "feat(concepts): search LOINC, RxNorm, SNOMED CT and ICD-10-CM by term name"`

### Task 2: Check SNOMED CT and ICD-10-CM codes; no CPT from agents

**Files:**
- Modify: `src/concept-validate.ts`
- Modify: `src/tools/concepts.ts` (description text and the CPT refusal)
- Test: `tests/concept-validate.test.ts`, `tests/integration/concepts-cli.test.ts` (or the existing map_concept integration test file found by `grep -l map_concept tests/integration`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `validate(system, code, deps)` now returns `{ ok: true, display }` / `{ ok: false, reason: 'unknown SNOMED CT code …' }` for SNOMED (tx.fhir.org `CodeSystem/$lookup`, display = the `display` parameter) and ICD-10-CM (Clinical Tables icd10cm, exact code match like the LOINC branch). CPT and HCPCS keep `{ ok: true, reason: 'not validated' }`.

- [ ] **Step 1: Write the failing tests:**
  - `validates a SNOMED CT code on tx.fhir.org`: a `Parameters` response with `{name:'display', valueString:'Colonoscopy'}` → `{ ok: true, display: 'Colonoscopy' }`; a 404 → `ok: false` with reason starting `unknown SNOMED CT code`.
  - `validates an ICD-10-CM code exactly`: a search returning `E11.9` for `E11.9` → ok with its name; a response listing only `E11.90` for `E11.9` → unknown.
  - `an unavailable service is not an unknown code`: 503 → `{ ok: false, reason: 'validation unavailable' }` for both.
  - (integration) `map_concept refuses a CPT target`: the tool returns an error containing `map procedures to SNOMED CT` and writes no ConceptMap.
- [ ] **Step 2: Run** the unit test → FAIL; the integration test through the lock script → FAIL.
- [ ] **Step 3: Implement.** In `validate`, add the two branches (the `wellFormed` check stays first). In `map_concept`, before validation: `system === CPT` → `GaError('CPT is licensed and cannot be checked: map procedures to SNOMED CT')`. Update the tool description: procedures take SNOMED CT (or HCPCS); GA checks LOINC, RxNorm, CVX, SNOMED CT and ICD-10-CM codes; when the source lacks a detail the exact code needs, map to the closest broader concept with `equivalence: "wider"`.
- [ ] **Step 4: Run** both tests → PASS; run `npx vitest run --project unit tests/concept-validate.test.ts tests/concepts.test.ts`.
- [ ] **Step 5: Commit** `feat(concepts): check SNOMED CT and ICD-10-CM codes; procedures map to SNOMED CT, not CPT`

### Task 3: `mapTerm`, shared by `map_concept` and GA

**Files:**
- Create: `src/concept-map-term.ts`
- Modify: `src/tools/concepts.ts` (the tool body calls `mapTerm`)
- Test: existing map_concept integration tests must pass unchanged.

**Interfaces:**
- Produces: `export type MapInput = { source: string; name: string; unit?: string; key?: string; type: string; system: string; code: string; display: string; equivalence: MapEntry['equivalence']; confident: boolean }` and `export async function mapTerm(client: MedplumClient, patientId: string, input: MapInput, who: string, deps?: { fetch?: typeof fetch }): Promise<{ changed: number; status: 'mapped' | 'suggested' | 'unmatched' | 'no records'; reason?: string }>`. It throws `GaError` for refusals exactly as the tool does now (scope, key, vocabulary, CPT, unknown code).

- [ ] **Step 1: Move** the tool's body (from `termOf` through the returned status) into `mapTerm`, unchanged except that it returns the object instead of `text(...)`. The tool becomes `text(await mapTerm(client, patientId, args, who, { fetch: deps.fetch }))` inside its try/catch.
- [ ] **Step 2: Run** the map_concept integration tests via the lock script and `npm run typecheck` → PASS with no test edits.
- [ ] **Step 3: Commit** `refactor(concepts): mapTerm holds map_concept's logic so GA can map terms the same way`

### Task 4: Automatic mapping

**Files:**
- Create: `src/concept-auto.ts`
- Test: `tests/concept-auto.test.ts` (unit, pure parts), `tests/integration/concept-auto.test.ts`

**Interfaces:**
- Consumes: `searchCodes`, `sameName`, `Candidate` (Task 1); `mapTerm` (Task 3); `TARGET` (src/concept-apply.ts); `Unmapped` (src/concept-apply.ts); `loadMaps`, `lookup` (src/conceptmap.ts); `DUP_OF` (src/engine.ts).
- Produces:
  - `export function pickAuto(name: string, candidates: Candidate[]): Candidate | undefined`: the single searched candidate (not `from: 'linked record'`) whose display `sameName`s the term; undefined when zero or several do.
  - `export type Reviewed = Unmapped & { candidates: Candidate[] }`.
  - `export async function autoMap(client: MedplumClient, patientId: string, terms: Unmapped[], deps?: { fetch?: typeof fetch; lookup?: boolean }): Promise<{ autoMapped: number; terms: Reviewed[] }>`. `lookup: false` returns every term with `candidates: []` and makes no request. Terms already in a map are skipped (returned with no candidates). Terms beyond the 50 most frequent are returned with `candidates: []`. The searched system is the type's first vocabulary in `TARGET` (Condition: SNOMED, then ICD-10-CM results appended; Immunization: none, CVX is GA's table). The linked-record candidate comes first: a stored record of that term from that source tagged `possible-duplicate` whose `DUP_OF` record carries a code in `TARGET[type]` that is its source's own or a confident GA coding (`trusted` in src/concept-apply.ts).
  - Writes go through `mapTerm(…, 'GA (automatic)')` with `equivalence: 'equivalent'`, `confident: true`; a `mapTerm` refusal leaves that term unmapped with its candidates.

- [ ] **Step 1: Write the failing unit tests** for `pickAuto`:
  - `maps a single exact name`: term `Colonoscopy`, candidates `Colonoscopy` (73761001) and `Colonoscopy with biopsy` → 73761001.
  - `ignores case and punctuation`: `colonoscopy.` matches `Colonoscopy`.
  - `two exact names map nothing`: two candidates both named `Colonoscopy` with different codes → undefined.
  - `a linked-record candidate is never auto-mapped`: the only exact match has `from: 'linked record'` → undefined.
- [ ] **Step 2: Write the failing integration tests** (lock script; inject a fake `fetch` serving synthetic responses):
  - `maps an exact match and returns the rest with candidates`: store two uncoded PDF Procedures (`Colonoscopy`, `Pinning of finger fracture`); `autoMap` → `autoMapped: 1`; the Colonoscopy record now has SNOMED 73761001 (status mapped); the other is returned with the fake candidates.
  - `never replaces an existing mapping`: a term first mapped by `map_concept` to another code stays on that code after `autoMap`.
  - `a service failure leaves terms unmapped`: fake `fetch` rejects → `autoMapped: 0`, every term `candidates: []`, no throw.
  - `searches only the 50 most frequent terms`: 60 synthetic Unmapped rows with descending counts → the fake fetch sees requests for 50 names only; the 10 rarest come back with `candidates: []`.
  - `offers the code of a linked duplicate first`: an uncoded PDF Procedure tagged `possible-duplicate` with `DUP_OF` pointing to a portal Procedure carrying SNOMED 73761001 → its first candidate is `{code:'73761001', from:'linked record'}` and it is not auto-mapped.
- [ ] **Step 3: Run** both → FAIL.
- [ ] **Step 4: Implement** `src/concept-auto.ts`. A small in-file pool runs at most 4 term searches at once.
- [ ] **Step 5: Run** both → PASS.
- [ ] **Step 6: Commit** `feat(concepts): GA maps exact matches itself and returns ranked candidates for the rest`

### Task 5: Run it after every import, and in review

**Files:**
- Modify: `src/config.ts` (`terminologyLookup?: boolean` on `GaConfig`, comment: false keeps term names on the machine)
- Create: `afterImport` in `src/concept-auto.ts`
- Modify: `src/import.ts` (`importAny`), `src/mcp.ts` (`importExtracted`), `src/smart/sync.ts` (after `importResources`, not on a dry run), `src/concepts-cli.ts` (`applyAll` ends by auto-mapping the review list; `reviewList` adds candidates), `src/tools/concepts.ts` (`concepts_to_review` passes `fetch` and the config flag)
- Test: `tests/integration/concept-auto.test.ts`, `tests/integration/concepts-cli.test.ts`

**Interfaces:**
- Consumes: `autoMap` (Task 4).
- Produces: `export async function afterImport<T>(client: MedplumClient, cfg: GaConfig, report: T, deps?: { fetch?: typeof fetch }): Promise<T>`: when `report` has an `unmapped` array with rows, replaces it with `autoMap`'s `terms` and sets `report.autoMapped`; otherwise returns `report` unchanged. `lookup` = `cfg.terminologyLookup !== false`.
- `reviewList(client, patientId, status, type, deps?: { fetch?: typeof fetch; lookup?: boolean })` rows gain `candidates` (the 25 most frequent; the rest `[]`).

- [ ] **Step 1: Write the failing integration tests:**
  - `ga_import returns candidates and autoMapped`: import synthetic resources through `importExtracted` with an injected fake fetch → the report has `autoMapped` and each `unmapped` row has `candidates`.
  - `terminologyLookup false makes no request`: same import with `cfg.terminologyLookup = false` and a fetch spy → zero calls, rows have `candidates: []`.
  - `concepts_to_review lists candidates`: a stored unmapped term → its row carries the fake candidates.
  - `concepts apply auto-maps stored terms`: a stored uncoded `Colonoscopy` → after `applyAll`, mapped to the fake 73761001.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `afterImport` and call it at the four places. In `importAny`, wrap each branch's result. In the sync, call it on the import report outside the import lock. `ToolDeps.fetch` already exists in `src/mcp.ts`; pass it through.
- [ ] **Step 4: Run** the new tests, then the whole integration suite through the lock script, the unit suite and `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(concepts): automatic mapping after every import; candidates in review`

### Task 6: Agent rules and docs

**Files:**
- Modify: `AGENTS.md` ("Concept layer"), `.claude/skills/ga/SKILL.md` (step 1's concept sentence), `.claude/skills/ga-import/extract.md` (step 6), `docs/concepts.md`, `docs/usage.md` (the off switch).

- [ ] **Step 1: Write the rules** (one short bullet each in AGENTS.md "Concept layer", mirrored where the skill files mention mapping):
  - GA maps exact matches itself after each import; `ga_import` and `concepts_to_review` give each remaining term ranked `candidates` (a `from: "linked record"` candidate is the code of a record GA already linked as a possible duplicate).
  - Map from the candidates; don't search for codes yourself. Procedures: SNOMED CT (CPT is refused). When the source lacks a detail the exact code needs, choose the closest broader candidate with `equivalence: "wider"`.
  - Never show codes to the person. Ask them only when two candidates would give a different answer to something they asked, and then in plain words ("Was this a colonoscopy or a sigmoidoscopy?"); otherwise decide and set `confident: false` when it is a judgment call.
  - `"terminologyLookup": false` in `.ga/config.json` stops GA sending term names to the terminology services (NLM, HL7's tx.fhir.org); code checks still send only the code.
- [ ] **Step 2: Update docs/concepts.md** "Where a code comes from" (new step between 3 and 4: GA's own search and exact-match mapping) and "Reviewing" (the list is an audit trail; candidates); the vocabulary table's Procedures row becomes "SNOMED CT (CPT only when the source sent it), HCPCS".
- [ ] **Step 3: Run** `npx vitest run --project unit` (doc-linked tests, if any) → PASS.
- [ ] **Step 4: Commit** `docs(concepts): agents map from GA's candidates and never show codes`
