# Store parity, plan 3 of 4: GraphQL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA's SQLite store answers `POST [base]/$graphql` the way Medplum 5.2.14 does. It passes the GraphQL tests deferred by plan 1: 76 inventory rows marked `plan-3`, 45 from `fhir-router/src/graphql/graphql.test.ts` and 31 from `server/src/fhir/operations/graphql.test.ts`.

**Architecture:**
- **A port, not a rewrite:** Medplum's `packages/fhir-router/src/graphql` (about 1,500 lines: `graphql.ts`, `utils.ts`, `output-types.ts`, `input-types.ts`) is copied into the store with attribution and adapted.
- **Synchronous:** every resolver runs synchronously against SQLite through `executeSync`, so the store's synchronous `dispatch` stays as it is.
- **One path for every request:** every read, search and write a resolver makes goes back through `dispatch`, so GraphQL gets the same validation, reference rules and error texts as REST.
- **Lazy schema:** the schema is built on the first `$graphql` request and covers only the store's resource types.

**Tech Stack:** Node 26 (strip-only TypeScript), `node:sqlite`, `@medplum/core` 5.2.14, `graphql` 17.0.2 (new), vitest 5.1.0.

**Spec:** `docs/superpowers/specs/2026-11-09-full-fhir-store-design.md` (plan 1: `docs/superpowers/plans/2026-11-09-store-parity-search.md`; plan 2: `docs/superpowers/plans/2026-11-11-store-parity-terminology.md`)

**The other plan:** plan 4 covers Touchstone and the `SWITCH_READY` commit.

## Global Constraints

Every constraint of plans 1 and 2 still applies:
- `src/store` imports only `node:*`, `@medplum/core`, `@medplum/fhirtypes`, `@medplum/definitions`, `graphql` (new, this plan) and its own files, and mentions nothing about GA. The boundary test stays green.
- Anything unsupported answers loudly: 400 with an OperationOutcome naming it.
- The FHIR R4 specification wins over Medplum. A deliberate difference gets a README bullet plus a `differs on purpose: …` parity test.
- Tests never touch the owner's record, and the Medplum side writes only in `ga-test-parity`.
- No PHI, no hospital or personal names. Test data is synthetic.
- No existing search gets slower (`src/store/test/perf.test.ts`).
- Parity test titles take the form `<Medplum title> [<file>]`.
- Medplum 5.2.14 is read from the local clone at `<scratchpad>/medplum-5.2.14`, outside the repo.
- No new npm dependency beyond `graphql` (spec). Medplum's `dataloader` is not added.
- Commits are conventional, with no attribution lines and no push.

This plan adds these rulings (the controller's, recorded 2026-11-11; the owner can override them):

- **R1, port with attribution.** Medplum's four GraphQL files become two store files:
  - `src/store/graphql.ts`: the handler, the root schema, the depth and cost rules, and the resolvers;
  - `src/store/graphql-types.ts`: the output and input types and `utils.ts`.
  Each keeps Medplum's two SPDX lines and names its source files in a comment, as `vendor/medplum-ccda/*.ts` does. Keep Medplum's names (`getRootSchema`, `parseSearchArgs`, `buildGraphQLOutputType`, …) so the files can be compared side by side with the original.
- **R2, synchronous, no DataLoader.** Resolvers return values, not promises, and the handler calls `executeSync`. A per-request `Map<string, Resource | null>` keyed by `Type/id` replaces DataLoader, so the same reference is read once per query. Medplum's reader and writer database modes (`repo.setMode`) are dropped, since the store has one database. `executeSync` throws if any resolver returns a promise, including a union's `resolveType` and Medplum's `resolveField`. So every ported resolver loses its `async`, and a missed one shows up as a 500, not as a failing test that names it.
- **R3, one path for every request.** `graphql.ts` never touches the `Store` directly. `server.ts` passes it a callback:
  ```ts
  type Fhir = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => unknown; // path relative to base; returns the parsed JSON body
  ```
  The callback runs `dispatch` with a synthetic `Req`, so creates are validated, `Patient?identifier=…` references resolve, and patch, ifMatch and 404/410 behave as in REST. Any status ≥ 400 becomes the resolver's error, with the OperationOutcome text as its message, as Medplum's resolvers rethrow `OperationOutcomeError`. That covers a thrown `HttpError` or `StoreError` and an `Answer` returned with a status ≥ 400. Otherwise a 404 read could come back as `undefined` and pass for a valid `null`. A search turns Medplum's `SearchRequest` into a path with `@medplum/core`'s `formatSearchQuery`. The store's paging already uses `_cursor`, which Medplum's `getNextCursor` reads.
- **R4, introspection is an option.** `ServeOptions.graphqlIntrospection?: boolean` defaults to false, the same default as Medplum's `FhirRouter`. A disabled store answers an introspection query (Medplum's regex `/query IntrospectionQuery|__schema|__type(?!name)/`) with 403, while `__typename` stays allowed. The parity side starts its store with `true`, because the owner's Medplum runs with `MEDPLUM_INTROSPECTION_ENABLED: 'true'` (compose.yaml). GA's `src/store-serve.ts` leaves it off. Medplum's LRU cache of introspection results is not ported. Mark that in the code: `shortcut: no introspection result cache; add one if introspection traffic matters`.
- **R5, the schema covers the store's types.** Where Medplum iterates `getResourceTypes()`, the store iterates the store's type list, passed in as `getRootSchema(types)`. `storedTypes()` in `src/store/definitions.ts` is one variable for the whole process, so a test file that opens a Patient-only store and an all-types store in the same worker would otherwise share one schema. That covers the root fields, the reverse-lookup fields and the `resource` union of a Reference. On an all-types store the schema matches Medplum's. On GA's store, a field for a type it doesn't store is a GraphQL validation error (400), not a 500. Each schema is built on the first `$graphql` request for its type list and kept in a `Map` keyed by the sorted, comma-joined list.
- **R6, limits are Medplum's defaults and are not configurable.**
  - Max depth is 12 (`DEFAULT_MAX_DEPTH`) and max cost is 10,000 (`DEFAULT_MAX_COST`).
  - A list field's `_count` is capped at 1000 (`DEFAULT_MAX_SEARCH_COUNT`), and there is no cap on the number of searches per query.
  - Medplum's per-project settings (`graphqlMaxDepth`, `graphqlMaxSearches`, `graphqlBatchedSearchSize`) have no store equivalent. The rows that test them are `skipped` ("project setting").
  - Medplum's `router.log('warn', …)` calls are dropped.
- **R7, memory.** Two measurements, each in a child process that runs `{ PatientList(_count: 1) { id } }` once:
  - `src/store/test/graphql-memory.test.ts` opens a store with every type and `terminology: []`. RSS may grow by at most 128 MiB from before the query to after it, the same cap as plan 2's seed (R11 there).
  - `tests/store-graphql-memory.test.ts` (GA-side, because it imports `GA_STORE_TYPES`) opens a store with GA's types. Total RSS after the query must stay ≤ 220 MiB, ga-store's budget. `$graphql` is reachable on GA's store even with introspection off, and any request builds the schema there. Write the measured number into `docs/superpowers/spikes/2026-11-11-store-graphql-memory.md`. If the measurement is over the cap, stop and report it to the controller. Do not loosen the test.
- **R8, the dependency.** Add `graphql` at exactly `17.0.2`, Medplum 5.2.14's version, so the parser and validation error texts match. It goes under `dependencies` in `package.json` with `--save-exact`. Add it to `PACKAGES` and the resolver map in `src/store/test/boundary.test.ts`, and to the allowed-imports line and the example package manifest in `src/store/README.md`.
- **R9, the route.** `POST [base]/$graphql` is the only route, as Medplum routes it. It also works as a batch or transaction entry, since it goes through `dispatch`. Any other method on `$graphql` keeps today's answer for an unknown system operation (404). A parity test in Task 2 pins what Medplum answers to `GET $graphql`. If that differs, follow Medplum. The CapabilityStatement stays unchanged, because Medplum's `metadata.ts` doesn't list GraphQL.
- **R10, no index change.** `INDEX_VERSION` stays 5. GraphQL adds no tables.

## Review Focus

1. **A query that fans out**, such as a reverse lookup nested in a 1000-entry list. Because resolvers block the event loop, the cost rule must refuse it with 400 before any search runs. Test: Task 3 `a query over the cost limit is 400 and runs no search`.
2. **A mutation with an invalid resource** (a missing required field, a wrong `resourceType`, an `id` that doesn't match). It must give REST's 400 text and write nothing. Test: Task 4 `invalid create writes nothing and gives the REST error text`.
3. **A reference GraphQL cannot follow**: contained (`#x`), absolute (`http://…`), or pointing at a missing record. `resource` must be `null`, with no crash and no error that hides the rest of the result. Test: Task 3 `resource of a contained, absolute or missing reference is null`.
4. **Introspection on a disabled store, hidden behind an alias or a fragment** (`{ s: __schema { types { name } } }`). The answer must still be 403. Test: Task 2 `introspection through an alias or fragment is 403 when disabled`.
5. **GA's store, which holds only some types.** Asking for a type it doesn't store (`ConditionList` when Condition isn't stored) must give a 400 that names the field, not a 500. Test: Task 2 `a field for an unstored type is a 400 validation error`.

## File Structure

- Create:
  - `src/store/graphql.ts`: `graphqlHandler`, `getRootSchema`, the depth and cost rules, the resolvers;
  - `src/store/graphql-types.ts`: output types, input types, search-argument helpers.
- Modify:
  - `src/store/server.ts`: the `$graphql` route, the `Fhir` callback, `ServeOptions.graphqlIntrospection`;
  - `package.json` and `package-lock.json`: `graphql` 17.0.2;
  - `src/store/test/boundary.test.ts`: allow `graphql`;
  - `tests/temp-store.ts`: pass `graphqlIntrospection` through.
- Tests:
  - `src/store/test/graphql.test.ts`: store-only behaviour (introspection off, unstored types, cost, references, invalid mutations);
  - `src/store/test/graphql-memory.test.ts`, `tests/store-graphql-memory.test.ts`;
  - `tests/integration/parity/graphql.test.ts`: the ported rows;
  - `tests/integration/parity/harness.ts`: sweep types if a row creates a new type;
  - `tests/parity-inventory.test.ts`.
- Docs:
  - `src/store/README.md`;
  - `docs/superpowers/specs/2026-11-08-sqlite-store-design.md` ("Next phase");
  - `docs/superpowers/spikes/2026-11-11-store-graphql-memory.md`;
  - `tests/integration/parity/INVENTORY.md`.

---

### Task 1: Triage the 76 deferred rows

No product code. This settles the real porting scope before anything is built.

**Files:**
- Modify: `tests/integration/parity/INVENTORY.md`, `tests/parity-inventory.test.ts`

**Interfaces:**
- Produces: every `plan-3` row becomes either `skipped` with a reason, or `skipped` with the note `not yet ported (Task N)`, N = 2, 3 or 4 by the list below. The status `plan-3` is then no longer allowed (update the legend on INVENTORY.md line 5).

- [ ] **Step 1: Write the failing check** in `tests/parity-inventory.test.ts`:

```ts
test('no row is deferred to plan 3', () => { /* no row has status plan-3 */ });
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run --project unit tests/parity-inventory.test.ts`. Expected: FAIL, naming 76 rows.
- [ ] **Step 3: Triage each row** against its Medplum test body. Mark these `skipped`, each with its reason:
  - `test.skip` in Medplum itself: IntrospectionQuery, Get __schema, both Max depth rows and Max depth override. Reason: "skipped in Medplum 5.2.14".
  - Access policy: Hidden fields in nested lookups, Cannot read resource type (and its nested-lookups row), Access policy criteria (and its nested-lookups row), Create Task with groupIdentifier, searchByReference › Respect access policy. Reason: "access policy".
  - Project settings and the database platform: Max searches exceeded, searchByReference › disabled without project setting, searchByReference › Respect project boundary, Uses reader instance when available, GraphQL in batch users writer, dataloader deduplicates reads. Reason: "project setting" or "database platform (spy on pools or loaders)".
  - Introspection forbidden: Medplum's side runs with introspection on, so the store-only test `introspection is 403 when disabled` in Task 2 covers it. Reason: "Medplum runs with introspection on; store-only test".
  Every other row gets `not yet ported (Task N)`:
  - Task 2: Missing query, Syntax error, Introspection allowed, Allows value introspection, Get __type, Read by ID (and not found), the Search rows, both Sort rows, StructureDefinition query.
  - Task 3: the reference and reverse-lookup rows, the list field argument rows, the Connection API rows, Fragment inclusion, both Cursor pagination rows, Reference missing reference property.
  - Task 4: the Create, Update, Delete and Patch rows.
  Put the counts per status and per task (2, 3, 4) in the task report. The gate catches a leftover `plan-3` row but not a row put in the wrong task, so check the per-task lists against Medplum's test bodies.
- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "test(parity): triage the GraphQL rows deferred by plan 1"`

### Task 2: The dependency, the route, the schema, reads and searches

**Files:**
- Create: `src/store/graphql.ts`, `src/store/graphql-types.ts`, `src/store/test/graphql.test.ts`, `src/store/test/graphql-memory.test.ts`, `tests/store-graphql-memory.test.ts`, `tests/integration/parity/graphql.test.ts`, `docs/superpowers/spikes/2026-11-11-store-graphql-memory.md`
- Modify: `package.json`, `package-lock.json`, `src/store/server.ts`, `src/store/test/boundary.test.ts`, `tests/temp-store.ts`, `tests/integration/parity/harness.ts` (start the store side with `graphqlIntrospection: true`)

**Interfaces:**
- Produces:
  ```ts
  // graphql.ts
  export type Fhir = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => unknown;
  export function graphqlHandler(body: unknown, fhir: Fhir, opts: { introspection: boolean; types: readonly string[] }): { status: number; json: string };
  export function getRootSchema(types: readonly string[]): GraphQLSchema; // lazy, cached per sorted type list
  // server.ts
  export type ServeOptions = { …; graphqlIntrospection?: boolean };
  ```
  `graphqlHandler` returns 200 with the GraphQL result (`data` and/or `errors`) as JSON. A request error (missing query 400 `Must provide query.`, syntax 400 `GraphQL syntax error.`, validation 400 via Medplum's `invalidRequest`, introspection 403) returns the status with its OperationOutcome, as Medplum's handler does.

- [ ] **Step 1: Add the dependency and the boundary rule (R8).** Run `npm install --save-exact graphql@17.0.2`, then update `boundary.test.ts` and the README import line. Run `npx vitest run src/store/test/boundary.test.ts`. Expected: PASS.
- [ ] **Step 2: Write the failing store-only tests** in `src/store/test/graphql.test.ts`, each against a `serveStore` on a temp file:

```ts
it('introspection is 403 when disabled; __typename is allowed', …);             // { __schema { types { name } } } → 403; { __typename } → 200
it('introspection through an alias or fragment is 403 when disabled', …);       // { s: __schema { types { name } } } → 403
it('a field for an unstored type is a 400 validation error', …);                // store types ['Patient']: { ConditionList { id } } → 400, outcome text names ConditionList
it('$graphql works as a batch entry', …);                                       // batch with one POST $graphql entry → entry response 200 with data
```

- [ ] **Step 3: Write the failing parity tests** for every Task 2 row in `tests/integration/parity/graphql.test.ts`, plus `GET $graphql is answered as Medplum answers it [store-only probe]` (R9). Port each Medplum body as an HTTP call through `same()` on `POST $graphql`. Medplum's `fhir-router` tests run on an empty `MemoryRepository`, but the parity side runs in the shared `ga-test-parity` project. So scope every search to the test's own records with a `marker()`, as the earlier parity files do: Search, both Sort rows, Cursor pagination and the Connection API counts drift otherwise.
- [ ] **Step 4: Run to verify they fail.** Run `npx vitest run src/store/test/graphql.test.ts`, then `npx vitest run --project integration tests/integration/parity/graphql.test.ts`. Expected: FAIL; the store answers 404 on `$graphql`.
- [ ] **Step 5: Port the handler, the root query fields and the output types** (R1–R5): read by id (`Patient(id:)`), search (`PatientList(...)` with `parseSearchArgs`, `_count`, `_sort`, `_filter`), and `StructureDefinition`. Mutations, reverse lookups and the Connection API come in Tasks 3–4. Leave them out of the schema until then, so Task 2's schema is valid on its own. Route `POST $graphql` in `dispatch` before the "no system-level operations" 404.
- [ ] **Step 6: Run to verify they pass.** Both commands from Step 4, then `npx vitest run src/store/test/`. Expected: PASS.
- [ ] **Step 7: Measure memory (R7).** Write both memory tests and run each 3 times. Record the medians in the spike doc. The caps are 128 MiB of growth (all types) and 220 MiB total (GA's types). If either is over, stop and report it.
- [ ] **Step 8: Commit.** `git commit -m "feat(store): POST \$graphql with reads, searches and introspection, ported from Medplum"`

### Task 3: References, reverse lookups, list arguments, the Connection API and limits

**Files:**
- Modify: `src/store/graphql.ts`, `src/store/graphql-types.ts`, `src/store/test/graphql.test.ts`, `tests/integration/parity/graphql.test.ts`

**Interfaces:**
- Consumes: Task 2's `Fhir`, `graphqlHandler` and `getRootSchema`.
- Produces: Reference `resource` (through the per-request cache, R2); `<Type>List(_reference: …)` reverse lookups; list-field arguments (`_offset`, `_count`, `fhirpath`, by property name, by extension url); `<Type>Connection` with `count`, `edges`, `next`/cursor; the `MaxDepthRule` (12) and `QueryCostRule` (10,000).

- [ ] **Step 1: Write the failing store-only tests:**

```ts
it('resource of a contained, absolute or missing reference is null', …);  // subject #x, http://other/Patient/1, Patient/<unknown>: data.…resource === null, no errors entry for the others
it('a query over the cost limit is 400 and runs no search', …);           // a nested reverse lookup under PatientList(_count: 1000) → 400; a spy on the Fhir callback records 0 GET calls
it('the same reference is read once per query', …);                        // two Observations with the same subject: the Fhir callback gets one GET Patient/<id>
```

- [ ] **Step 2: Write the failing parity tests** for every Task 3 row.
- [ ] **Step 3: Run to verify they fail.** The same two commands as Task 2 Step 4. Expected: FAIL.
- [ ] **Step 4: Port the fields and the rules.** "Reverse lookup on contained resource with invalid id" and "Reference missing reference property" pin Medplum's exact `errors` entries. Copy those texts.
- [ ] **Step 5: Run to verify they pass.** Same commands, then `npx vitest run src/store/test/` and `npx vitest run src/store/test/perf.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(store): GraphQL references, reverse lookups, list arguments, Connection API, depth and cost limits"`

### Task 4: Mutations

**Files:**
- Modify: `src/store/graphql.ts`, `src/store/graphql-types.ts`, `src/store/test/graphql.test.ts`, `tests/integration/parity/graphql.test.ts`

**Interfaces:**
- Consumes: Task 2's `Fhir`.
- Produces: `<Type>Create(res:)`, `<Type>Update(id:, res:)`, `<Type>Delete(id:)`, `<Type>Patch(id:, patch:)`. Each calls `fhir('POST' | 'PUT' | 'DELETE' | 'PATCH', …)`. Medplum's own checks that `res.resourceType` matches the field and that `id` matches `res.id` are kept, with Medplum's texts.

- [ ] **Step 1: Write the failing store-only test:**

```ts
it('invalid create writes nothing and gives the REST error text', …);
// PatientCreate(res: { resourceType: "Patient", gender: "x" }): errors[0].message === the 400 text REST gives for the same body; Patient?_summary=count total unchanged
```

- [ ] **Step 2: Write the failing parity tests** for every Task 4 row.
- [ ] **Step 3: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 4: Port the input types and the mutation resolvers** (Medplum's `input-types.ts`, `buildCreateArgs`, `buildUpdateArgs`, `buildPatchArgs`, `resolveByCreate`, `resolveByUpdate`, `resolveByDelete`, `resolveByPatch`). Add the mutation root to `getRootSchema`.
- [ ] **Step 5: Run to verify they pass.** Same commands, then `npx vitest run src/store/test/`. Run both memory tests again. The mutation types add to the schema, and both caps must still hold.
- [ ] **Step 6: Commit.** `git commit -m "feat(store): GraphQL create, update, delete and patch mutations"`

### Task 5: Gate and docs

**Files:**
- Modify: `tests/parity-inventory.test.ts` (gate), `src/store/README.md`, `docs/superpowers/specs/2026-11-08-sqlite-store-design.md` ("Next phase"), `docs/superpowers/spikes/2026-11-11-store-graphql-memory.md`, `AGENTS.md` (the store line, only if its wording changes)

- [ ] **Step 1: Confirm the gate.** The existing `no row is left "not yet ported"` and Task 1's `no row is deferred to plan 3` both PASS.
- [ ] **Step 2: Run everything.** `npm test`, `npm run test:int`, and the perf and memory tests. Record these counts in the commit message: rows ported, rows skipped (reasons grouped), and new deliberate differences.
- [ ] **Step 3: Docs.**
  - README:
    - the HTTP surface (`POST $graphql`, the option `graphqlIntrospection`, the limits from R6);
    - the allowed imports (`graphql`);
    - "Deliberate differences" for every new `differs on purpose` test and for R5 (the schema covers the store's types);
    - not ported: project settings, access policies, the introspection cache.
  - Store spec, "Next phase": move the GraphQL line to the done paragraph.
- [ ] **Step 4: Commit.** `git commit -m "docs(store): parity plan 3 done: <n> ported, <n> skipped, <n> deliberate differences; GraphQL schema memory <n> MiB"`
