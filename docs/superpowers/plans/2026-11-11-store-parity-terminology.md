# Store parity, plan 2 of 4: terminology — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA's SQLite store passes Medplum 5.2.14's terminology tests that plan 1 deferred (161 inventory rows marked `plan-2`). To do that it ships HL7's built-in terminology and adds the operations `$expand`, `$lookup`, `$validate-code` (on CodeSystem and on ValueSet), `$subsumes`, `$translate` and `$import`, plus terminology-aware search (`:in`, `:not-in`, `:above` and `:below` on tokens; `_filter` `in`, `ni`, `ss` and `sb`).

**Architecture:**
- **Concept index:** the store indexes the concepts of every stored CodeSystem into new SQLite tables (codes, properties, designations) and every ConceptMap into a mapping table, on write, like Medplum's `Coding`, `Coding_Property`, `CodeSystem_Property` and `ConceptMapping` tables.
- **Built-ins:** Medplum's five terminology bundles become ordinary read-only records. The store seeds them once, and only when its type set includes CodeSystem or ValueSet.
- **Operations:** they run synchronously inside the existing `dispatch`, from three new files.
- **Testing:** each ported Medplum test runs side by side in the plan-1 parity harness.

**Tech Stack:** Node 26 (strip-only TypeScript), `node:sqlite`, `@medplum/core` 5.2.14, `@medplum/definitions` 5.2.14, vitest 5.1.0.

**Spec:** `docs/superpowers/specs/2026-11-09-full-fhir-store-design.md` (plan 1: `docs/superpowers/plans/2026-11-09-store-parity-search.md`)

**The other plans:**
- Plan 3 covers GraphQL.
- Plan 4 covers Touchstone and the `SWITCH_READY` commit.

## Global Constraints

Every constraint of plan 1 still applies:
- `src/store` imports only `node:*`, `@medplum/core`, `@medplum/fhirtypes`, `@medplum/definitions` and its own files, and mentions nothing about GA. The boundary test stays green.
- Anything unsupported answers loudly: 400 with an OperationOutcome naming it.
- The FHIR R4 specification wins over Medplum. A deliberate difference gets a README bullet plus a `differs on purpose: …` parity test.
- Tests never touch the owner's record, and the Medplum side writes only in `ga-test-parity`.
- No PHI, no hospital or personal names. Test data is synthetic.
- No existing search gets slower (`src/store/test/perf.test.ts`).
- Parity test titles take the form `<Medplum title> [<file>]`.
- Medplum 5.2.14 is read from a local clone outside the repo.
- Commits are conventional, with no attribution lines and no push.

This plan adds these rulings (the controller's, recorded 2026-11-11; the owner can override them):

- **R1, the built-in set.** Seed exactly `@medplum/definitions`' `TERMINOLOGY_BUNDLE_FILES`: `v2-tables.json`, `v3-codesystems.json`, `valuesets.json`, `valuesets-medplum.json` and `valuesets-medplum-generated.json` (about 22 MB). The spec names only the first three, and Medplum seeds all five.
  - When a later entry has the same `url` (and `version`) as an earlier one, it replaces it, as in Medplum's `replaceExisting`.
  - Expected totals: `CodeSystem?_summary=count` = 1108 and `ValueSet?_summary=count` = 1346. This was measured on the owner's Medplum on 2026-11-11 as the `ga-test-parity` admin.
- **R2, built-ins are records.** Medplum shows its R4-project terminology to every project:
  - ordinary search, read and totals include it (the 2026-11-11 probe above);
  - a write to it is 403 (also probed).
  The store does the same. A built-in is a row in `resources` plus a row in a new table `builtin(rid integer primary key)`. PUT, PATCH and DELETE of a built-in, and `$import` into one, answer 403 with Medplum's OperationOutcome text (pin it from a parity test).
- **R3, no cost for GA.** The store seeds only when its type set includes `CodeSystem` or `ValueSet`. `GA_STORE_TYPES` contains neither and stays unchanged, so GA's store gets no seed. GA's store does get the ConceptMap mapping index (R7), because GA writes ConceptMaps.
- **R4, seeded once.**
  - A table `meta(key text primary key, value text)` stores `terminology` = the `@medplum/definitions` version. The store seeds when that value is missing or different, and a reseed replaces the old built-ins.
  - The seed runs in one transaction and writes the marker in that same transaction.
  - It reads one bundle file at a time and lets each go before reading the next.
  - Each built-in gets a stable id: the first 32 hex characters of `sha1(type|url|version)`, formatted as a UUID. A reseed then keeps the id unchanged.
- **R5, which resource an operation uses.** `findTerminology` follows Medplum's `findTerminologyResource` ordering:
  1. stored before built-in (Medplum ranks the own project before R4);
  2. CodeSystem content `complete` < `supplement` < `fragment` < `example` < `not-present`;
  3. version descending, missing first;
  4. `date` descending, missing first;
  5. `id`.
  It skips `status=retired`.
- **R6, `url|version` is honoured.** In Medplum 5.2.14's `findTerminologyResource`, `url` is sliced before the version is read from it, so a `|version` suffix is dropped and the version is ignored. The store honours the version. Test: `differs on purpose: url|version selects that version`.
- **R7, `$import` is in scope.** `CodeSystem/$import` and `ConceptMap/$import` are Medplum's own operations, not FHIR's. Many lookup and expand tests set up through them, and the rows are in the inventory.
  - The store implements them with project-admin semantics: it writes into a stored resource selected by id or `system`/`url`.
  - Rows that need a Super Admin, linked projects or an AccessPolicy are `skipped` with that reason.
- **R8, terminology search does more than Medplum.** Medplum 5.2.14 refuses `:in`, `:not-in`, `:above` and `:below` on tokens (`token-column.ts`: `invalidSearchOperator`). The spec puts them in scope and R4 defines them, so the store supports them.
  - Every parity test that pins "both sides 400" for them is retitled `differs on purpose:`. Known ones are in `tokens.test.ts` (`Condition.code :%s search`) and `search-more.test.ts` (`Patient?identifier:in=…` in the invalid-modifier table).
  - A value naming a ValueSet or CodeSystem the store does not hold is 400 naming it, never an exact-match fallback.
- **R9, a new index format.** `INDEX_VERSION` goes from 4 to 5 (new tables, and existing ConceptMaps and CodeSystems need their rows). Older files are refused with `IndexFormatError`, as today. GA's store is not in use. On a development machine, GA's existing message already gives the fix: move the file aside and run `ga migrate-store`.
- **R10, where the code goes.**
  - New files: `src/store/terminology.ts` (concept index, seed, `findTerminology`, `$lookup`, CodeSystem `$validate-code`, `$subsumes`, CodeSystem `$import`), `src/store/expand.ts` (`$expand`, ValueSet `$validate-code`, the membership test the search modifiers use) and `src/store/conceptmap.ts` (mapping index, `$translate`, ConceptMap `$import`).
  - `server.ts` gains one routing branch, and `search.ts` gains only the modifier hooks.
  - Logic ported from Medplum carries the two SPDX lines from Medplum's header, as `vendor/medplum-ccda/*.ts` does, and names the source file in a comment.
- **R11, memory.** `src/store/test/terminology-memory.test.ts` runs the seed in a child process and measures peak RSS on a store with all types. It must stay under 220 MiB (ga-store's budget in the measured 512 MB configuration). Write the number into `docs/superpowers/spikes/2026-11-11-store-terminology-memory.md`.

## Review Focus

1. **A modifier or operation that names terminology the store does not hold** (`code:below=http://unknown|x`, `code:in=http://unknown/vs`, `$expand?url=<missing>`). It must answer 400 naming the missing url, never match exactly or return nothing. Tests: Task 6 `unknown system or ValueSet is 400 for every terminology modifier`, Task 4 `ValueSet not found [expand.test.ts]`.
2. **Expanding a large built-in ValueSet** (one including a whole v3 CodeSystem with hundreds of codes, or a `filter` with no text). It must respect `count` and `offset` as Medplum does, and its working memory must be bounded by `count`, not by the CodeSystem's size. Test: Task 4 `expand of a large built-in ValueSet pages by count and offset`.
3. **Updating a stored CodeSystem whose concepts changed.** A removed code no longer answers `$lookup`, `$expand` or `:below`. Deleting the CodeSystem removes all its rows. Test: Task 2 `update replaces concept rows; delete removes them`.
4. **A store that stopped mid-seed** (killed or out of memory). On the next open it has no half set: either every built-in or none, and then the full set. Test: Task 2 `interrupted seed leaves no built-ins and the next open seeds`.
5. **Cycles:**
   - a CodeSystem whose parents loop (A is-a B is-a A);
   - a ValueSet that includes itself through another ValueSet.
   `:below`, `$subsumes` and `$expand` must finish: Medplum's "Returns error for recursive definition" behaviour for ValueSets, and no infinite recursion for CodeSystems. Tests: Task 3 `cyclic is-a parents end`, Task 4 `Returns error for recursive definition [expand.test.ts]`.

---

## File Structure

- `src/store/terminology.ts`:
  - the concept index (`indexCodeSystem`, `dropCodeSystem`);
  - the seed (`seedTerminology`);
  - `findTerminology`;
  - the CodeSystem operations, and `isBuiltin`.
- `src/store/expand.ts`: `expandValueSet`, ValueSet `$validate-code`, and `inValueSet` / `subsumedCodes` for search.
- `src/store/conceptmap.ts`: the mapping index (`indexConceptMap`), `$translate`, ConceptMap `$import`.
- Modify:
  - `src/store/store.ts`: the schema, `INDEX_VERSION` 5, write hooks, the built-in guard and calling the seed on open;
  - `src/store/search.ts`: the token modifiers and `_filter` operators;
  - `src/store/server.ts`: operation routing and the CapabilityStatement operations.
- Tests:
  - `src/store/test/terminology.test.ts`, `expand.test.ts`, `conceptmap.test.ts`, `terminology-memory.test.ts`;
  - `tests/integration/parity/terminology.test.ts` (lookup, validate-code, subsumes, CodeSystem import);
  - `tests/integration/parity/expand.test.ts` (expand, ValueSet validate-code);
  - `tests/integration/parity/conceptmap.test.ts` (translate, ConceptMap import);
  - `tests/integration/parity/harness.ts` (sweep types).
- Docs:
  - `src/store/README.md`;
  - `docs/superpowers/specs/2026-11-08-sqlite-store-design.md` ("Next phase");
  - `docs/superpowers/spikes/2026-11-11-store-terminology-memory.md`;
  - `INVENTORY.md`.

---

### Task 1: Triage the 161 deferred rows

No product code. This settles the real porting scope before anything is built.

**Files:**
- Modify: `tests/integration/parity/INVENTORY.md`
- Modify: `tests/parity-inventory.test.ts`

**Interfaces:**
- Produces: every `plan-2` row becomes either `skipped` with a reason, or `skipped` with note `not yet ported (Task N)` (N = 3, 4 or 5, by source file), with feature `terminology`. The status `plan-2` is then no longer allowed.

- [ ] **Step 1: Write the failing check** in `tests/parity-inventory.test.ts`:

```ts
test('no row is deferred to plan 2', () => { /* no row has status plan-2 */ });
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run --project unit tests/parity-inventory.test.ts`. Expected: FAIL, naming 161 rows.
- [ ] **Step 3: Triage each row** against its Medplum test body (the clone at `<scratchpad>/medplum-5.2.14`). Mark these `skipped`, each with its reason:
  - tests that need a Super Admin: "Base resources are not shadowed for Super Admin", "Returns error on non-SuperAdmin user", "Allows Super Admin to import into base CodeSystem by ID", and any whose setup uses `getSuperAdminAccessToken` for the step under test;
  - tests of linked projects or project scoping: "Prefers CodeSystem from linked Projects in link order", "Checks project", "Prevents writes by Project admin to linked …";
  - AccessPolicy permission tests ("Requires update permission …"), with the reason "access policy";
  - tests that call in-process functions rather than the API: `countCandidatesBounded`, `addExpansionItems()`, `expansionQuery`, `hydrateCodeSystemProperties`, `importConceptMap()`, `validateCodings`, "Cost-based parent-filter strategy", and any other row whose body never sends an HTTP request.
  Every other row gets `not yet ported (Task N)`: 3 for codesystemlookup, codesystemvalidatecode, subsumes and codesystemimport; 4 for expand and valuesetvalidatecode; 5 for conceptmaptranslate and conceptmapimport. Put the counts per status in the task report.
- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "test(parity): triage the terminology rows deferred by plan 1"`

### Task 2: Concept index, built-in terminology and `findTerminology`

**Files:**
- Create: `src/store/terminology.ts`, `src/store/test/terminology.test.ts`, `src/store/test/terminology-memory.test.ts`
- Modify: `src/store/store.ts` (schema, `INDEX_VERSION = 5`, write hooks, built-in guard, seed on open), `tests/integration/parity/harness.ts` (sweep)
- Test: `tests/integration/parity/terminology.test.ts` (created here, with the built-in rows below)

**Interfaces:**
- Produces, in `terminology.ts`:
  - **Tables** (in the store's schema string):
    - `coding(id integer primary key, system integer not null /* CodeSystem rid */, code text not null, display text, language text, synonymOf integer, unique(system, code, language, display))`;
    - `coding_property(coding integer not null, property integer not null, value text, target integer /* coding id for code-valued (relationship) properties */)`, with indexes on `(coding, property)` and `(target, property)`;
    - `codesystem_property(id integer primary key, system integer not null, code text not null, uri text, type text, description text, unique(system, code))`;
    - `builtin(rid integer primary key)`;
    - `meta(key text primary key, value text)`.
  - `indexCodeSystem(db: DatabaseSync, rid: number, cs: CodeSystem): void`:
    - only when `content` is `complete`, `example` or `fragment` (Medplum's `CodingTable`);
    - nested `concept` children get an implicit `parent` property row (`http://hl7.org/fhir/concept-properties#parent`), and each `designation` becomes a `coding` row with `synonymOf`.
  - `dropCodeSystem(db: DatabaseSync, rid: number): void`
  - `seedTerminology(store: Store): void` (R1, R3, R4)
  - `isBuiltin(db: DatabaseSync, rid: number): boolean`
  - `findTerminology<T extends CodeSystem | ValueSet | ConceptMap>(store: Store, type: T['resourceType'], url: string, version?: string): T & { id: string }`
    - It throws 400 `${type} ${url} not found` (Medplum's text) when nothing matches. It parses `url|version` (R6) and orders the results by R5.
  - `parentProperty(cs: CodeSystem): CodeSystemProperty`: Medplum's `getParentProperty` (400 when `hierarchyMeaning` is set to something other than `is-a`).
- Consumes: `Store` (`store.ts`), and `TERMINOLOGY_BUNDLE_FILES` from `@medplum/definitions`. Read the files the way `definitions.ts` does (`readFileSync(new URL(f, FHIR_R4))`); `@medplum/definitions`' own `readJson` is not used, for the reason given in that file.

- [ ] **Step 1: Write the failing unit tests** in `src/store/test/terminology.test.ts` (store only, no Medplum):

```ts
test('a complete CodeSystem indexes codes, nested parents and designations', () => {
  // CodeSystem content complete, concept A with child B (nested) and a designation on A
  // → coding rows A, B and A's synonym; B has a parent property row targeting A
});
test('example and fragment CodeSystems are indexed; not-present is not', () => { /* … */ });
test('update replaces concept rows; delete removes them', () => {
  // v1 has codes A, B; update to A only → no row for B; delete → no rows for that rid
});
test('findTerminology orders stored before built-in, then content, version, date, id', () => {
  // two stored CodeSystems with the same url: complete beats example even when example has a newer version (R5)
});
test('findTerminology skips retired and is 400 when nothing matches', () => {
  expect(() => findTerminology(store, 'CodeSystem', 'http://none')).toThrow('CodeSystem http://none not found');
});
test('findTerminology honours url|version', () => { /* R6 */ });
test('seed: totals, read-only, stable ids', () => {
  // store opened with all types: CodeSystem?_summary=count → 1108; ValueSet → 1346
  // PUT, PATCH, DELETE of a built-in → 403; reopen → no reseed (meta.terminology unchanged), same ids
});
test('no seed without CodeSystem or ValueSet in the type set', () => { /* store with GA-like types: no builtin rows, no meta key */ });
test('interrupted seed leaves no built-ins and the next open seeds', () => {
  // make the seed throw part way (a test hook: a bundle-file list option on seedTerminology), reopen → full set
});
test('a stored CodeSystem with a built-in url is found first', () => { /* R5: stored before built-in */ });
test('old index version is refused', () => { /* a file with user_version 4 → IndexFormatError */ });
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run --project unit src/store/test/terminology.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - **Write path.** `Store.create`, `update`, `put` and `delete` call `indexCodeSystem` or `dropCodeSystem` for CodeSystem, in the same transaction as the resource row.
  - **Built-in guard.** Writes to a rid in `builtin` throw `StoreError(403, …)`.
  - **Seed on open.** The `Store` constructor calls `seedTerminology` after the schema step, when R3 applies.
  - **Harness sweep.** Add `CodeSystem`, `ValueSet` and `ConceptMap` to `PARITY_TYPES`. The sweep skips any resource whose `meta.project` is not the parity project's id (the built-ins), so it never tries to delete a built-in.
- [ ] **Step 4: Port the built-in parity checks** into `tests/integration/parity/terminology.test.ts`, as plain parity tests (not inventory rows; title them with `[store-plan-2]` instead of a Medplum file, and add that file tag to the inventory check's allowed non-Medplum tags):
  - `built-in totals match` (1108 and 1346 on both sides);
  - `a write to a built-in is 403` (same status and OperationOutcome code on both).
  Built-in ids differ between the two servers, so compare by `url`.
- [ ] **Step 5: Write the memory test** `src/store/test/terminology-memory.test.ts`.
  - It runs `node src/store/serve.ts` with all types on a temporary file in a child process, waits for `/healthz`, and reads its peak RSS from `process.resourceUsage().maxRSS`, reported over a one-line stdout hook or `/proc`. Pick whichever works on both macOS and Linux.
  - It asserts peak RSS stays under 220 MiB (R11).
  - Write the measured numbers (peak RSS, seed time, file size added) to the spike file.
- [ ] **Step 6: Run** `npm test`, `npx vitest run --project integration tests/integration/parity/` and the perf test. Expected: PASS, with the unit tests updated for `INDEX_VERSION` 5.
- [ ] **Step 7: Commit.** `git commit -m "feat(store): concept index and built-in HL7 terminology (read-only, seeded once); findTerminology"`

### Task 3: CodeSystem operations: `$lookup`, `$validate-code`, `$subsumes`, `$import`

**Files:**
- Modify: `src/store/terminology.ts`, `src/store/server.ts` (routing, CapabilityStatement)
- Test: `src/store/test/terminology.test.ts`, `tests/integration/parity/terminology.test.ts`; the Task 3 rows in `INVENTORY.md` become `ported`

**Interfaces:**
- Consumes: Task 2 (`findTerminology`, the tables, `parentProperty`).
- Produces:
  - `lookup(store: Store, p: Params): Parameters`, `validateCodeCs(store: Store, p: Params): Parameters`, `subsumes(store: Store, p: Params): Parameters`, `importCodeSystem(store: Store, p: Params): Parameters`.
    - `Params` is `{ id?: string; get(name: string): string | undefined; coding(name: string): Coding | undefined; all(name: string): ParametersParameter[] }`. It is built from a GET query or a POST `Parameters` body by one function in `server.ts`: `operationParams(r: Req): Params`.
  - Routes, matching Medplum's `routes.ts`: GET and POST `CodeSystem/$lookup`, `CodeSystem/<id>/$lookup`, the same for `$validate-code` and `$subsumes`; POST `CodeSystem/$import` and `CodeSystem/<id>/$import`.
  - The CapabilityStatement lists each operation, with Medplum's `OperationDefinition` url from `profiles-medplum.json` or the HL7 one.
- Port Medplum's `codesystemlookup.ts`, `codesystemvalidatecode.ts`, `subsumes.ts` and `codesystemimport.ts`, adapted to SQLite. Take the parameters and output shape from the Medplum source, not from memory.

- [ ] **Step 1: Write the failing unit tests**, one per Medplum behaviour, reduced to the store. Include these:

```ts
test('cyclic is-a parents end', () => {
  // CodeSystem with A parent B, B parent A: $subsumes A B answers (no hang); :below in Task 6 reuses the same walk
});
test('$lookup by system and code returns name, display, designations and properties', () => { /* … */ });
test('$import adds concepts and properties to a stored CodeSystem; into a built-in is 403', () => { /* R2, R7 */ });
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement and route.** A recursive CTE over `coding_property` (parent property) walks the hierarchy. `union` (not `union all`) makes a cycle end.
- [ ] **Step 4: Port the Task 3 inventory rows** into `tests/integration/parity/terminology.test.ts`. Medplum's `request(app).post('/fhir/R4/CodeSystem/$lookup')` becomes `side.call('POST', 'CodeSystem/$lookup', parameters)`. Compare `shape` of the output `Parameters` on both sides.
  - Fix store failures the plan-1 way: a unit test first, then the fix.
  - Where Medplum is against the spec, write a `differs on purpose:` test and a README bullet.
- [ ] **Step 5: Run** unit, parity and perf. Expected: PASS.
- [ ] **Step 6: Commit** per source file: `git commit -m "test(parity): port <file> (Medplum 5.2.14); feat(store): <operation>"`.

### Task 4: `$expand` and ValueSet `$validate-code`

**Files:**
- Create: `src/store/expand.ts`, `src/store/test/expand.test.ts`, `tests/integration/parity/expand.test.ts`
- Modify: `src/store/server.ts` (routes GET and POST `ValueSet/$expand`; GET and POST `ValueSet/$validate-code`, `ValueSet/<id>/$validate-code`)
- Test: the Task 4 rows in `INVENTORY.md` become `ported`

**Interfaces:**
- Consumes: Task 2 and Task 3 (`findTerminology`, the hierarchy walk).
- Produces:
  - `expandValueSet(store: Store, vs: ValueSet, opts: { filter?: string; count?: number; offset?: number; displayLanguage?: string; excludeNotForUI?: boolean }): ValueSet`. It returns `expansion.contains` in Medplum's order, with Medplum's defaults and limits for `count` and `offset`, read from `expand.ts` 5.2.14 and pinned in consts.
  - `validateCodeVs(store: Store, p: Params): Parameters`
  - `inValueSet(store: Store, url: string): { sql: string; args: Arg[] }`: an SQL subquery selecting `(system, code)` pairs of the ValueSet's membership, for Task 6. It throws 400 when the ValueSet is not found.
  - `subsumedCodes(store: Store, system: string, code: string, dir: 'below' | 'above'): { sql: string; args: Arg[] }`: a subquery of the codes at or under (below) or at or over (above) a code, for Task 6. It throws 400 when the CodeSystem is not held or not hierarchical.
- Port Medplum's `expand.ts` and `valuesetvalidatecode.ts`: `compose.include` and `exclude` with `concept`, `filter` (`is-a`, `descendent-of`, `=`, `in`, `exists`, property filters, `regex` only if Medplum supports it) and `valueSet`; a pre-expanded `expansion`; and the text filter (Medplum's tokenizing and punctuation rules).

- [ ] **Step 1: Write the failing unit tests**, including:

```ts
test('expand of a large built-in ValueSet pages by count and offset', () => {
  // a built-in ValueSet that includes a whole v3 CodeSystem: count=10 → 10 codes; offset=10 → the next 10, no overlap;
  // the query uses SQL limit/offset (no materialised full list)
});
test('a ValueSet including itself through another is 400 (recursive definition)', () => { /* … */ });
test('inValueSet and subsumedCodes throw 400 naming a url the store does not hold', () => { /* … */ });
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement and route.** Expansion builds one SQL query over `coding` per include, with `limit` and `offset` in SQL.
- [ ] **Step 4: Port the Task 4 rows** into `tests/integration/parity/expand.test.ts`, the same way as in Task 3. Medplum's text-filter ranking ("Sort order is deterministic when rows tie on relevance") must order the same way on both sides. Compare `expansion.contains` exactly.
- [ ] **Step 5: Run** unit, parity and perf. Expected: PASS.
- [ ] **Step 6: Commit** per source file.

### Task 5: ConceptMap: mapping index, `$translate`, `$import`

**Files:**
- Create: `src/store/conceptmap.ts`, `src/store/test/conceptmap.test.ts`, `tests/integration/parity/conceptmap.test.ts`
- Modify: `src/store/store.ts` (write hooks for ConceptMap), `src/store/server.ts` (routes GET and POST `ConceptMap/$translate`, `ConceptMap/<id>/$translate`; POST `ConceptMap/$import`, `ConceptMap/<id>/$import`)
- Test: the Task 5 rows in `INVENTORY.md` become `ported`

**Interfaces:**
- Consumes: Task 2 (`findTerminology`), Task 3 (`Params`, `operationParams`).
- Produces:
  - A table `concept_mapping(map integer not null /* ConceptMap rid */, sourceSystem text, sourceCode text not null, sourceDisplay text, targetSystem text, targetCode text, targetDisplay text, relationship text, comment text)`, with an index on `(map, sourceSystem, sourceCode)`. It is filled on ConceptMap write from `group[].element[].target[]`, plus `$import` rows, as Medplum's `ConceptMapping` table is. `$import` rows survive an update of the ConceptMap's inline groups ("Import does not clobber or duplicate inline mappings").
  - `indexConceptMap(db: DatabaseSync, rid: number, cm: ConceptMap): void`, `translate(store: Store, p: Params): Parameters`, `importConceptMap(store: Store, p: Params): Parameters`.
- Port Medplum's `conceptmaptranslate.ts` and `conceptmapimport.ts`.

- [ ] **Step 1: Write the failing unit tests** (one per Medplum behaviour, reduced), plus:

```ts
test('a store opened with GA_STORE_TYPES-like types indexes ConceptMaps without seeding terminology', () => { /* R3 */ });
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement and route.**
- [ ] **Step 4: Port the Task 5 rows.** Then run GA's concept-layer tests on the SQLite store: `GA_STORE=sqlite npx vitest run --project integration tests/integration/` filtered to files that write ConceptMaps (`grep -l ConceptMap tests/integration/*.test.ts`). Expected: PASS. GA's ConceptMaps now get mapping rows, and nothing GA reads changes.
- [ ] **Step 5: Run** unit, parity and perf. Expected: PASS.
- [ ] **Step 6: Commit** per source file.

### Task 6: Terminology search: token `:in`, `:not-in`, `:above`, `:below`; `_filter` `in`, `ni`, `ss`, `sb`

**Files:**
- Modify: `src/store/search.ts` (`ALLOWED.token`, `valueSql`'s token case, `filterExpr`)
- Modify: `tests/integration/parity/tokens.test.ts`, `tests/integration/parity/search-more.test.ts` (retitle per R8)
- Test: `src/store/test/search.test.ts`

**Interfaces:**
- Consumes: Task 4 (`inValueSet`, `subsumedCodes`).
- Produces:
  - `code:in=<ValueSet url>`: a token row whose `(sys, val)` is in `inValueSet(url)`.
  - `:not-in`: no such row, the same as `:not`.
  - `code:below=<system>|<code>` and `code:above=…`: a row with `sys = system` and `val` in `subsumedCodes(…)`. A value with no system is 400.
  - `_filter` `in` and `ni` (ValueSet) and `ss` and `sb` (subsumes and subsumed by) map to the same conditions.
  - The store's `search.ts` gains no knowledge of terminology tables beyond calling these two functions.

- [ ] **Step 1: Write the failing unit tests:**

```ts
test('code:in matches codes of a ValueSet (built-in and stored) and :not-in the rest', () => { /* Condition coded marital-status codes, etc. */ });
test('code:below and :above follow is-a, cycles end', () => { /* A > B > C: code:below=sys|A → A,B,C; code:above=sys|C → A,B,C */ });
test('unknown system or ValueSet is 400 for every terminology modifier', () => {
  // :in, :not-in, :above, :below and _filter in/ni/ss/sb each name the missing url
});
test('_filter code in, ni, ss, sb', () => { /* … */ });
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Add `IN`, `NOT_IN`, `ABOVE` and `BELOW` to `ALLOWED.token`. `multi` is true for these, so the existing driver choice holds.
- [ ] **Step 4: Retitle the parity tests that break** (R8): `Condition.code :%s search [server/src/fhir/tokens.test.ts]` becomes `differs on purpose: …`, asserting Medplum 400 and the store's 200 matches. In `search-more.test.ts`'s invalid-modifier table, move `Patient?identifier:in` and `:not-in` into a `differs on purpose` test that asserts each side's own result. Add the README bullet. Run every parity file to find any other row that pinned these modifiers.
- [ ] **Step 5: Run** unit, parity and perf. The perf searches are unchanged and must stay within their limits. Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(store): token :in/:not-in/:above/:below and _filter in/ni/ss/sb over the store's terminology (more than Medplum, R4)"`

### Task 7: Gate and docs

**Files:**
- Modify: `tests/parity-inventory.test.ts` (gate), `src/store/README.md`, `docs/superpowers/specs/2026-11-08-sqlite-store-design.md` ("Next phase"), `docs/superpowers/spikes/2026-11-11-store-terminology-memory.md`, `AGENTS.md` (store line, only if its wording changes)

- [ ] **Step 1: Confirm the gate.** The existing `no row is left "not yet ported"` and Task 1's `no row is deferred to plan 2` both PASS.
- [ ] **Step 2: Run everything.** `npm test`, `npm run test:int` and the perf and memory tests. Record these counts in the commit message:
  - Task 3, 4 and 5 rows ported;
  - rows skipped, with reasons grouped;
  - new deliberate differences.
- [ ] **Step 3: Docs.**
  - README:
    - an API section for the new exports;
    - the HTTP surface (the operations, the token modifiers, the `_filter` operators);
    - built-in terminology (R1–R4: what it is, when it is seeded, read-only);
    - "Deliberate differences" (R6, R8 and every new `differs on purpose` test);
    - `INDEX_VERSION` 5.
  - Store spec, "Next phase": move the terminology line to the done paragraph.
- [ ] **Step 4: Commit.** `git commit -m "docs(store): parity plan 2 done: <n> ported, <n> skipped, <n> deliberate differences; terminology memory <peak> MiB"`
