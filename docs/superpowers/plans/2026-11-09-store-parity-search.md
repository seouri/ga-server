# Store parity, plan 1 of 4: parity harness and search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA's SQLite store passes every record-related Medplum 5.2.14 server test except terminology and GraphQL, ported into a side-by-side harness that runs each scenario against Medplum and the store.

**Architecture:** A parity harness (`tests/integration/parity/`) drives both servers over HTTP. On the Medplum side it uses an admin login scoped to a long-lived `ga-test-parity` project. On the store side it uses a temp store with all 147 types. An inventory file lists every Medplum test in scope as ported, skipped (with a reason) or deferred to a later plan, and a unit test checks that the inventory and the test titles agree. Search features are then added to `src/store/search.ts` (and `server.ts` for the system-level `_type` search) feature by feature, each driven by the ported tests that fail.

**Tech Stack:** Node 26 (strip-only TypeScript), `node:sqlite`, `@medplum/core` 5.2.14, vitest 5.1.0.

**Spec:** `docs/superpowers/specs/2026-11-09-full-fhir-store-design.md`

**The other plans** (written when this one is done, each from the same spec): plan 2 covers terminology (built-in HL7 terminology, `$expand`/`$lookup`/`$validate-code`, `:in`/`:not-in`, token `:above`/`:below`, and the terminology tests deferred here); plan 3 covers GraphQL (the `graphql` dependency, and the `fhir-router` GraphQL tests deferred here); plan 4 covers the Touchstone Basic and Advanced suites (including `_text`, `_content`, `_contained` and special parameters if Touchstone tests them) and the `SWITCH_READY` commit.

## Global Constraints

- `src/store` imports only `node:*`, `@medplum/core`, `@medplum/fhirtypes`, `@medplum/definitions` and its own files (tests also `vitest`); no file there mentions GA. `src/store/test/boundary.test.ts` must stay green. (The `graphql` package is added in plan 3, not here.)
- Unsupported stays loud: anything the store does not support answers 400 (or 404/405 for an unknown route) with an OperationOutcome naming it, never a wrong answer.
- The FHIR R4 specification wins when Medplum and the spec disagree. A deliberate difference is a bullet in `src/store/README.md` "Deliberate differences from Medplum" plus a parity test titled `differs on purpose: …` that asserts each side's own behaviour.
- Tests never touch the owner's record. The Medplum side writes only in the `ga-test-parity` project, through an admin login scoped to it. The harness throws unless that project's name starts with `ga-test`, and deletes everything a run wrote. The `Guardian Angel` project is never read or written.
- No PHI and no hospital or personal names in the repo, test data, logs or commits; test data is synthetic.
- Performance: no existing search may get slower. `src/store/test/perf.test.ts` (created in Task 1) must stay green, and the store stays within the 512 MB container budget. Its RSS check is part of that test.
- The parity file names its Medplum source in each test title: `<Medplum test name> [<file>]`, e.g. `Token not equals [search.test.ts]`.
- Medplum version: 5.2.14 (tag `v5.2.14` of github.com/medplum/medplum). Its source is read from a local clone outside the repo, never vendored.
- Commits: conventional style, no attribution lines, no push.

## Review Focus

1. **Leftovers from a crashed run in `ga-test-parity`:** a later run must still pass, and its first step deletes them. Every ported scenario uses its own random marker (identifier, tag or name) so old data cannot match. Test: Task 1 `sweeps leftovers before the run`.
2. **Paging a parity search past one page:** both sides' next links must be followed to the end with no repeats and no gaps. This includes cursor pages of `_type` searches and pages that end on an `_include` boundary. Tests: Task 3 `_include on page boundary [search.test.ts]`, Task 5 `Cursor pagination with multiple resource types from _type [search.test.ts]`.
3. **Deeper chains and nested `_has` on a one-patient store** (nearly every record references the one Patient) must not turn into full scans that blow the 30 s test timeout or the perf limits. Test: Task 6 `deep chain stays within the perf limit` (store unit test, 20k Observations).
4. **A Medplum limit the store lacks** (chain length, include depth, `_count` max, `_offset` max) must answer the same way as Medplum, or be a recorded deliberate difference, and never be silently ignored. Tests: Task 3 `Search offset max [search.test.ts]`, Task 6 `Rejects too long chained search [search.test.ts]`, Task 4 `_include depth limit [search.test.ts]`.
5. **An index format change** (new rows for canonical references or composites) must refuse an old file with `IndexFormatError` rather than answer from a half-built index. Test: Task 7 `old index version is refused` (bump `INDEX_VERSION`).

---

## File Structure

- `tests/integration/parity/harness.ts`: the two sides, the `both()` runner, cleanup and the project guard.
- `tests/integration/parity/INVENTORY.md`: one row per Medplum test in scope.
- `tests/integration/parity/<area>.test.ts`: ported tests by Medplum source file: `search.test.ts`, `search-params.test.ts`, `repo.test.ts`, `batch.test.ts`, `binary.test.ts`, `metadata.test.ts`, `patient.test.ts`, `references.test.ts`, `tokens.test.ts`, `searchunique.test.ts`, `fhirrouter.test.ts`, `search-include.test.ts`. Names follow the source file; the builder may split a large one into `search-<feature>.test.ts`.
- `tests/parity-inventory.test.ts` (unit): the inventory and the titles agree.
- `tests/temp-store.ts`: `tempStore()` takes the type set.
- `src/store/search.ts`: search features. If it grows past about 900 lines, split the filters (`cond`, chains, `_has`, `_filter`) into `src/store/filters.ts`.
- `src/store/server.ts`: the system-level search route.
- `src/store/README.md`, `docs/superpowers/specs/2026-11-08-sqlite-store-design.md` ("Next phase" list), `AGENTS.md` (store line): docs, updated in the task that changes the behaviour.

---

### Task 1: Parity harness

**Files:**
- Create: `tests/integration/parity/harness.ts`
- Create: `tests/integration/parity/harness.test.ts`
- Create: `src/store/test/perf.test.ts` (the perf baseline later tasks must keep)
- Modify: `tests/temp-store.ts` (type set parameter)

**Interfaces:**
- Consumes: `throwawayConfig()`, `retryLimited()` and `SQLITE` from `tests/integration/helpers.ts`; `setup(baseUrl, { projectName })` from `src/setup.ts` (creates the project the first time, finds it by name after); `bearer()` from `src/config.ts`; `serveStore` from `src/store/server.ts`.
- Produces:
  - `tempStore(dir?: string, types?: readonly string[] | 'all'): Promise<TempStore>`. The default stays `GA_STORE_TYPES`; `'all'` passes no `types` (every R4 type).
  - `type Got = { status: number; headers: Headers; json: any; text: string }`
  - `type Side = { name: 'medplum' | 'store'; base: string; call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Got>; create<T extends Resource>(r: T): Promise<T & { id: string }> }`. `path` is relative to `fhir/R4/`. `create` POSTs, expects 201 and records the id for cleanup. Any `call` that answers 201 records `Location` too.
  - `paritySides(): Promise<{ sides: [Side, Side]; close(): Promise<void> }>`: the Medplum side (admin login scoped to `ga-test-parity`) and the store side (`tempStore(undefined, 'all')`). `close()` deletes every recorded Medplum resource (newest first, ignoring 404/410) and closes the store.
  - `both<T>(sides: [Side, Side], fn: (s: Side) => Promise<T>): Promise<[T, T]>`
  - `marker(): string`: a random value (`parity-<uuid>`) a test puts in an identifier, tag or name so only its own records match.
  - `shape(x: unknown, base: string): unknown`: the same normaliser as `store-compat.test.ts` (move it here and import it there).

- [ ] **Step 1: Write the failing tests** in `harness.test.ts` (integration; `describe.skipIf(SQLITE)`):

```ts
test('the Medplum side is an admin login scoped to a ga-test project', async () => {
  const me = (await sides[0].call('GET', '../../auth/me')).json; // fhir/R4/../../auth/me
  expect(me.project.name).toBe('ga-test-parity');
  expect(me.membership.admin).toBe(true);
});
test('refuses a project that is not ga-test*', async () => {
  await expect(guardProject({ project: { name: 'Guardian Angel' } })).rejects.toThrow('not a ga-test project');
});
test('records created ids and deletes them on close', async () => {
  const m = marker();
  const o = await sides[0].create({ resourceType: 'Basic', code: { text: m } });
  await close();
  expect((await fresh.call('GET', `Basic/${o.id}`)).status).toBeGreaterThanOrEqual(404); // 404 or 410
});
test('sweeps leftovers before the run', async () => {
  // a Basic coded `parity-leftover` written by a crashed run is gone after paritySides()
});
test('store side accepts a type outside GA_STORE_TYPES', async () => {
  expect((await sides[1].call('POST', 'ResearchStudy', { resourceType: 'ResearchStudy', status: 'active' })).status).toBe(201);
});
```

Also export `guardProject(me: { project: { name?: string } }): Promise<void>` for the guard test.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run --project integration tests/integration/parity/harness.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `harness.ts` and the `tempStore` change.**
  - The Medplum side: `throwawayConfig()` gives the Super Admin session. Then `setup(baseUrl, { projectName: 'ga-test-parity' })` finds or creates the project. Then log `admin@example.com` in again with `projectId` set to that project (the `startLogin` + `processCode` pattern of `throwawayConfig`) and call `guardProject(await client.get('auth/me'))`.
  - The sweep: delete every resource in the project whose `meta.author` is that admin's profile (the login's `auth/me` `profile`), for each type the inventory's ported tests create. The list is a constant `PARITY_TYPES` in `harness.ts`, extended by later tasks. It skips GA setup's self Patient (identifier value `self`), as `emptyTestProject` does, so `setup` keeps finding it.
  - Medplum allows 5 password logins a minute. This makes one login per file (integration files already run one at a time).
  - `src/store/test/perf.test.ts` (unit, store only) sets up one Patient with 20,000 synthetic Observations (5 codes, dates over 10 years, half with `category` `laboratory`), on a store opened with every type. It times these searches, median of 5 runs each:
    - `Observation?code=<one code>&_sort=-date&_count=100`
    - `Observation?category=laboratory&date=ge<5 years ago>&_count=1000`
    - `Observation?subject=Patient/<id>&_count=20`
    - `Patient?_has:Observation:subject:code=<one code>`
    - `Observation?subject:Patient.birthdate=<its date>&_count=20`
  - First run the timing on main and pin each limit at 1.5× the measured median, rounded up to 10 ms (record the measured numbers in a comment).
  - The test also asserts `process.memoryUsage().rss` after the run is under 300 MB. That leaves room in the 512 MB budget for the gateway and sync.

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS. Then `npx vitest run --project integration tests/integration/store-compat.test.ts`: still PASS with `shape` imported.

- [ ] **Step 5: Commit.** `git add tests/ && git commit -m "test(parity): side-by-side harness for Medplum parity (ga-test-parity project, all-types temp store)"`

### Task 2: Inventory and its check

**Files:**
- Create: `tests/integration/parity/INVENTORY.md`
- Create: `tests/parity-inventory.test.ts`

**Interfaces:**
- Produces: the inventory format, one Markdown table row per Medplum test (each `test.each` case counts once, by its title template):
  `| <file> | <test title, describe path joined with " › "> | <status> | <feature> | <note> |`
  - status `ported`, `skipped` or `plan-2` / `plan-3` (deferred to terminology or GraphQL);
  - feature: one of `existing`, `summary`, `type`, `include`, `chain`, `modifier`, `composite`, `filter`, `meta`, `terminology`, `graphql`, `platform`;
  - note: required for `skipped` (the reason, e.g. "SQL planner internals", "access policy", "project/_project", "reindex job").

- [ ] **Step 1: Clone Medplum 5.2.14 outside the repo.** `git clone --depth 1 --branch v5.2.14 https://github.com/medplum/medplum <scratchpad>/medplum-5.2.14`. Record the path in the task report, not in the repo.

- [ ] **Step 2: Write the failing check** in `tests/parity-inventory.test.ts`:

```ts
test('every ported row has a parity test with its title and file', () => {
  // read INVENTORY.md rows with status ported; read every tests/integration/parity/*.test.ts;
  // each row's `${title} [${file}]` appears as a test title (string literal) in some parity file
});
test('every parity test title is in the inventory as ported', () => { /* the reverse */ });
test('every skipped row has a reason', () => { /* note non-empty */ });
test('no row is still todo', () => { /* status in the four allowed values */ });
```

- [ ] **Step 3: Run to verify it fails.** `npx vitest run --project unit tests/parity-inventory.test.ts`. Expected: FAIL (no inventory).

- [ ] **Step 4: Write `INVENTORY.md`.** These files are in scope: `packages/server/src/fhir/` `search.test.ts`, `search-params.test.ts`, `batch.test.ts`, `repo.test.ts`, `binary.test.ts`, `metadata.test.ts`, `patient.test.ts` (`$everything`), `references.test.ts`, `tokens.test.ts`, `searchunique.test.ts`, the terminology operation tests (`packages/server/src/fhir/operations/expand.test.ts`, `lookup.test.ts`, `validatecode.test.ts`, `codesystemvalidatecode.test.ts`, `subsumes.test.ts` where present: all `plan-2`), and `packages/fhir-router/src/` `fhirrouter.test.ts`, `batch.test.ts`, `search-include.test.ts` (or its 5.2.14 name), `graphql/*.test.ts` (`plan-3`).
  - Confirm each file exists at 5.2.14 and record the real names; add any other record-related test file you find under `packages/server/src/fhir/` and say so in the report.
  - In this task every in-scope row starts as `skipped` with note `not yet ported (Task N)`, naming the task that ports it. The check's "no row is still todo" passes. The final task (Task 9) fails any row whose note still says "not yet ported".
  - Rows that test Medplum internals (`getCount`, SQL shape, `disableChainedSearch`, `discourage sequential scans`, `systemRepo` `_project`, `maxResourceVersion`, `parseChainedParameter` unit tests): `skipped` with the reason.

- [ ] **Step 5: Run to verify it passes.** Same command. Expected: PASS.

- [ ] **Step 6: Commit.** `git commit -m "test(parity): inventory of Medplum 5.2.14 record tests in scope, with a consistency check"`

### Task 3: Port the tests of features the store already has

Ports every inventory row with feature `existing` (plain search on all parameter types, prefixes, `:missing`/`:exact`/`:contains`/`:text`/`:not`, one-level chains and `_has`, `_include`/`_revinclude` without iterate, `_sort`, `_count`, `_offset`, `_elements`, `_total`, cursor paging, next and previous links) and the non-search files (`repo`, `batch`, `binary`, `metadata`, `patient` `$everything`, `references`, `tokens`, `searchunique`, `fhirrouter`). It fixes every difference found, or records it as deliberate.

**Files:**
- Create: `tests/integration/parity/<area>.test.ts` (one per source file)
- Modify: `src/store/search.ts`, `src/store/server.ts`, `src/store/store.ts` as fixes need; `src/store/README.md` (deliberate differences); `INVENTORY.md` (rows → `ported`)

**Interfaces:**
- Consumes: Task 1 (`paritySides`, `both`, `marker`, `shape`).

- [ ] **Step 1: Port the rows in Medplum's own order, one file at a time.** Each Medplum `repo.createResource` becomes `side.create`, and `repo.search(parseSearchRequest(...))` becomes `side.call('GET', '<Type>?<query>')`. Each Medplum `expect` runs on **both** sides inside `both()`, and the test asserts the two results' `shape` are equal where the scenario returns a comparable value. Medplum's in-memory `systemRepo` vs project `repo` distinction does not apply: everything runs as the project admin.
- [ ] **Step 2: Run the file.** `npx vitest run --project integration tests/integration/parity/<area>.test.ts`. Expected: the Medplum side passes every assertion (if it does not, the port is wrong: fix the port). The store side may fail.
- [ ] **Step 3: For each store failure,** first write a store unit test in `src/store/test/` (`search.test.ts`, `server.test.ts` or `store.test.ts`) that reproduces it without Medplum, then fix the store.
  - If the FHIR spec says Medplum is wrong, do not copy Medplum. Retitle the parity test `differs on purpose: <title> [<file>]`, assert each side's own behaviour, and add the README bullet.
  - Behaviours that are in the spec but whose features are later tasks of this plan stay `skipped` with `not yet ported (Task N)`.
- [ ] **Step 4: Run all checks.** `npm test` (unit) and `npx vitest run --project integration tests/integration/parity/`: PASS. `npx vitest run --project unit tests/parity-inventory.test.ts`: PASS. Run the store perf check (Global Constraints): within limits.
- [ ] **Step 5: Commit** per source file: `git commit -m "test(parity): port <file> (Medplum 5.2.14); fix(store): <what>"`.

### Task 4: `_summary` and includes (`:iterate`, canonical, depth, wildcard)

**Files:**
- Modify: `src/store/search.ts` (results section), `src/store/server.ts` (`_summary` on read, as Medplum)
- Test: `src/store/test/search.test.ts`; parity rows with feature `summary` and `include` → `ported`

**Interfaces:**
- Produces: `summarize(r: Resource, mode: 'true' | 'data' | 'text'): Resource` in `search.ts`.
  - `true`: the elements whose ElementDefinition has `isSummary` (from `tryGetDataType`), plus `id`, `meta` and mandatory elements.
  - `data`: everything but `text`.
  - `text`: `text`, `id`, `meta` and mandatory top-level elements.
  - Every mode adds the `SUBSETTED` tag, using the same tag code as `elements()`.

- [ ] **Step 1: Write the failing unit tests:**

```ts
test('_summary=true keeps summary elements only', () => {
  // a Patient with name, birthDate, photo and text → name and birthDate kept; photo and text dropped; meta.tag has SUBSETTED
});
test('_summary=data drops text only', () => { /* … */ });
test('_summary=text keeps text, id, meta and mandatory elements', () => { /* Observation keeps status and code */ });
test('_include:iterate follows includes of included resources up to Medplum\'s depth', () => {
  // A → B → C through two _include:iterate params; the depth limit comes from Medplum's search.ts in 5.2.14 (read it; pin the number in a const)
});
test('_revinclude:iterate', () => { /* Medplum _revinclude:iterate scenario, reduced */ });
test('_include on a canonical reference (Questionnaire from QuestionnaireResponse)', () => { /* … */ });
test('_include=* includes every reference of the match', () => { /* if Medplum supports it; else 400 stays and the row is a recorded difference or skipped */ });
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run --project unit src/store/test/search.test.ts -t "_summary|iterate|canonical|_include=\\*"`. Expected: FAIL (400 "Unsupported …").
- [ ] **Step 3: Implement.**
  - Canonical references: index canonical-typed reference values (`url|version` and bare `url`) so includes and chains resolve a canonical to the resource with that `url` (and `version`).
  - This changes index rows, so bump `INDEX_VERSION` (Task 7 has the old-file test).
  - Iterate: repeat include and revinclude over the newly added resources until there is nothing new or the depth is reached, with Medplum's depth and its behaviour on reaching it.
- [ ] **Step 4: Run the unit tests and the parity rows.** Expected: PASS. Update the README (remove these from "Next phase", list them under Search).
- [ ] **Step 5: Commit.** `git commit -m "feat(store): _summary true/data/text, _include/_revinclude :iterate, canonical includes"`

### Task 5: System-level search with `_type`

**Files:**
- Modify: `src/store/server.ts` (`GET /fhir/R4?_type=…` and `POST /fhir/R4/_search`), `src/store/search.ts`
- Test: `src/store/test/server.test.ts`; parity rows with feature `type` → `ported`

**Interfaces:**
- Produces: `searchJson(prep, type: string | string[], query, base)`. An array means a `_type` search across those types, with parameters common to all of them (others are 400, as Medplum answers). It sorts by `_lastUpdated` or another common sort key and pages by cursor across the merged result, with next links at the system URL `fhir/R4?…`.

- [ ] **Step 1: Write the failing unit tests:**

```ts
test('_type=Patient,Observation returns both types', async () => { /* … */ });
test('_type with a parameter one type lacks is 400', async () => { /* Medplum's text */ });
test('_type cursor pages have no repeats and no gaps across types', async () => { /* 45 resources, _count=10 */ });
test('system search without _type is 400', async () => { /* as Medplum */ });
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (404/400).
- [ ] **Step 3: Implement.** Use one SQL over the union of the types' candidate sets, so the cursor stays a single key tuple across types. The existing type-level `_type` error in `normalize` stays for type-level searches.
- [ ] **Step 4: Run** unit and parity. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): system-level search with _type, cursor-paged across types"`

### Task 6: Chains, reverse chains and `_compartment`

**Files:**
- Modify: `src/store/search.ts` (`chainCond`, `hasCond`, `cond`)
- Test: `src/store/test/search.test.ts`; parity rows with feature `chain` → `ported`

**Interfaces:**
- Produces: `chainCond` and `hasCond` handle any depth up to Medplum's maximum chain length; anything longer is 400 with Medplum's text (`Rejects too long chained search`).
  - `_has` nested inside `_has`, and `_has` inside a chain.
  - Chains through canonical references (Task 4's index).
  - Chain modifiers (`subject:Patient.name:exact=…`).
  - Medplum's `_compartment` search parameter (filter, `:missing`, chained `_compartment.name`, reverse `_compartment:_id`, `_compartment` as a middle link).

- [ ] **Step 1: Write the failing unit tests:**

```ts
test('two-level chain: Observation?subject:Patient.organization.name=…', () => { /* … */ });
test('nested _has: Patient?_has:Observation:subject:_has:Provenance:target:agent=…', () => { /* … */ });
test('chain longer than Medplum\'s maximum is 400', () => { /* the maximum read from Medplum 5.2.14, pinned as a const */ });
test('_compartment=Patient/<id> and _compartment.name', () => { /* … */ });
test('deep chain stays within the perf limit', () => {
  // 20k Observations, one Patient, one Organization: a two-level chain answers in under 1 s with driveMax at its default
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (400 "Unsupported chain deeper …").
- [ ] **Step 3: Implement** recursively: a chain's tail is `matching()` of the next link, so depth is recursion on the same code path. `_compartment` reads `meta.compartment` (it already is in the JSON; index it as reference rows under code `_compartment` if it is not indexed today, and bump `INDEX_VERSION` if so).
- [ ] **Step 4: Run** unit, parity and the perf check. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): chains and _has at any depth up to Medplum's limit; _compartment"`

### Task 7: Modifiers and composite parameters

**Files:**
- Modify: `src/store/search.ts` (`cond`, `rows`, `INDEX_VERSION` in `store.ts`)
- Test: `src/store/test/search.test.ts`, `src/store/test/store.test.ts`; parity rows with feature `modifier` and `composite` → `ported`

**Interfaces:**
- Produces:
  - Reference `:identifier` (`subject:identifier=sys|val` matches a `Reference.identifier`; index those as token rows under `<code>:identifier`).
  - Token `:of-type` (`identifier:of-type=typeSys|typeCode|value`).
  - Uri `:above` and `:below` (path prefix; token `:above`/`:below` stay 400 until plan 2).
  - `:missing` on logical (identifier-only) references.
  - Composite parameters: `<code>=<a>$<b>` for the composite SearchParameters of the stored types. Index one row per component pair under the composite's code, holding both component values; compare each component by its own type's rules.
  - `INDEX_VERSION` bumped once for this task's new rows.

- [ ] **Step 1: Write the failing unit tests:**

```ts
test('subject:identifier matches a Reference.identifier', () => { /* Reference identifier search [search.test.ts] reduced */ });
test('identifier:of-type', () => { /* … */ });
test('url:below and url:above', () => { /* … */ });
test('Observation?code-value-quantity=http://loinc.org|2093-3$gt200', () => { /* composite */ });
test('composite pairs components from the same repetition', () => {
  // component[0] code A value 1, component[1] code B value 2 → A$2 does not match
});
test('old index version is refused', () => { /* a file written with INDEX_VERSION-1 throws IndexFormatError */ });
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (400 "Unsupported …").
- [ ] **Step 3: Implement.** Composite components come from `SearchParameter.component` (`definition` → the component's parameter, `expression` relative to the composite's expression).
- [ ] **Step 4: Run** unit, parity and perf. Expected: PASS. Note: GA's install rebuilds its index on the version bump, as `IndexFormatError` documents; `ga migrate-store` (dry run) is the only GA path that writes a store file today, so nothing on the owner's machine needs a rebuild.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): :identifier, :of-type, uri :above/:below, composite search parameters"`

### Task 8: `_filter` completeness and meta parameters

**Files:**
- Modify: `src/store/search.ts` (`filterExpr`, `cond`)
- Test: `src/store/test/search.test.ts`; parity rows with feature `filter` and `meta` → `ported`

**Interfaces:**
- Produces: `_filter` operators `eq`, `ne`, `co`, `sw`, `ew`, `gt`, `lt`, `ge`, `le`, `sa`, `eb`, `ap`, `pr`, `re`, `in`/`ni` only where Medplum supports them (the `in` operators go to plan 2), chained paths and `_has` inside `_filter`, and UUID values. Meta parameters: `_source`, `_security`, `_tag`, `_profile` as Medplum indexes them.

- [ ] **Step 1: Write the failing unit tests**, one per Medplum `_filter …` and `Resource meta search params` row, reduced to the store.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Each `_filter` comparison maps to `cond()` with the matching operator; a chained path becomes `chainCond`.
- [ ] **Step 4: Run** unit, parity and perf. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): full _filter operators and chains; meta search parameters"`

### Task 9: Stage 1 search gate and docs

**Files:**
- Modify: `tests/parity-inventory.test.ts` (add the gate), `src/store/README.md`, `docs/superpowers/specs/2026-11-08-sqlite-store-design.md` ("Next phase"), `AGENTS.md` (store line, if its wording changes)

- [ ] **Step 1: Add the failing gate test:**

```ts
test('no row is left "not yet ported"', () => { /* every row is ported, skipped with a real reason, plan-2 or plan-3 */ });
```

- [ ] **Step 2: Run it.** Expected: PASS once every earlier task is done. If it fails, finish the rows it names: port them, or skip them with a real reason.
- [ ] **Step 3: Run everything:** `npm test`, `npm run test:int` (Medplum side included), and the store perf check. Record the counts in the commit message: ported, skipped, deferred to plan 2 and to plan 3, and deliberate differences.
- [ ] **Step 4: Docs.**
  - README: Search lists every feature added. "Next phase" keeps only terminology, GraphQL and what plan 4 owns. "Deliberate differences" has a bullet for every `differs on purpose` test.
  - Store spec: "Next phase" items done are moved to done.
- [ ] **Step 5: Commit.** `git commit -m "docs(store): parity plan 1 done: <n> ported, <n> skipped, <n> deferred, <n> deliberate differences"`
