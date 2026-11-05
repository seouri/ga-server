# GA Server Milestone 1 (Statin Question) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run GA (Medplum) locally with one command, import the user's 8 Epic C-CDA documents and the lab PDF without duplicates, and let Claude Code answer "Is starting Atorvastatin 40 mg the right decision?" from GA data.

**Architecture:**
- `docker compose up` runs Medplum (server and app), Postgres, Redis and Microsoft FHIR-Converter, all bound to localhost.
- A TypeScript package `ga` provides a CLI (`ga setup`, `ga import`) and a stdio MCP server (`ga mcp`).
- Both share one write engine. It gives every resource a stable identifier, collapses source Patients into the one GA Patient, and creates, updates, skips or flags each resource.
- PDFs are extracted by the user's local agent (default), which calls the MCP tool `ga_import`. `ga import --llm api` is the opt-in Claude API path.

**Tech Stack:** Node 26, TypeScript, `@medplum/core` + `@medplum/fhirtypes` 5.2.14, `@modelcontextprotocol/sdk`, `vitest`, Docker Compose, `mcr.microsoft.com/healthcareapis/fhir-converter:1.0.550-preview`, `@anthropic-ai/sdk` (Task 6 only).

**Spec:** `docs/superpowers/specs/2026-11-05-ga-server-design.md`

## Global Constraints

- Identifier `ga-server`. Medplum pinned to `5.2.14` (server, app and npm packages). Converter pinned to `1.0.550-preview`, which is amd64-only, so `platform: linux/amd64` (Rosetta on Apple Silicon).
- Every published port binds `127.0.0.1`. Postgres and Redis publish no ports.
- No PHI in the repo:
  - Fixtures are synthetic only.
  - Real-data tests read paths from env `GA_REAL_DATA` (outside the repo) and are skipped when it's unset.
  - `.ga/`, `data/` and `*.pdf` outside `tests/fixtures/` are gitignored.
- Namespaces (no real domain):
  - Identifier systems: `urn:ga-server:id:<kind>`
  - Tag system: `urn:ga-server:tag`
  - Source-date extension: `urn:ga-server:ext:source-date` (valueDateTime)
- Tags:
  - `writer-importer` or `writer-agent`
  - `src-ccda`, `src-pdf`
  - `extracted-by-llm`, `possible-duplicate`, `source-conflict`
- No silent merges. An uncertain match creates the resource and tags both resources `possible-duplicate`.
- Exactly one GA Patient. Every write function takes `patientId`; nothing reads "the" patient from global state.
- Least code: widely used open source; glue only.

## Review Focus

1. **Older export imported after a newer one.** Nothing reverts. → Task 3 test `older source does not overwrite`.
2. **Same lab in two C-CDAs whose converter IDs differ.** One Observation, holding both identifiers. → Task 3 test `content match with different identifier merges`.
3. **Converter emits resources referencing each other** (Observation → Encounter → Practitioner). References resolve to Medplum IDs, and a cycle doesn't hang. → Task 3 tests `rewrites intra-bundle references`, `throws on reference cycle`.
4. **Agent passes a file path that doesn't exist, or a resource with no `resourceType`.** `ga_import` returns a tool error and writes nothing. → Task 5 test `ga_import rejects bad input atomically`.
5. **Medplum not running or setup not done.** The CLI prints `GA is not running: run docker compose up` / `run ga setup first` and exits 1, with no stack trace. → Task 1 test `config missing gives clear error`.

---

### Task 1: Stack, package scaffold, and `ga setup`

**Files:**
- Create: `compose.yaml`, `.gitignore`, `.env.example`, `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/config.ts`, `src/setup.ts`, `src/cli.ts`
- Test: `tests/config.test.ts`, `tests/integration/stack.test.ts`

**Interfaces:**
- Produces:
  - `type GaConfig = { baseUrl: string; clientId: string; clientSecret: string; patientId: string; converterUrl: string }`
  - `loadConfig(path = '.ga/config.json'): GaConfig`. Throws `GaError('run ga setup first')`.
  - `getClient(cfg: GaConfig): Promise<MedplumClient>`. Logs in with `startClientLogin`, and throws `GaError('GA is not running: run docker compose up')` on connection refusal.
  - `class GaError extends Error`
  - `ga setup`, which writes `.ga/config.json` (mode 0600).
  - The npm script `test:int`, which runs `tests/integration/**` and needs a running stack.

- [ ] **Step 1: Write `compose.yaml`.** Start from Medplum's `docker-compose.full-stack.yml` (main branch) and change it:
  - pin the images to `5.2.14`
  - remove the postgres and redis `ports`
  - bind the server to `127.0.0.1:8103` and the app to `127.0.0.1:3000`
  - add service `fhir-converter` (image above, `platform: linux/amd64`, `127.0.0.1:8104:8080`)
  - use named volumes `ga-postgres`, `ga-binary` (mounted at the server's `./binary/`)
  - set `name: ga-server`
  - drop the Google and recaptcha keys
- [ ] **Step 2: Run** `docker compose up -d && docker compose ps`. Expected: all services `healthy` or `running`. `curl -s localhost:8103/healthcheck` returns `{"ok":true...}`. `lsof -iTCP -sTCP:LISTEN | grep -E '8103|3000|8104'` shows only `127.0.0.1`.
- [ ] **Step 3: Write the failing test** `tests/config.test.ts`:
  ```ts
  test('config missing gives clear error', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow('run ga setup first');
  });
  ```
- [ ] **Step 4: Run** `npx vitest run tests/config.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 5: Implement `src/config.ts`** (`loadConfig`, `getClient`, `GaError`), then `src/setup.ts` with `setup(baseUrl='http://localhost:8103/', converterUrl='http://localhost:8104/'): Promise<GaConfig>`. Setup:
  1. Logs in as Medplum's seeded super admin (`admin@example.com` / `medplum_admin`) via `startLogin` + `processCode`.
  2. Creates a ClientApplication `ga-server-cli` in the admin's project. Use the admin endpoint the Medplum app uses (`POST admin/projects/{projectId}/client`); verify the path against 5.2.14 source.
  3. Creates or reuses one Patient with identifier `urn:ga-server:id:patient|self`. Use `createResourceIfNoneExist`.
  4. Writes the config.

  It's idempotent: re-running reuses the existing client and Patient. Shortcut: default admin password left unchanged, safe only while bound to localhost. Change it before the sharing milestone.
- [ ] **Step 6: Implement `src/cli.ts`** with `ga setup`. `GaError` prints the message and exits 1. Add the `bin` `ga` entry in `package.json`.
- [ ] **Step 7: Write** `tests/integration/stack.test.ts`. Running `setup()` twice returns the same `patientId`, and `getClient` succeeds. Run `npx vitest run tests/config.test.ts && npm run test:int`. Expected: PASS.
- [ ] **Step 8: Commit** `feat: medplum stack on localhost and ga setup`.

### Task 2: Stable identity and patient collapse (pure functions)

**Files:**
- Create: `src/identity.ts`, `src/patient.ts`
- Test: `tests/identity.test.ts`, `tests/patient.test.ts`

**Interfaces:**
- Produces:
  - `type SourceInfo = { kind: 'ccda' | 'pdf'; file: string; date: string; writer: 'importer' | 'agent'; llm?: boolean }`. `date` is ISO; for C-CDA it's `ClinicalDocument/effectiveTime`, for a PDF it's the file mtime unless the agent passes a document date.
  - `stableIdentifier(r: Resource, s: SourceInfo, fileHash: string): Identifier`
    - ccda: `{system:'urn:ga-server:id:ccda', value: r.id}`. The converter's IDs are deterministic hashes of the C-CDA entry ids.
    - pdf: `{system:'urn:ga-server:id:pdf', value: sha256(fileHash|code|effective|value|unit)}`
  - `contentKey(o: Observation): string | undefined`. It's `system|code|YYYY-MM-DD` from the first coding plus `effectiveDateTime`/`effectivePeriod.start`. It's undefined when uncoded or undated.
  - `stamp(r: Resource, s: SourceInfo, id: Identifier): Resource`. It adds the identifier (if absent), the tags `writer-*`, `src-*` and `extracted-by-llm` when `s.llm`, the source-date extension, and `meta.source = s.file`.
  - `collapsePatients(rs: Resource[], gaPatientId: string): { resources: Resource[]; patientIdentifiers: Identifier[] }`. It removes every Patient, rewrites every `reference` equal to `Patient/<removedId>` or `urn:uuid:<removedId>` to `Patient/<gaPatientId>`, and returns the removed Patients' identifiers.

- [ ] **Step 1: Write the failing tests:**
  - `stableIdentifier is deterministic for ccda and pdf`
  - `contentKey ignores time of day` (`2024-07-26T08:00` and `2024-07-26T17:00` give the same key)
  - `contentKey undefined when uncoded`
  - `stamp is idempotent` (stamping twice gives one identifier and no duplicate tags)
  - `collapsePatients rewrites nested references and returns MRNs`. The fixture has 2 Patients plus an Observation whose `subject` and `performer[0]` reference them, and an Encounter whose `subject` is a `urn:uuid:` reference.
- [ ] **Step 2: Run** `npx vitest run tests/identity.test.ts tests/patient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write one `walkReferences(obj, fn)` helper in `src/patient.ts` that recursively visits every `reference` string. Task 3 reuses it.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: stable identifiers and patient collapse`.

### Task 3: Write engine (dedup, update-if-newer, conflicts, possible duplicates)

**Files:**
- Create: `src/engine.ts`
- Test: `tests/engine.test.ts` (pure `decide`), `tests/integration/engine.test.ts`

**Interfaces:**
- Consumes: Task 2 (`stamp`, `contentKey`, `collapsePatients`, `walkReferences`), Task 1 (`MedplumClient`).
- Produces:
  - `type Decision = 'create' | 'update' | 'skip' | 'conflict'`
  - `decide(existing: Resource | undefined, incoming: Resource): Decision`
    - no existing → `create`
    - existing has tag `writer-agent` and incoming is `writer-importer` → `conflict`
    - incoming source-date ≤ existing source-date → `skip`
    - content equal after stripping `id`/`meta` → `skip`
    - otherwise → `update`
  - `type ImportReport = { created: number; updated: number; skipped: number; merged: number; conflicts: number; possibleDuplicates: number }`
  - `importResources(client, resources: Resource[], source: SourceInfo, patientId: string, fileHash: string): Promise<ImportReport>`

Algorithm for `importResources`:
1. `collapsePatients`. Add the returned identifiers to the GA Patient if they're missing.
2. Topologically sort by intra-batch references (`Type/id` or `urn:uuid:id`). On a cycle, throw `GaError('reference cycle: <ids>')`.
3. For each resource in order: rewrite its intra-batch references using a map from source id to Medplum `Type/id`, `stamp` it, then search `Type?identifier=sys|val`.
   - Found: `decide`.
     - `update`: `updateResource` with the existing id.
     - `conflict`: tag the existing resource `source-conflict` and don't write.
     - `skip`: nothing.
   - Not found, and the resource is an Observation with a `contentKey`: search `Observation?subject=Patient/<pid>&code=<sys|code>&date=<day>`.
     - A match with equal `valueQuantity` (value + unit) or equal `valueString`: append the incoming identifier to the match and update it (`merged`).
     - A match with a different value: create the incoming resource, and tag both `possible-duplicate` with an `Observation.extension` `urn:ga-server:ext:possible-duplicate-of` → Reference.
   - Otherwise: `createResource`.
   - Record the id mapping in every case.

- [ ] **Step 1: Write the failing unit tests** for `decide`:
  - `create when none`
  - `older source does not overwrite`
  - `equal content skips`
  - `newer different content updates`
  - `agent-written conflicts`
- [ ] **Step 2: Write the failing integration tests** (synthetic resources, fresh patient via `setup`):
  - `reimport is a no-op`: import a 5-resource batch twice; the second report has `created:0, updated:0`, and the search counts are unchanged.
  - `rewrites intra-bundle references`: Observation.encounter points at the Medplum Encounter id.
  - `throws on reference cycle`
  - `content match with different identifier merges`: same LOINC 2093-3, day, value and unit under two identifiers gives 1 Observation with 2 identifiers.
  - `different value flags possible-duplicate`: gives 2 Observations, both tagged.
  - `newer source updates MedicationStatement status`: active → stopped, and `_history` has 2 versions.
  - `older source after newer does not revert`
- [ ] **Step 3: Run** `npx vitest run tests/engine.test.ts && npm run test:int`. Expected: FAIL.
- [ ] **Step 4: Implement `src/engine.ts`.**
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat: dedup write engine`.

### Task 4: C-CDA importer and `ga import`

**Files:**
- Create: `src/ccda.ts`, `src/document.ts`
- Modify: `src/cli.ts` (add `import`)
- Create: `tests/fixtures/ccda-synthetic.xml`. This is a minimal synthetic C-CDA with a fake patient: 1 result (LDL), 1 vital (systolic BP), 1 active medication, 1 problem, and smoking status.
- Test: `tests/ccda.test.ts`, `tests/integration/ccda.test.ts`, `tests/integration/real-data.test.ts` (skipped unless `GA_REAL_DATA`)

**Interfaces:**
- Consumes: Task 3 `importResources`, Task 1 `GaConfig.converterUrl`.
- Produces:
  - `convertCcda(xml: string, converterUrl: string): Promise<Resource[]>`. It calls `POST {converterUrl}convertToFhir?api-version=2024-05-01-preview` with body `{InputDataFormat:'Ccda', RootTemplateName:'CCD', InputDataString: xml}`, then returns `result.entry[].resource`.
  - `ccdaDate(xml: string): string`. It reads `ClinicalDocument/effectiveTime/@value` and returns ISO.
  - `storeDocument(client, filePath: string, patientId: string, contentType: string): Promise<{ docRef: DocumentReference; fileHash: string }>`. It stores a Binary plus a DocumentReference with identifier `urn:ga-server:id:file|<sha256>`, using `createResourceIfNoneExist`, so the same file is stored once.
  - `importPath(client, cfg, path: string): Promise<ImportReport>`. A directory is walked for `*.XML`/`*.xml` whose root is `ClinicalDocument`. Other XML (e.g. `METADATA.XML`) is skipped with a log line.
  - `ga import <path>` prints the summed `ImportReport` as one JSON line.

- [ ] **Step 1: Write the failing tests:**
  - `ccdaDate parses effectiveTime`
  - integration `synthetic ccda imports LDL, BP, med, problem, smoking with GA patient as subject`
  - integration `importing the same ccda twice changes nothing`
  - integration `ccda file stored once as DocumentReference`
- [ ] **Step 2: Run** `npx vitest run tests/ccda.test.ts && npm run test:int`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/ccda.ts`, `src/document.ts` and the CLI command. Parse XML with the built-in regex for `effectiveTime` only. Don't add an XML library.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Real-data check (spec [check]).** Run `GA_REAL_DATA=/path/to/health-data npm run test:int -- real-data`. The test:
  1. imports `HealthSummary_export/IHE_XDM/Patient1/` twice
  2. asserts that the second report has `created:0`
  3. asserts that exactly one Patient exists
  4. prints, **counts only**, how many converter ids repeated across the 8 docs and how many Observations were `merged` by content key

  Record those counts (not values) in the commit message. If `merged` is large, the converter ids aren't stable across documents and content-key dedup is doing the work. That's expected and fine.
- [ ] **Step 6: Commit** `feat: ccda import with dedup`.

### Task 5: MCP server and local-agent PDF extraction

**Files:**
- Create: `src/mcp.ts`, `skills/ga-extract/SKILL.md`, `.mcp.json`, `AGENTS.md`
- Modify: `src/cli.ts` (add `mcp`)
- Test: `tests/integration/mcp.test.ts`

**Interfaces:**
- Consumes: Task 3 `importResources`, Task 4 `storeDocument`.
- Produces (stdio MCP server `ga mcp`, name `ga-server`). Reads go through GA's own server rather than the plugin's FHIR MCP, because one agent-agnostic server also works for Codex and Hermes with no token refresh. This is a deviation from spec §3, made as a call.
  - `fhir_search({resourceType, params: Record<string,string>})` → Bundle JSON
  - `fhir_read({resourceType, id})` → resource JSON
  - `ga_import({resources: Resource[], sourceFile: string, documentDate?: string})` → `ImportReport`. It:
    1. validates that every item has `resourceType` and that `sourceFile` exists
    2. calls `storeDocument`
    3. sets each resource's `derivedFrom` (Observation) or a `note` link to the DocumentReference
    4. calls `importResources` with `{kind:'pdf', writer:'agent', llm:true}`

    Validation failures return an MCP error before any write.
- `skills/ga-extract/SKILL.md` (mirrored in `AGENTS.md` for Codex and Hermes) tells the agent to:
  - read the PDF or image locally
  - emit one Observation per result: LOINC coding when confident, otherwise `code.text` only; `valueQuantity` with a UCUM unit; `effectiveDateTime` = collection date; `referenceRange`; `status: final`
  - emit Conditions and MedicationStatements only when explicitly stated
  - never invent values
  - call `ga_import` once per document
- `.mcp.json` registers `ga mcp` for Claude Code in this repo.

- [ ] **Step 1: Write the failing integration tests.** Use the MCP SDK client over stdio against `ga mcp`, with the synthetic fixture `tests/fixtures/labs-synthetic.pdf` (a made-up 1-page lab report generated in the test setup or committed as synthetic):
  - `ga_import stores document and links observations`
  - `ga_import twice is a no-op`
  - `ga_import rejects bad input atomically` (a missing file, then an item without `resourceType`: an error each time, and the Observation count is unchanged)
  - `fhir_search returns imported LDL`
- [ ] **Step 2: Run** `npm run test:int -- mcp`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/mcp.ts` and the `ga mcp` command, then write the skill, `AGENTS.md` and `.mcp.json`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: mcp server and agent pdf extraction`.

### Task 6: `ga import --llm api` (opt-in Claude API extraction)

Load the `claude-api` skill before writing this task's code.

**Files:**
- Create: `src/llm.ts`
- Modify: `src/cli.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: Task 5's extraction instructions (read the text from `skills/ga-extract/SKILL.md` so there's one source of truth), and the same validation and write path as `ga_import`. Factor that path into `importExtracted(client, cfg, resources, sourceFile, documentDate?)` in `src/mcp.ts` and reuse it.
- Produces:
  - `extractWithApi(filePath: string, apiKey: string): Promise<Resource[]>`. It sends the PDF as a document block with model `claude-opus-5-5`, and uses a tool or JSON output to return `{resources: Resource[]}`.
  - `ga import <file.pdf> --llm api` requires `ANTHROPIC_API_KEY`. Without `--llm api`, a PDF path prints `PDFs are extracted by your agent: ask it to import <file>, or pass --llm api` and exits 1.

- [ ] **Step 1: Write the failing tests:**
  - `pdf without --llm api refuses with guidance`
  - `extractWithApi parses tool output into resources`. Inject a fake SDK client; don't make a network call.
- [ ] **Step 2: Run** `npx vitest run tests/llm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: opt-in api pdf extraction`.

### Task 7: Milestone acceptance on real data and README

**Files:**
- Create: `README.md` (setup: `docker compose up -d`, `npm i -g .` or `npx ga`, `ga setup`, `ga import`, connecting Claude Code / Codex / Hermes)
- Modify: `tests/integration/real-data.test.ts`

- [ ] **Step 1: Extend the real-data test** (skipped unless `GA_REAL_DATA`) with acceptance §10.4.
  - For each input, search GA and assert presence or report it as missing: age/birthDate, sex, total cholesterol (LOINC 2093-3), HDL (2085-9), LDL (13457-7 / 18262-6), systolic BP (8480-6), BP-med status (active MedicationStatement/Request list), A1c (4548-4), smoking (72166-2), eGFR (33914-3 / 62238-1 / 98979-8), BMI (39156-5).
  - Each found item must have `meta.source`.
  - Print presence or absence only, no values.
- [ ] **Step 2: Run** `GA_REAL_DATA=/path/to/health-data npm run test:int -- real-data`. Expected: PASS, with the presence table printed.
- [ ] **Step 3: Import the lab PDF in local-agent mode.** In Claude Code in this repo, ask: "Import /path/to/health-data/checkup-report.pdf into GA." Expected: a `ga_import` report with `created > 0`. Asking again gives `created: 0`.
- [ ] **Step 4: Rerun the presence table.** Expected: the gaps the PDF covers are now present.
- [ ] **Step 5: Run the milestone question.** In Claude Code, ask "Is starting Atorvastatin 40 mg the right decision?" Expected: the answer
  - cites GA resources
  - computes PREVENT (plus PCE) 10-year risk
  - references the current guideline
  - lists missing inputs

  This is a manual check by the user. Don't record the answer in the repo.
- [ ] **Step 6: Commit** `docs: readme and milestone-1 acceptance`.
