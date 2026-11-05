# GA Milestone 2a (EHI Import) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ga import <ehi-folder>` brings the user's whole Epic EHI export into GA. Clinical tables become FHIR records, deduplicated against the milestone-1 C-CDA data. Notes, MyChart messages and media become readable documents, and the whole export is archived. A tested `vaccine_gaps` tool answers "Did I miss any vaccinations for my age?" from a shipped CDC schedule.

**Architecture:**
- `src/ehi/` holds a TSV reader, one mapper module per area (each turning tables into FHIR resources with stable GA identifiers plus Epic "link" identifiers), and an orchestrator.
- Everything writes through the existing `importResources`. The engine gains `kind: 'ehi'` and a lookup by link identifier for all resource types.
- `src/vaccines.ts` plus `src/schedules/*.json` follow the `risk_score` pattern: pure tested logic, exposed as an MCP tool that reads GA itself.

**Tech Stack:** Node 26 TypeScript (runs `.ts` directly), `@medplum/core` 5.2.14, vitest, `@modelcontextprotocol/sdk`, `fast-xml-parser` (already installed). The system `tar` builds the archive. No new npm dependencies unless a task says otherwise.

**Spec:** `docs/superpowers/specs/2026-11-06-ehi-import-design.md`. It builds on `docs/superpowers/specs/2026-11-05-ga-server-design.md`.

## Global Constraints

- GA identifier system for EHI records: `urn:ga-server:id:ehi:<org>`, with value `<TABLE>|<pk>`.
- `SourceInfo.kind` gains `'ehi'`. Every EHI resource's source date is the export's creation date.
- No silent merges: an uncertain cross-source match is tagged `possible-duplicate`, never merged.
- When linked records differ, the newer source's version wins. Equal or older sources only add their identifier, and person- or agent-edited records stay protected (existing `decide` rules).
- No PHI in the repo:
  - fixtures are synthetic (`tests/fixtures/ehi/`)
  - real-data tests read `GA_REAL_DATA` and print counts only
  - never commit, log or report real values, names or dates
  - never `cat` or `grep` real data contents; read headers and counts only
- No network calls from the importer, except to the local Medplum and converter.
- No invented codes: values without a known standard code use `code.text`.
- Billing, claims, insurance, scheduling and audit tables are archived only, never mapped.
- Integration tests use `createTestPatient`/`cleanupTestPatient`. Medplum allows 5 admin logins per minute, so run only focused integration files while iterating.
- Real export path: `GA_REAL_DATA=/path/to/health-data`, folder `ehi-export/`.

## Review Focus

1. **Another organization's export is missing tables or has empty ones.** The importer skips each one with a counted reason and never crashes. Test `missing and empty tables are skipped and counted` (Task 1).
2. **TSV fields contain quoted tabs, quotes or line breaks** (notes and messages). The reader keeps them intact. Test `reader handles quoted fields with tabs and newlines` (Task 1).
3. **EHI dates have no zone, unlike the C-CDA's.** Content matching normalizes both the same way, so the same lab merges rather than being flagged. Test `EHI result merges with the C-CDA result of the same order` (Task 3).
4. **A newer EHI export changes a problem's status.** GA updates it; importing the older export again doesn't revert it. Test `newer export updates a problem; older export does not revert` (Task 2).
5. **RTF with `\uN` unicode escapes, `\'hh` hex escapes and nested groups** still yields readable text. Test `rtf text keeps unicode and drops control groups` (Task 4).

---

### Task 1: EHI reader, export detection, and recon of the [check] items

**Files:**
- Create: `src/ehi/read.ts`
- Create: `tests/fixtures/ehi/` (synthetic mini export: `EHITables/*.tsv` for each table later tasks map, `Rich Text/HNO_1001_1.RTF`, `Media/scan.pdf` reused from `tests/fixtures/labs-synthetic.pdf`, `readme.txt`)
- Test: `tests/ehi-read.test.ts`
- Create (gitignored, outside the repo): `.superpowers/sdd/<workspace>/ehi-recon.md`, holding counts and structure only

**Interfaces:**
- Produces:
  - `type Row = Record<string, string>`
  - `isEhiExport(dir: string): boolean` returns true when `dir/EHITables` exists.
  - `class EhiTables { constructor(dir: string); rows(table: string): Row[]; skipped: { table: string; reason: 'missing' | 'empty' }[] }`. `rows` returns `[]` and records a skip when a table is missing or empty.
  - `exportInfo(dir: string): { org: string; date: string }`. `org` is a stable slug for the Epic organization and `date` is the export's creation date as ISO.

- [ ] **Step 1: Recon (counts and structure only).** Answer each **[check]** in the spec. Write the answers to `ehi-recon.md`:
  - (a) how `HNO_INFO.NOTE_ID` maps to `Rich Text/HNO_*.RTF` file names
  - (b) whether result components carry LOINC anywhere (`OBS_MTHD_ID`, component tables), and which columns
  - (c) the formats of `RESULT_DATE`, `CONTACT_DATE`, `IMM_DATE`, `RECORDED_TIME` (pattern only, e.g. `M/D/YYYY h:mm:ss AM`)
  - (d) the Epic OID roots the C-CDA uses for each id kind (order, CSN, problem list, immunization), matched by value overlap. Record roots and counts only
  - (e) where the export carries its org (an OID prefix like `1.2.840.114350.1.13.<n>` in any table or the readme) and its creation date
  - (f) whether `HM_HISTORY`/`HM_HISTORICAL_STATUS` hold current due status or only history
  - (g) the TSV quoting convention, from `EHITables Schema` or `readme.PDF`

  Pick the `exportInfo` sources from (e).
- [ ] **Step 2: Write failing tests** in `tests/ehi-read.test.ts`:
  - `reader handles quoted fields with tabs and newlines`: a fixture row with `"a\tb\nc"` and `""` escapes reads back exactly
  - `missing and empty tables are skipped and counted`
  - `isEhiExport detects the fixture and rejects a C-CDA folder`
  - `exportInfo reads org and date from the fixture`
- [ ] **Step 3: Run** `npx vitest run tests/ehi-read.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement `src/ehi/read.ts`.** Parse TSV per the convention found in Step 1(g), with no CSV dependency. Build the synthetic fixture from the real header lines (column names only) with made-up values.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat: EHI export reader`.

### Task 2: Engine support for EHI sources and link identifiers

**Files:**
- Modify: `src/identity.ts` (`SourceInfo`, `stableIdentifier`)
- Modify: `src/engine.ts` (existing-record lookup)
- Test: `tests/engine.test.ts`, `tests/integration/engine.test.ts`

**Interfaces:**
- Consumes: Task 1's recon (d), for the Epic OID roots.
- Produces:
  - `SourceInfo.kind: 'ccda' | 'pdf' | 'ehi'`
  - For `ehi`, `stableIdentifier` returns `r.identifier[0]`, which mappers set to `{ system: 'urn:ga-server:id:ehi:<org>', value: '<TABLE>|<pk>' }`. It throws `GaError` if that identifier is absent.
  - Link identifiers are the resource's other identifiers whose system is an Epic OID (`urn:oid:1.2.840.114350.`). For the C-CDA these are already present. EHI mappers add them with the roots from recon (d).
  - Engine lookup order, for every resource type:
    1. by the stable identifier
    2. if not found, by each link identifier (`Type?identifier=system|value`, patient-scoped where the type has a subject or patient)
    3. if still not found and the type is Observation, by the existing content key

    A link hit is treated exactly like a stable-identifier hit (`decide`, union identifiers).

- [ ] **Step 1: Write failing tests:**
  - unit: `stableIdentifier for ehi uses identifier[0]`; `stableIdentifier for ehi without a GA identifier throws`
  - integration:
    - `link identifier merges an EHI Encounter into the C-CDA Encounter with the same CSN`: one record, both identifiers, newer source body
    - `newer export updates a problem; older export does not revert`
    - `link identifier never crosses patients`
- [ ] **Step 2: Run** `npx vitest run tests/engine.test.ts && npx vitest run tests/integration/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both changes. Content-key and collision-guard behavior stays as is. Run the whole `tests/integration/engine.test.ts` to show milestone-1 behavior is unchanged.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: engine supports EHI sources and Epic link identifiers`.

### Task 3: Clinical mappers, part 1 (orders and results, encounters, diagnoses, problems)

**Files:**
- Create: `src/ehi/ids.ts`, `src/ehi/labs.ts`, `src/ehi/encounters.ts`, `src/ehi/conditions.ts`
- Create: `src/ehi/dates.ts` (date normalization)
- Test: `tests/ehi-map.test.ts`, `tests/integration/ehi.test.ts`

**Interfaces:**
- Consumes: `EhiTables`, `exportInfo` (Task 1). The link-id convention from Task 2.
- Produces:
  - `type EhiCtx = { org: string; date: string }`
  - `ehiId(ctx, table: string, pk: string): Identifier`
  - `epicId(ctx, kind: 'order' | 'csn' | 'problem' | 'imm', value: string): Identifier`, using the roots from recon (d)
  - `localId(table, pk)`: a resource `id` used for intra-batch references, e.g. `Encounter/PAT_ENC-<csn>`
  - `ehiDate(s: string): string`: FHIR date or dateTime, normalized the same way `ccdaDate` treats zone-less values (keep a local date or dateTime without inventing a zone)
  - `mapLabs(t, ctx): Resource[]` (DiagnosticReport per `ORDER_PROC`, Observation per `ORDER_RESULTS` row; LOINC per recon (b), else `code.text` = `COMPONENT_ID_NAME`)
  - `mapEncounters(t, ctx): Resource[]` (from `PAT_ENC`)
  - `mapConditions(t, ctx): Resource[]` (`PAT_ENC_DX` → category `encounter-diagnosis`; `PROBLEM_LIST` → `problem-list-item`, with status from `PROBLEM_STATUS_C_NAME` and `RESOLVED_DATE`)

  Every resource carries `ehiId` first, then its Epic link identifiers, and references its Encounter by `localId` where a CSN is present.

- [ ] **Step 1: Write failing unit tests** (synthetic fixture):
  - `mapLabs makes one report per order and one observation per result line`
  - `mapLabs uses LOINC when present, else code.text`
  - `mapConditions sets category and resolved status`
  - `ehiDate normalizes the export's date formats` (cases from recon (c))
- [ ] **Step 2: Write a failing integration test,** `EHI result merges with the C-CDA result of the same order`:
  - import the synthetic C-CDA fixture, then an EHI fixture whose order ID and value match
  - expect one Observation with both identifiers
  - a different value instead gives `possible-duplicate`
- [ ] **Step 3: Run** `npx vitest run tests/ehi-map.test.ts && npx vitest run tests/integration/ehi.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the mappers.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat: EHI labs, encounters and conditions`.

### Task 4: Clinical mappers, part 2, and documents

**Files:**
- Create: `src/ehi/history.ts` (immunizations, family history, vitals, social history, health maintenance, questionnaires), `src/ehi/meds.ts`, `src/ehi/documents.ts`, `src/ehi/rtf.ts`
- Modify: `src/mcp.ts` and the engine write path only if the new types need allow-listing. `ga_import`'s agent allow-list stays unchanged.
- Test: `tests/ehi-map.test.ts`, `tests/ehi-rtf.test.ts`

**Interfaces:**
- Consumes: Task 3's `EhiCtx`, `ehiId`, `epicId`, `localId`, `ehiDate`. `storeDocument` (existing).
- Produces:
  - `mapMeds(t, ctx)`: `ORDER_MED` → MedicationRequest; name from `MEDICATION_ID_MEDICATION_NAME`; link identifier is the order ID
  - `mapImmunizations(t, ctx)`: `IMM_ADMIN` and its components → Immunization; CVX if present, else `vaccineCode.text`; link identifier is the immunization ID
  - `mapFamilyHistory(t, ctx)`: one FamilyMemberHistory per relative, with conditions and onset ages
  - `mapVitals(t, ctx)`: flowsheet rows → vital-signs Observations, LOINC for BP, HR, weight, height, BMI, temp and SpO2, else by name
  - `mapSocial(t, ctx)`: smoking (72166-2) and alcohol Observations
  - `mapHealthMaintenance(t, ctx)`: per recon (f), Observation "health maintenance topic status" by name, or Procedure for completions
  - `mapQuestionnaires(t, ctx)`: one QuestionnaireResponse per answer set
  - `rtfToText(rtf: string): string`
  - `importDocuments(client, dir, t, ctx, patientId): Promise<ImportReport>`:
    - notes: `HNO_INFO` plus their RTF → DocumentReference, with the RTF as Binary and the plain text as a second `text/plain` attachment
    - MyChart messages: `MYC_MESG` plus `MYC_MESG_RTF_TEXT`/`MSG_TXT` → Communication, with `payload.contentString`, `sent`, sender/recipient display, `inResponseTo` thread
    - media: `Media/*` → DocumentReference via `storeDocument`

- [ ] **Step 1: Write failing tests:**
  - `rtf text keeps unicode and drops control groups`, with `䠔8?` style escapes, `\'e9`, `{\*\generator ...}` groups and `\par`
  - one test per mapper on the synthetic fixture, asserting type, codes or text, dates, identifiers and the encounter reference
  - `messages keep thread order and full text`
- [ ] **Step 2: Run** `npx vitest run tests/ehi-map.test.ts tests/ehi-rtf.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** RTF: a minimal stripper (control words, groups, unicode and hex escapes). Add a one-line `shortcut:` comment naming what it doesn't handle (tables, images).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: EHI history, medications, notes, messages and media`.

### Task 5: Orchestrator, archive, CLI, and real-data run

**Files:**
- Create: `src/ehi/import.ts`
- Modify: `src/cli.ts` (`ga import` detects EHI via `isEhiExport`)
- Modify: `tests/integration/real-data.test.ts`
- Test: `tests/integration/ehi.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  - `importEhi(client, cfg, dir, patientId = cfg.patientId): Promise<ImportReport & { skippedTables: number; archived: boolean }>`. It:
    1. builds `EhiCtx` from `exportInfo`
    2. runs every mapper and makes one `importResources` call with `{ kind: 'ehi', file: dir, date: ctx.date, writer: 'importer' }`
    3. runs `importDocuments`
    4. archives the folder with `tar -czf` into a temp file (shortcut: system `tar`; switch to a library only if Windows support is needed), stores it via `storeDocument` (stored once by hash), then deletes the temp file
  - `ga import <ehi-folder>` prints the report JSON.

- [ ] **Step 1: Write failing integration tests** (synthetic fixture, test patient):
  - `importing the EHI fixture twice is a no-op` (second report `created:0 updated:0`)
  - `archive is stored once and unpacks to the same file count`
  - `skipped tables are reported`
- [ ] **Step 2: Run** `npx vitest run tests/integration/ehi.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the orchestrator, archive and CLI branch.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Real data.** Extend `real-data.test.ts` with an EHI case. Run `GA_REAL_DATA=/path/to/health-data npx vitest run tests/integration/real-data.test.ts`. Write counts only to the gitignored workspace:
  - first and second import reports
  - per-type counts against source table row counts, with the skip reasons
  - merged and flagged counts against the C-CDA data, including the 19 linked orders
  - Patient count = 1
  - whether the archive is present

  Expected: second import 0/0, and one Patient.
- [ ] **Step 6: Commit** `feat: ga import for Epic EHI exports`.

### Task 6: CDC schedule and `vaccine_gaps` tool

**Files:**
- Create: `src/schedules/cdc-adult-immunization-<year>.json`, `src/vaccines.ts`
- Modify: `src/mcp.ts` (register `vaccine_gaps`)
- Test: `tests/vaccines.test.ts`, one case in `tests/integration/mcp.test.ts`

**Interfaces:**
- Produces:
  - **Schedule JSON:**
    ```
    { edition, sourceUrl, notEvaluated: string[],
      vaccines: [ { id, name, cvx: string[], names: string[],
                    rules: [ { ages: [min, max | null], sex?: 'male' | 'female',
                               doses: number, intervalMonths?: number, repeatYears?: number } ],
                    immuneIf?: { loinc?: string[], names: string[], positive: string[] } } ] }
    ```
  - `evaluateVaccines(schedule, input: { birthDate: string; sex: 'male' | 'female'; immunizations: { date: string; cvx?: string; name?: string; source: string }[]; immunity: { name: string; value: string; date: string; source: string }[] }, asOf: string)`. Returns `{ edition: string; results: { vaccine: string; status: 'complete' | 'due' | 'overdue' | 'not-recommended' | 'immune' | 'not-evaluated'; records: { date: string; source: string }[]; reason: string }[]; unmatched: { date: string; name?: string; cvx?: string; source: string }[] }`.
  - **MCP tool `vaccine_gaps({ asOf?: string })`:** reads Patient, Immunization and immunity Observations from GA itself, then returns `evaluateVaccines` on them. The description says to use it rather than judging the schedule by itself.

- [ ] **Step 1: Transcribe the current CDC adult immunization schedule into JSON.**
  - Routine, age- and sex-based recommendations only.
  - Medical-condition branches go in `notEvaluated`.
  - Record the edition and URL.
  - Fetch the schedule from cdc.gov during the task, not from memory, and cite the edition in the commit message.
- [ ] **Step 2: Write failing tests,** using synthetic histories:
  - `influenza due when no dose this season`
  - `Td/Tdap overdue after 10 years`
  - `zoster 2 doses complete at 50+`
  - `hepatitis B immune by surface antibody`
  - `unmatched immunization name is listed, not guessed`
  - `not-recommended outside age range`
- [ ] **Step 3: Run** `npx vitest run tests/vaccines.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `src/vaccines.ts` and register the tool.
- [ ] **Step 5: Run** the same command plus `npx vitest run tests/integration/mcp.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: vaccine_gaps tool with CDC adult schedule <edition>`.

### Task 7: Docs and skill updates; acceptance

**Files:**
- Modify: `AGENTS.md`, `.claude/skills/ga/SKILL.md`, `README.md`

- [ ] **Step 1: Update `AGENTS.md` and `/ga`:**
  - where notes (DocumentReference with a `text/plain` attachment), messages (Communication), family history (FamilyMemberHistory) and health maintenance live
  - current medications = active MedicationStatement plus active MedicationRequest
  - vaccinations: call `vaccine_gaps`, and show Epic health maintenance as a second opinion
- [ ] **Step 2: Update `README.md`:** an `ga import <ehi-folder>` example, and what EHI brings.
- [ ] **Step 3: Run** `npm test`, `npm run typecheck`, then `npm run test:int`. Expected: all pass.
- [ ] **Step 4: Commit** `docs: EHI import and vaccine_gaps in agent guidance`.
- [ ] **Step 5: Manual acceptance (by the user):** `/ga Did I miss any vaccinations for my age?` in a fresh Claude Code session, after `/mcp` reconnects.
