# GA's Own FHIR Store on SQLite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Medplum with GA's own FHIR store in one SQLite file, so GA runs as one small process (512 MB) with the same tool answers and broad `fhir_search`, switchable from Medplum during the move.

**Architecture:** `src/store/` holds a self-contained FHIR store (resources as JSON in `node:sqlite`, indexed by evaluating the official search parameters with `@medplum/core` FHIRPath). One owner process serves it over local HTTP in Medplum's REST shape with a bearer token; every GA process keeps using a `MedplumClient` pointed at it. `ga migrate-store` copies the owner's record from Medplum and verifies it by replaying GA's read tools on both.

**Tech Stack:** Node 26 strip-only TypeScript, `node:sqlite`, `@medplum/core` (+ trimmed `@medplum/definitions`), vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-sqlite-store-design.md`. Spike write-up (its throwaway prototype branch is deleted; the store is `src/store/`): `docs/superpowers/spikes/2026-11-07-sqlite-fhir-store.md`.

## Global Constraints

- GA as a whole runs in **512 MB** of memory; if memory and speed conflict, memory wins; speed fallback goal: heavy tools within **1.5×** of Medplum (Medplum medians: `health_summary` 165 ms, `vitals` 72 ms, `whats_new` 2.0 s).
- `src/store/` imports nothing from the rest of GA (only `@medplum/core`, `@medplum/definitions` subset, Node built-ins).
- No native npm SQLite dependency unless the speed goal cannot be met with `node:sqlite` (then `better-sqlite3`, with the reason recorded).
- Unsupported search features return HTTP 400 with an OperationOutcome naming the feature; never a silently wrong answer. Not supported: composite and special parameters, `:above`/`:below`/`:in`, chains deeper than one level, `_summary=true`.
- The store's HTTP listens on localhost/internal Docker network only and requires `Authorization: Bearer <token>` from `.ga/store/token` (0600), compared in constant time.
- No PHI in the repo, tests, fixtures or logs; tests use temp files and synthetic data, never the owner's real record.
- Medplum path keeps working as today while the switch exists (`GA_STORE=medplum|sqlite`, default `medplum` until Task 8 flips it).
- The C-CDA converter is outside the 512 MB target and runs only for C-CDA imports.

## Review Focus

1. Concurrent writers (ga-sync importing while the gateway serves a chat app and the CLI writes): no lost update, no `database is locked` error surfacing to a tool — Task 5 test.
2. A share link must never include a record outside the patient compartment after migration (compartment mismatch blocks cutover) — Task 7 test.
3. A client using a stale token or no token gets 401 and nothing else; the store port is not reachable via the public gateway — Task 5 test.
4. `ga import` of a large Apple Health export into the store stays within the memory goal and completes (streaming, batched transactions) — Task 9 measurement.
5. Store not running: every CLI command fails with "GA is not running: start it with docker compose up -d" instead of a stack trace — Task 6 test.

---

### Task 1: Memory and driver spike → decision

Measure before building. Deliverable: `docs/superpowers/spikes/2026-11-08-store-memory.md` (counts and timings only) and the two decisions below recorded in it.

**Files:**
- Create: `src/store/definitions.ts`
- Create: `docs/superpowers/spikes/2026-11-08-store-memory.md`
- Test: `tests/store/definitions.test.ts`

**Interfaces:**
- Produces: `loadDefinitions(): void` — loads only the StructureDefinitions and SearchParameters for the resource types GA stores (list in the file, derived from `src/engine.ts` COMPARTMENT plus Patient, Medication, Endpoint, Basic, ConceptMap, Provenance, AuditEvent, DocumentReference, Binary, Practitioner, PractitionerRole, Organization, Location, Device, Communication, QuestionnaireResponse, FamilyMemberHistory, Composition); `STORED_TYPES: readonly string[]`.

- [ ] **Step 1:** Add `@medplum/definitions` at the version matching `@medplum/core` as a dependency.
- [ ] **Step 2: Failing test** `tests/store/definitions.test.ts`: after `loadDefinitions()`, `getSearchParameters('Observation')` includes `code`, `date`, `category`, `subject`, `_tag`; `validateResource` accepts a minimal valid Observation and rejects one without `status` with an issue whose expression is `Observation.status`; a type outside `STORED_TYPES` has no search parameters.
- [ ] **Step 3:** Implement `loadDefinitions` reading only the needed entries from the definitions bundles (filter by `STORED_TYPES` and the datatypes they reference).
- [ ] **Step 4:** Measure with a script in a temp dir (not committed): RSS after `loadDefinitions()` (full vs trimmed), and the spike store on a synthetic 30k-resource dataset (generate synthetic Observations/Conditions/MedicationRequests shaped like GA's) with (a) `node:sqlite` on the main thread, (b) `node:sqlite` in a `worker_thread` serving requests by message, (c) `better-sqlite3` if (a)/(b) miss the speed goal. Record RSS and the heavy-tool latencies against a fake GA workload (the spike's `bench.ts` queries).
- [ ] **Step 5:** Record in the write-up: chosen driver/threading, trimmed-definitions RSS, projected GA total RSS, and whether 512 MB is met; if not met, the gap and the plan. Commit `feat: trimmed FHIR definitions for the store; memory spike write-up`.

### Task 2: Store core — resources, versions, history, validation, compartment

**Files:**
- Create: `src/store/store.ts` (port from the spike, minus search)
- Test: `tests/store/store.test.ts`

**Interfaces:**
- Consumes: `loadDefinitions`, `STORED_TYPES` (Task 1).
- Produces: `class Store { constructor(file: string, opts?: { cacheMb?: number }); read(type, id): Resource | undefined; create(r: Resource, ifNoneExist?: string): { resource: Resource; created: boolean }; update(r: Resource, ifMatch?: string): Resource; delete(type, id): void; history(type, id, count?, offset?): Resource[]; transaction<T>(fn: () => T): T; close(): void }`. Errors: `StoreError { status: 400 | 404 | 409 | 412; issues: { expression?: string[]; text: string }[] }`.

- [ ] **Step 1: Failing tests:** create assigns a UUID id, `meta.versionId`, `meta.lastUpdated`; update with a stale `If-Match: W/"<old>"` throws status 412; update with the current version succeeds and history returns both versions newest first; `If-None-Exist: identifier=sys|val` returns the existing resource with `created: false`; an invalid resource throws status 400 with `issues[].expression` like `['Observation.status']` (the shape `src/engine.ts isValidationFailure` reads); a Condition with `subject: Patient/p1` gets `meta.compartment` `[{reference:'Patient/p1'}]` per the Patient CompartmentDefinition; delete then read returns undefined; WAL mode is on.
- [ ] **Step 2:** Run `npx vitest run tests/store/store.test.ts` — FAIL.
- [ ] **Step 3:** Implement (port the spike's tables: resources, history, index; add compartment computation from the CompartmentDefinition in the definitions).
- [ ] **Step 4:** Run — PASS. Commit `feat: store core (versions, history, conditional create, validation, compartment)`.

### Task 3: Search

**Files:**
- Create: `src/store/search.ts` (port from the spike's `search`/`cond`/`sortKeys`)
- Modify: `src/store/store.ts` (index rows on write; sort-key columns)
- Test: `tests/store/search.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2).
- Produces: `Store.search(type: string, query: [string, string][], base: string): Bundle` — Bundle `searchset` with `entry[].resource`, `total` when `_total=accurate` or `_summary=count`, and `link` `self`/`next` (cursor-based: `_cursor=<opaque>`).

- [ ] **Step 1: Failing tests** (synthetic resources), one `it` per feature, each asserting the exact id list in order: token `system|code`, `system|`, `|code`, OR list; `_tag`, `_tag:not`; `code:text` (substring, case-insensitive, on text and coding display); string default (starts-with) and `:contains`/`:exact`; date `eq/ge/gt/le/lt` with partial precision (`2024`, `2024-05`) and Period with no end treated as ending at its start; `_lastUpdated` ranges; reference `subject=Patient/x`; `:missing=true/false`; `:not`; `_id` list; `_filter` `category eq X or _tag eq Y`; `_include MedicationStatement:medication`; `_revinclude Provenance:target`; one-level chain `subject.name=Doe`; `_has:Observation:patient:code=X`; quantity with prefixes; `_sort=-date,_id` with undated records first on `-date`; `_count` + following `next` until exhausted returns every id exactly once; `_elements=id,code` keeps required fields and adds the SUBSETTED tag; `_summary=count`; `_compartment=Patient/x`; unsupported (`code:in=...`, `subject.organization.name=x`, a composite param) → status 400 naming the feature.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS. Commit `feat: store search (types, modifiers, prefixes, include, chain, has, sort, cursor paging)`.

### Task 4: Binary and attachment URLs

**Files:**
- Modify: `src/store/store.ts`
- Test: `tests/store/binary.test.ts`

**Interfaces:**
- Produces: `Store.putBinary(contentType: string, data: Uint8Array): { id: string }`, `Store.getBinary(id): { contentType: string; data: Uint8Array } | undefined`; files under `<db dir>/binary/<id>` (not BLOBs, so the DB stays small and backups can stream files).

- [ ] **Step 1: Failing tests:** put then get returns identical bytes and content type; a 20 MB payload round-trips without loading twice in memory (stream to file); unknown id → undefined.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: store binaries as files`.

### Task 5: Store server (owner process) and client wiring

**Files:**
- Create: `src/store/server.ts` (HTTP in Medplum's REST shape: `/fhir/R4/<Type>[/<id>[/_history[/<vid>]]]`, `_search`, Binary, batch DELETE as GA's migrate uses; port the spike's `fetch.ts` routing)
- Create: `src/store/serve.ts` CLI entry: `ga store serve` (opens the DB, worker thread per Task 1 decision)
- Modify: `src/config.ts` (`getClient`: with `GA_STORE=sqlite`, a `MedplumClient` with `baseUrl` = store URL and a fetch that adds the bearer token; no `startClientLogin`), `src/cli.ts` (dispatch `store serve`)
- Test: `tests/store/server.test.ts`

**Interfaces:**
- Consumes: `Store` (Tasks 2–4).
- Produces: `serveStore(opts: { file: string; host: string; port: number; tokenFile: string }): Promise<http.Server>`; config `GaConfig.storeUrl?: string` (default `http://127.0.0.1:8120/`), env `GA_STORE`, `GA_STORE_URL`; token at `.ga/store/token` created on first serve (32 random bytes base64url, 0600).

- [ ] **Step 1: Failing tests:** a real `MedplumClient` against `serveStore` on a temp file does `createResource`, `readResource`, `searchResources`, `searchResourcePages` (all pages), `updateResource` with If-Match (412 on stale), `readHistory`, `createBinary`/`download`, `executeBatch` of DELETEs; no token → 401 and no body detail; wrong token → 401; **Review Focus 1:** 3 concurrent clients each doing 200 create/update cycles on overlapping resources → every update either succeeds or gets 412, no 500, final versions consistent; **Review Focus 3:** binding to `0.0.0.0` is refused unless `host` is the Docker-internal interface (assert default host `127.0.0.1`).
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: store server with bearer token; GA_STORE=sqlite wiring`.

### Task 6: GA adaptation

**Files:**
- Modify: `src/engine.ts`, `src/concepts-cli.ts` (person-edit detection by writer tags, not `meta.author`), `src/smart/sync.ts`, `src/share/scope.ts`, `src/share/summary.ts` (attachment URLs from the store: `Binary/<id>` via `client.download`, no presigned `/storage/`), `src/tools/concepts.ts` (`concepts_to_review` adds `_sort`), `src/setup.ts` (with `GA_STORE=sqlite`: create the Patient in the store, no Medplum admin calls), `src/cli.ts` (store-unreachable error)
- Test: existing unit tests adjusted; new cases in `tests/engine.test.ts`, `tests/setup.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `getClient` with `GA_STORE=sqlite` (Task 5).
- Produces: writer identity from tags `writer-importer`, `writer-agent`, `writer-sync` (existing tag codes; add `writer-sync` if absent); `isGaNotRunning(e: unknown): boolean` and the message `GA is not running: start it with docker compose up -d`.

- [ ] **Step 1: Failing tests:** an agent-written record (tag `writer-agent`) then a differing import → `source-conflict`, record kept (same behaviour as today on Medplum); setup with `GA_STORE=sqlite` creates exactly one Patient with identifier `…|self` and writes `.ga/config.json` without Medplum credentials; **Review Focus 5:** `ga status` with the store down prints exactly the not-running message and exits 1; `concepts_to_review` results are in a defined order (two runs on reshuffled storage return the same order).
- [ ] **Step 2:** Remove code and tests that exist only for hand edits made in the Medplum app (list them in the commit message).
- [ ] **Step 3–4:** implement → `npm test` PASS (both `GA_STORE` values for affected tests). Commit `feat: GA runs on the SQLite store (writer tags, binaries, setup, not-running error)`.

### Task 7: `ga migrate-store` with verification

**Files:**
- Create: `src/store/migrate.ts` (copy) and `src/store/verify.ts` (replay + compare; port the spike's `load.ts`/`replay.ts`)
- Modify: `src/cli.ts`
- Test: `tests/integration/migrate-store.test.ts` (throwaway `ga-test` project → temp SQLite)

**Interfaces:**
- Consumes: Medplum client (`getClient` with `GA_STORE=medplum`), `Store` (Tasks 2–4).
- Produces: `ga migrate-store [--file <path>] [--yes]`: stops `ga-sync`/`ga-gateway` (prints the docker command if it cannot), copies every resource GA reads (patient compartment + referenced Medication, Endpoint, Basic, ConceptMap, Provenance, AuditEvent, DocumentReference and Binaries) preserving id, versionId, lastUpdated, tags, extensions; full history for MedicationStatement, MedicationRequest, Condition, AllergyIntolerance, Patient; then `verify` replays GA's read tools and a fixed search set on both and writes a report (counts and categories only) to `.ga/store/migrate-report.json`; the switch (`GA_STORE=sqlite` in `.env`) happens only with `--yes` and zero unexplained differences. Allowed differences: freshly signed attachment URLs; order among equal sort keys in queries without a tiebreaker.

- [ ] **Step 1: Failing integration test:** seed the throwaway project (Patient, Observations with versions, MedicationRequest with 2 versions, a DocumentReference with a Binary, a Provenance, a share-scoped record set); migrate; assert every id/versionId/lastUpdated equal, history of the MedicationRequest has 2 versions, Binary bytes equal; **Review Focus 2:** every resource's `meta.compartment` equals Medplum's, and a deliberate mismatch (test hook) makes the verify gate fail and leaves `GA_STORE` unchanged; the report contains no resource content.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run --project integration tests/integration/migrate-store.test.ts`). Commit `feat: ga migrate-store copies the record from Medplum and verifies it`.

### Task 8: Compose, backup, setup, docs; default flips to SQLite

**Files:**
- Modify: `compose.yaml` (new `ga-store` service running `ga store serve` on the internal network + `127.0.0.1:8120` for host CLI/stdio MCP; `ga-sync`/`ga-gateway` get `GA_STORE`/`GA_STORE_URL`; `fhir-converter` moves under a `ccda` profile started by `ga import` of C-CDA or documented command; Medplum services under a `medplum` profile), `scripts/backup.sh` (SQLite online backup via `VACUUM INTO` + `binary/` copy), `setup.sh` (no Medplum wait when `GA_STORE=sqlite`; default `GA_STORE=sqlite` for new installs), `docs/operations.md` (where data lives, backup/restore, uninstall; admin app section removed for SQLite), `README.md`, `AGENTS.md`, `.mcp.json` env if needed
- Test: `tests/compose.test.ts` (existing compose assertions updated), `tests/backup.test.ts` if present

- [ ] **Step 1: Failing tests:** compose has `ga-store` with no public port except `127.0.0.1:8120`; `ga-gateway` has no route to the store port from outside (assert gateway config does not proxy `/fhir`); backup script produces a consistent SQLite file while writes run (integration: write loop + backup, then `PRAGMA integrity_check` = ok).
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: ga-store service, SQLite backups, converter on demand; docs`.

### Task 9: Run on the store — integration suite and performance gate

**Files:**
- Modify: `tests/integration/*` helpers to run against a temp SQLite store when `GA_STORE=sqlite` (no Medplum login limit, no ga-test projects needed)
- Create: `docs/superpowers/spikes/2026-11-08-store-gate.md` (measurements, counts only)

- [ ] **Step 1:** `GA_STORE=sqlite npm run test:int` — all integration files pass (fix product code, not tests, unless a test encodes a Medplum-only behaviour the spec drops; list each such change).
- [ ] **Step 2: Measure on a synthetic 30k-resource dataset and, read-only, on a copy of the owner's migrated store:** GA total RSS (store + gateway + sync in one container) under the bench workload; heavy-tool medians vs the Medplum figures in Global Constraints; **Review Focus 4:** RSS peak during `ga import` of a synthetic large Apple Health export (generate one; never the owner's file in the repo).
- [ ] **Step 3:** Record pass/fail against 512 MB and the speed goal (or the 1.5× fallback) in the gate write-up. Commit `test: integration suite on the SQLite store; performance gate write-up`.
