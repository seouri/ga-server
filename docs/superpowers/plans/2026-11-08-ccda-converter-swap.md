# C-CDA Converter Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert C-CDA in process with a patched copy of Medplum's `@medplum/ccda`, prove it imports the same or more than Microsoft's converter on the owner's documents, replace the existing C-CDA records in one owner-started step, then remove the Microsoft converter.

**Architecture:** The library's TypeScript source (5.2.15, Apache-2.0) is vendored under `vendor/medplum-ccda/`, so GA can fix it (each fix one commit, one upstream issue/PR) with no new npm dependency; it is dropped for the npm release once Medplum ships the fixes. GA's `src/ccda.ts` gains the in-process path beside the Microsoft one, selected by a config flag the replace command sets. A read-only comparison command proves parity on stored documents; a replace command (dry run by default) swaps the records, rehearsed first on a SQLite copy of the owner's record.

**Tech Stack:** Node 26 strip-only TypeScript, vitest, `fast-xml-parser` (already a dependency), `@medplum/core` 5.2.14 (bump to 5.2.15 only if the vendored source needs it).

**Spec:** `docs/superpowers/specs/2026-11-08-ccda-converter-swap-design.md`. Spike: `docs/superpowers/spikes/2026-11-08-ccda-converter.md` (gaps, counts, the `promote()` pre-pass).

## Global Constraints

- Same or more, never less, never duplicates. A difference may only be explained (not fixed) when the old record holds no information (e.g. the Microsoft path's empty lab placeholders).
- Nothing silently skipped: every section and entry becomes a record or is named in the report (`notImported`) with a reason.
- No new npm dependency. `vendor/medplum-ccda/` keeps Medplum's `LICENSE` (Apache-2.0) and a `NOTICE`/`PATCHES.md` listing every change against 5.2.15.
- Each vendored fix is one commit, maps to one upstream issue (and PR), and carries its own synthetic test.
- Nothing is opened publicly (issues, PRs) without the owner's go-ahead for that item.
- No PHI in the repo: tests use `tests/fixtures/ccda-synthetic.xml` and new PHI-free Epic-style fixtures; reports on real documents hold counts, element paths, section names and template ids only, and live outside the repo.
- Tests never write to the owner's real record (test Patient only; the importer refuses records for another patient). The comparison and dry runs are read-only.
- Medplum stays the default store; everything works on both stores. `src/store` is untouched (separability principle).
- Convert one document at a time (memory: largest document ~122 MB peak).

## Review Focus

1. Re-importing the same document after the swap: every record skipped, zero created (Task 10 test `re-import after replace is a no-op`).
2. A newer summary repeating older history (two synthetic documents sharing entry ids, different dates): updates, no duplicates (Task 2 test `a later document repeating an entry updates it`).
3. Replace interrupted midway, then rerun: finishes, no duplicate and no lost record (Task 10 test `a rerun after a crash finishes the replace`).
4. A record merged from EHI and C-CDA: keeps its EHI identity and body source, C-CDA part restored by the re-import (Task 10 test `a merged record keeps its other sources`).
5. A non-Epic C-CDA (the generic synthetic fixture): converts with full accounting, no throw (Task 2 test `the generic fixture converts with nothing unaccounted`).

---

### Task 1: Vendor `@medplum/ccda` 5.2.15

**Files:**
- Create: `vendor/medplum-ccda/` (the `packages/ccda/src` files of medplum `v5.2.15`: `ccda-to-fhir.ts`, `types.ts`, `systems.ts`, `oids.ts`, `xml.ts`, `datetime.ts`, `templates.ts`, `sanitize.ts`, `index.ts`; `fhir-to-ccda/` omitted), `vendor/medplum-ccda/LICENSE`, `vendor/medplum-ccda/PATCHES.md`, `vendor/medplum-ccda/test/` (upstream tests that run under vitest)
- Modify: `vitest.config.ts` (include `vendor/**/test/*.test.ts`), `tsconfig.json` (include `vendor`)

**Interfaces:**
- Produces: `convertXmlToCcda(xml: string): Ccda`, `convertCcdaToFhir(ccda: Ccda, options?: { ignoreUnsupportedSections?: boolean }): Bundle` from `vendor/medplum-ccda/index.ts`, unchanged in behaviour from 5.2.15.

- [ ] **Step 1:** Fetch the files at tag `v5.2.15` (`gh api repos/medplum/medplum/contents/packages/ccda/src/<file>?ref=v5.2.15`). First commit: verbatim copy plus LICENSE.
- [ ] **Step 2:** Second commit, mechanical only: relative imports get `.ts` extensions; type-only imports become `import type`; anything else Node's type stripping rejects is rewritten minimally. `PATCHES.md` row 0: "mechanical: strip-only TypeScript".
- [ ] **Step 3:** Port the upstream tests that need no Medplum test harness (`g9`, `datetime`, `systems`, `sanitize`, `xml`, `address`, `nullflavor`, `medication-dose`) to vitest; drop `roundtrip` (needs fhir-to-ccda). Run `npx vitest run vendor` — PASS. Run `npx tsc --noEmit` — clean.
- [ ] **Step 4:** Test `vendored library converts the synthetic fixture like the npm package`: convert `tests/fixtures/ccda-synthetic.xml` with the vendored code; assert resource counts by type equal the spike's synthetic numbers (Observation 5, Condition 2, MedicationRequest 1). Commit.

### Task 2: In-process conversion path in GA, with accounting

**Files:**
- Modify: `src/ccda.ts`, `src/config.ts` (`ccdaConverter?: 'medplum'`), `src/engine.ts` (`ImportReport.notImported`), `src/share/scope.ts` (Goal, CareTeam, PractitionerRole shareable as compartment/support records like their peers; RelatedPerson stays in `NEVER`)
- Test: `tests/ccda.test.ts`, new fixture `tests/fixtures/ccda-epic-style.xml` (PHI-free, Epic template order, one entry per section kind the spike lists)

**Interfaces:**
- Consumes: Task 1's `convertXmlToCcda`, `convertCcdaToFhir`.
- Produces: `type NotImported = { section: string; templateId?: string; entries: number; reason: string }`; `convertCcdaLocal(xml: string): { resources: Resource[]; notImported: NotImported[] }`; `convertCcdaMs(xml: string, converterUrl: string): Promise<Resource[]>` (today's `convertCcda`, renamed); `ccdaConverter(cfg: GaConfig): 'medplum' | 'microsoft'`; `ImportReport.notImported?: NotImported[]`.

- [ ] **Step 1: Failing tests** in `tests/ccda.test.ts`:
  - `the generic fixture converts with nothing unaccounted`: `convertCcdaLocal(synthetic).notImported` is `[]`; every section in the XML appears in the output or in `notImported`.
  - `the Epic-style fixture converts (template order) and lists what it cannot import yet`: no throw; every section of the fixture is either imported or in `notImported` with a reason (exact list asserted; it shrinks as Tasks 4-8 land).
  - `a later document repeating an entry updates it` (on the store via `onStore`): import fixture A, then fixture B with the same entry id and a later date → `created: 0`, `updated ≥ 1`, one record.
  - `ccdaConverter picks medplum when the flag is set or the record has no C-CDA records, else microsoft`.
- [ ] **Step 2:** Run `npx vitest run tests/ccda.test.ts` — FAIL.
- [ ] **Step 3:** Implement. `convertCcdaLocal` = the spike's `promote()` pre-pass + vendored conversion + GA's `repair` (extended to the library's output shape) + accounting (walk sections/entries in the XML; whatever produced no resource and no deliberate drop goes to `notImported`). Never use `ignoreUnsupportedSections` silently: unsupported sections are accounted. `importPath` chooses by `ccdaConverter(cfg)` (one search `_tag=src-ccda&_count=1` when the flag is absent) and adds `notImported` to the report; `ga import` prints it (section names and counts only).
- [ ] **Step 4:** Run the file, `npm test`, `GA_STORE=sqlite npm test` — PASS. Commit.

### Task 3: Comparison command `ga ccda compare`

**Files:**
- Create: `src/ccda-compare.ts`
- Modify: `src/cli.ts`
- Test: `tests/ccda-compare.test.ts`

**Interfaces:**
- Consumes: `convertCcdaMs`, `convertCcdaLocal`, `cdaKeys`/`fhirKey` in `src/ccda.ts` (export them).
- Produces: `matchEntries(old: Resource[], neu: Resource[]): Map<Resource, Resource | undefined>` (by source CDA entry id, then type; documented fallback for id-less entries); `type Loss = { type: string; path: string; count: number; explained?: string }`; `compareCcda(xml: string, old: Resource[], neu: Resource[], notImported: NotImported[]): { losses: Loss[]; gains: Record<string, number>; unaccounted: NotImported[] }`; CLI `ga ccda compare [--out <file>]` over every stored C-CDA document (DocumentReference identified `urn:ga-server:id:file`, XML), read-only.

- [ ] **Step 1: Failing tests:** `a field present in the old record and missing in the new is a loss with its element path`; `an empty old placeholder (no value, no code beyond text) is explained, not a loss`; `an entry only the new path produces is a gain`; `compare never writes` (fake client whose write methods throw).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. The report holds counts, types, element paths, section names and template ids only (never values). The Microsoft converter must be running (`CONVERTER_DOWN` otherwise). **Step 4:** Run — PASS. Commit.

### Tasks 4-8: Fixes in the vendored library (one commit per fix)

Each fix: a PHI-free Epic-style fixture fragment reproducing it, a failing vendored test, the minimal library change, a `PATCHES.md` row (fix, upstream issue to open, existing PR to reuse), and an `upstream/` draft (Task 11 collects them). After each task, `ga ccda compare` on the synthetic and Epic-style fixtures shows the matching losses gone and `notImported` shorter. Reuse open external PRs (medplum#11241 REAL values, #11242 narrative references and ED values, #11308 allergy category, #11243 family history, #11244 interval effectiveTime) by applying their diffs rather than rewriting.

### Task 4: Sections

- Section dispatch matches any of a section's templateIds (Epic lists the entries-optional root first), replacing the `promote()` pre-pass (remove it from Task 2's code).
- Import, not skip: Instructions, History of Present Illness, Reason for Referral, Reason for Visit, Progress Notes, Functional Status, Plan of Treatment narrative, Payers → `Coverage`. Resource per section is the builder's call, written as a table in `PATCHES.md`; narrative-only sections keep their text.
- Tests: `every section of the Epic-style fixture is imported` (`notImported` empty for these), `payers become Coverage, never shared` (scope test).

### Task 5: Problems and visit diagnoses

- Epic encounter diagnosis acts (template `2.16.840.1.113883.10.20.22.4.80`) become Conditions; GA's `repair` sets `encounter-diagnosis` vs `problem-list-item` as today.
- Test: `encounter diagnoses become Conditions linked to their encounter` (fixture with 2 diagnoses on one encounter → 2 Conditions, category `encounter-diagnosis`).

### Task 6: Medications

- Keep `substanceAdministration/id` as the resource identifier; `moodCode="EVN"` (taking) → MedicationStatement, `INT` (ordered) → MedicationRequest; drug name from the narrative `originalText` reference; RxNorm coding kept; status from `statusCode` as `repair` does today.
- Tests: `a taking entry stays a MedicationStatement with its source id and name`, `an order is a MedicationRequest`, and the spike's 5 Microsoft-only orders reproduced in the fixture and imported.

### Task 7: Results, vitals and social history

- `REAL` and `ED` values (reuse #11241, #11242); interpretation codes; organizer panels → DiagnosticReport with `result` references (as the Microsoft path did); social history, functional status and reason for visit observations get their own category, not vital-signs; the 17 social-history and 3 lab entries only the Microsoft path produced are imported.
- Tests: one per item, asserting the FHIR field the Microsoft path produced (value, `interpretation`, `DiagnosticReport.result`, `category`).

### Task 8: Immunizations, allergies, encounters, devices

- CVX system `http://hl7.org/fhir/sid/cvx` (not `http://nucc.org/cvx`); immunization `route`; allergy category and type from the observation value (reuse #11308); encounter `location` → Location resources; Device from the document's devices; Practitioner/Organization deduplicated by id as the Microsoft path did.
- Tests: `vaccine_gaps counts a converted immunization` (via `src/vaccines.ts`), `allergy category follows the source`, `encounter has its location`.

### Task 9: Parity gate on the owner's documents (read-only)

**Files:** none committed beyond fixes; report outside the repo.

- [ ] **Step 1:** With the Microsoft converter running (`docker compose --profile ccda up -d fhir-converter`), run `node src/cli.ts ccda compare --out <scratchpad>/compare.json` against the live record (read-only).
- [ ] **Step 2:** Every loss not marked explained goes back to the Task 4-8 area it belongs to, as a new fix with its own fixture (PHI-free reproduction). Repeat until `losses` (unexplained) is empty and `unaccounted` is empty.
- [ ] **Step 3:** Write counts-only summary to the report file for the owner (losses by type and path, gains by type, explained items with reasons). The owner reads it before Task 10's command runs for real.

### Task 10: Replace command `ga ccda replace`

**Files:**
- Create: `src/ccda-replace.ts`
- Modify: `src/cli.ts`, `src/config.ts` (atomic write of `ccdaConverter: "medplum"`)
- Test: `tests/ccda-replace.test.ts` (on the store, `onStore`), `tests/integration/ccda-replace.test.ts` (Medplum, test Patient)

**Interfaces:**
- Consumes: `convertCcdaLocal`, `matchEntries`, `importResources`, `storeDocument`'s stored documents.
- Produces: `replaceCcda(client: MedplumClient, cfg: GaConfig, o: { yes: boolean; log: (s: string) => void }): Promise<ReplaceReport>`; `type ReplaceReport = { deleted: Record<string, number>; stripped: Record<string, number>; kept: Record<string, number>; created: Record<string, number>; repointed: number; dangling: number; documents: number }`; CLI `ga ccda replace [--yes]` (without `--yes`: dry run, changes nothing, prints counts).

- [ ] **Step 1: Failing tests:**
  - `dry run changes nothing` (resource counts and versions identical before/after).
  - `re-import after replace is a no-op` (second import of each document: `created: 0`).
  - `a merged record keeps its other sources` (record with EHI + C-CDA identifiers: EHI identifier and record kept; C-CDA identifier replaced by the new one).
  - `protected records are kept` (`source-conflict`/agent-written C-CDA record not deleted; only its C-CDA identifier replaced).
  - `arrival times are preserved; gains take the document's import time` (`whats_new` since the day before the replace lists nothing).
  - `references are repointed` (a `Basic` follow-up pointing at a C-CDA DiagnosticReport, a possible-duplicate pointer) → point at the new records; `dangling: 0`.
  - `a record with no counterpart that something points at is kept`.
  - `refuses when a C-CDA record's source document is not stored`.
  - `a rerun after a crash finishes the replace` (inject a failure midway; rerun; no duplicates, `dangling: 0`).
  - `sets ccdaConverter to medplum only after success` (config untouched on failure or dry run).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. Order: back up (Medplum: the existing `ga-backup` run; store: VACUUM INTO via `scripts/backup.sh`'s path) → plan (old records by document, matched new records) → write new records first with preserved arrival (resumable: a run marker on each new record) → repoint references (scan the patient compartment and `Basic` for references to old ids) → strip or delete old records → verify (`compareCcda` against the stored result) → set the flag. Refusals happen before any write. **Step 4:** Run unit and integration tests on both stores — PASS. Commit.

### Task 11: Upstream drafts

**Files:** `docs/superpowers/upstream/ccda/<n>-<slug>.md` (one per `PATCHES.md` row)

- [ ] Each draft: issue title and body (problem, synthetic reproduction XML, expected FHIR), the PR description, the diff reference (vendored commit), and which existing external PR it builds on. PHI-free. Nothing is filed; the controller asks the owner item by item.

### Task 12: Rehearsal on a copy of the owner's record

- [ ] **Step 1:** Copy the live record read-only into a temp SQLite file with `migrateStore()` (no switch, as the store project's dry run did); serve it on a free port with a temp config (`store: "sqlite"`), under the scratchpad, outside the repo.
- [ ] **Step 2:** Run `ga ccda replace --yes` against the copy, then `ga ccda compare` against the copy's result, then a second `ga import` of each stored document (expect `created: 0`).
- [ ] **Step 3:** Record counts only (the `ReplaceReport`, the compare summary, the re-import counts); delete the copy. Any failure goes back to Task 10 with a synthetic reproduction.

**The owner runs `ga ccda replace` (dry run, then `--yes`) on the live record after reading Task 9's and Task 12's reports. That is not an implementer task.**

### Task 13: Remove the Microsoft converter (after the owner's replace)

**Files:** `compose.yaml` (service `fhir-converter`, profile `ccda`), `src/ccda.ts` (`convertCcdaMs`, `CONVERTER_DOWN`, the flag check: in-process becomes the only path), `src/config.ts` and `src/setup.ts` (`converterUrl`), `src/ccda-compare.ts` and its CLI (needs the Microsoft side: removed), tests that reference them, `README.md`, `docs/operations.md`, `docs/usage.md`, `AGENTS.md`.

- [ ] Tests: `compose has no fhir-converter`; `ga import of a C-CDA works with no converter configured`; config files with a leftover `converterUrl` or `ccdaConverter` still load. Run all gates on both stores. Commit.
