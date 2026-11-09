# Full FHIR support for GA's SQLite store: Design

Follows the SQLite store project (`docs/superpowers/specs/2026-11-08-sqlite-store-design.md`, section "Next phase: full FHIR spec support"). Legend: **[user]** decided by the owner, **[call]** designer's call (open to override), **[recon]** found by reading Medplum's repository and the test platforms.

## Intent

GA keeps the owner's record in Medplum today. GA's own FHIR store on SQLite (`src/store`) replaces it only once the store is a full FHIR server **[user]**; `ga migrate-store --yes` is blocked until then (`SWITCH_READY` in `src/migrate-store.ts`). Replacing Medplum is the point, so the first yardstick is Medplum itself; official external test suites follow **[user]**.

"Done" is measured by tests, in three stages **[user]**:

1. **Medplum parity.** Medplum's own record-related tests (version 5.2.14, the one GA runs), ported into GA's side-by-side harness (`tests/integration/store-compat.test.ts` pattern): each scenario runs against Medplum (a throwaway test project, never the owner's record) and a temporary store, and the results must match. Zero differences, except the store's documented "stricter on purpose" cases (spec of the store project, "Differs from Medplum on purpose"), each pinned by a test.
2. **Touchstone** (AEGIS), the FHIR R4 server suites "Basic" and "Advanced", against a temporary store holding only synthetic data.
3. **Inferno US Core** (ONC test kit, run locally in Docker), later, when the Deploy GA project adds SMART sign-in in front of the store.

The switch (a fresh `ga migrate-store` dry run on the owner's record, the owner reads the report, then `--yes`) happens after stage 2; stage 3 does not block it **[user]**.

## Recon findings

- Medplum's server tests (`packages/server/src/fhir/*.test.ts`, e.g. `search.test.ts`: 176 tests, about 6,300 lines) call Medplum's repository code in process, not over HTTP. Each test has the shape "create records, run a search or operation, expect results", so it can be translated into HTTP requests run against both servers **[recon]**.
- Platform-only test files (access policy, projects and memberships, quotas, sharding, SMART, jobs, bots, rewrite of binary URLs, bulk export) do not apply to a record store **[recon]**.
- Search features Medplum's tests exercise that the store lacks or supports only partly **[recon]**: `_filter` (30 tests; the store has a small subset), `_has` incl. nested in chains (27), `:in`/`:not-in` (18; needs ValueSet expansion), `:identifier`, `:of-type`, `:above`/`:below`, `_include:iterate` (3), `_summary` (4), cross-type search `_type` (8), deeper chains. Medplum also has GraphQL (`packages/fhir-router/src/graphql`) and terminology operations (`$expand`, `$lookup`, `$validate-code`, `$subsumes` where present).
- Medplum's own CapabilityStatement (local `/fhir/R4/metadata`) advertises no type-level or system history and single-match conditional delete; the store already supports more there **[recon]**.
- Touchstone runs in AEGIS's cloud (free account): the server under test must be reachable from the internet. Inferno runs locally but tests implementation guides (US Core, IPA, SMART, Bulk Data), and its US Core server tests expect a token from a real SMART launch **[recon]**.

## Goals

- **Stage 1 passes:** every ported Medplum scenario gives the same observable result on both servers (status codes, returned resources and their order where Medplum sorts, totals, bundle links' meaning, OperationOutcome codes), except listed deliberate differences.
- **Stage 2 passes:** Touchstone FHIR R4 (4.0.1) Basic and Advanced server suites pass against the store, every failure fixed or recorded as not applicable with the reason (for example a feature Touchstone tests that no GA use and no Medplum behaviour requires, if any; the owner reviews that list).
- **Unsupported stays loud:** anything still not supported answers with an error, never a wrong answer (existing anti-goal).
- **Performance and memory hold:** the store stays within the existing 512 MB container budget (store + gateway + sync) and GA's heavy tools stay within the existing speed goals; new features may not slow existing searches.

## Non-goals

- Medplum's platform features: logins and admin, access policies, projects, bots, subscriptions, quotas, bulk export, SMART (SMART arrives with the Deploy project and stage 3).
- Loading full terminologies (SNOMED CT, LOINC, RxNorm) into the store: parity means behaving like Medplum on the CodeSystems and ValueSets stored in the server plus HL7's built-in base terminology (see Decisions) **[user]**.
- Switching the owner's install (separate step after stage 2) and removing Medplum (later project).
- FHIR versions other than R4.

## Anti-goals

- A wrong answer where Medplum would give the right one, or where the store previously answered with an error.
- Tests or test runs touching the owner's real record. Medplum runs use throwaway test projects; Touchstone runs use a temporary store with synthetic data only.
- Breaking the separable-store principle: `src/store` stays movable to its own repository (imports only `node:*`, `@medplum/core`, `@medplum/fhirtypes`, `@medplum/definitions`, `graphql` and each other; boundary test).
- PHI anywhere in the repo, tests, logs or reports.

## Decisions

- **Parity harness [call].** Ported scenarios live in GA's integration tests (they need the running Medplum) and drive both servers over HTTP through a `MedplumClient`, as `store-compat.test.ts` does today. Each ported test names its Medplum source (file and test name, version 5.2.14). Scenarios that depend on Medplum platform behaviour are listed as skipped with the reason. Store-only unit tests for each new feature live in `src/store/test` (separability).
- **Porting scope [call]:** `packages/server/src/fhir/search.test.ts`, `search-params.test.ts`, `batch.test.ts`, `repo.test.ts` (record parts), `binary.test.ts` (record parts), `metadata.test.ts`, `patient.test.ts` (`$everything`), `references.test.ts`, `tokens.test.ts`, `searchunique.test.ts`, the terminology operation tests, and `packages/fhir-router` (`fhirrouter`, `batch`, `search-include`, `graphql`). The builder confirms the list from the 5.2.14 tree and records it.
- **GraphQL in scope [user].** Implemented to match Medplum's GraphQL behaviour on the ported scenarios; reuse `@medplum/core`/`@medplum/fhir-router` logic only through the allowed dependencies (copying Apache-2.0 code into `src/store` is allowed with attribution, like `vendor/medplum-ccda`; adding `@medplum/fhir-router` as a dependency is a builder decision only if the boundary rule is extended, recorded).
- **Terminology in scope [user]:** `$expand`, `$lookup`, `$validate-code` (and `:in`/`:not-in`, `:above`/`:below` that depend on them) over CodeSystem/ValueSet resources stored in the store.
- **Built-in HL7 terminology [user]:** like Medplum's built-in R4 project, the store ships HL7's base ValueSets and CodeSystems from `@medplum/definitions` (`valuesets.json`, `v3-codesystems.json`, about 16 MB, 1,169 resources) as read-only terminology that every terminology operation and `:in`/`:not-in`/`:above`/`:below` search sees, alongside stored ones (when a stored resource has the same URL, the builder checks which one Medplum's `findTerminologyResource` picks and does the same). Loaded on demand, not held whole in memory; the builder measures memory against the 512 MB budget and records it.
- **Touchstone exposure [call]:** a temporary store with synthetic data only, reachable from the internet only for the length of a test run, through a method the owner approves at the time (it is an outward-facing action). Never the owner's store, never Funnel on the gateway.
- **When sources disagree [call]:** the FHIR R4 specification wins over Medplum and over Touchstone. Where Medplum answers against the spec, the store follows the spec, and the builder adds the case to "Differs from Medplum on purpose" with a test that pins it; the owner reviews the full list at the end of stage 1. Parity never means copying a Medplum bug.
- **Configuration the gates certify [call]:** the store with all 147 R4 types (its default). GA's own `GA_STORE_TYPES` grows only by what GA uses (for example CodeSystem and ValueSet for terminology), recorded with the AccessPolicy and migration change it needs.
- **Medplum for the parity harness [user]:** an admin client on the owner's local Medplum, working only in throwaway `ga-test*` projects (no separate Medplum instance). Anti-goal stands: no test reads or writes GA's `Guardian Angel` project; each test creates and deletes its own project, and the harness refuses to run if the target project is not a `ga-test*` one.
- **GraphQL dependency [user]:** the `graphql` npm package joins the store's allowed imports (boundary test and `src/store/README.md` updated); `@medplum/fhir-router` is still not a dependency (its GraphQL code may be copied with attribution).
- **Order of work [call]:** search features first (largest test count), then `_summary`/cross-type search/includes, then terminology, then GraphQL, then Touchstone fixes.
- **Switch gate [call]:** `SWITCH_READY` turns true only after stages 1 and 2 pass, in a commit that cites the two results.

## Constraints

- Node 26 strip-only TypeScript, vitest, `node:sqlite`; no new npm dependency beyond `graphql` unless unavoidable (recorded with its reason).
- Medplum stays the default store; GA's behaviour on Medplum does not change.
- Medplum test runs need the local Medplum (throwaway `ga-test*` projects, as existing integration tests).
- Docs: `src/store/README.md` (HTTP surface, supported features, deliberate differences), the store spec's "Next phase" list (moved to "done" as features land), `AGENTS.md` store line.

## Left to the builder

The SQL/index design for each feature; how ported scenarios are expressed (data tables vs code); how Medplum's in-process calls map to HTTP; the exact skip list and its reasons; how the Touchstone run is wired (within the approval rule above); whether GraphQL is ported or written fresh.
