# Guardian Angel (GA) Server — Design

Identifier: `ga-server`. Date: 2026-11-05. Status: draft for approval.

Legend: **[user]** = decided by the user. **[call]** = designer's call, open to override. **[check]** = unverified fact the builder must confirm early.

## 1. Intent

The user's health data is not in one accessible place. It's spread across Epic exports (C-CDA and EHI), PDFs from outside providers, and Apple Health. GA is a FHIR server the user runs themselves. It holds all of that data with no duplicates, and AI agents, messaging apps, family and doctors read from it. **[user]**

**Success for milestone 1 [user]:** in Claude Code, the user asks *"Is starting Atorvastatin 40 mg the right decision?"* and gets a good answer grounded in GA data. A good answer **[call]**:
- pulls lipids (with their trend), BP, A1c/glucose, smoking, current meds and BP-med status, problems, eGFR, BMI, age and sex
- computes 10-year ASCVD risk (PREVENT, plus PCE for comparison)
- applies the current statin guideline
- cites the GA records it used, and lists missing inputs that would change the answer (e.g. CAC score, Lp(a), family history)

## 2. Goals, non-goals, anti-goals

**Goals [user]**
- Run a FHIR R4 server locally. Setting it up on a new machine is one docker command (or one app install).
- Import: hospital machine-readable exports (C-CDA XML, Epic EHI), PDFs/images of health documents, Apple Health export, and SMART-on-FHIR pulls from hospital patient portals.
- **Dedup is a must-have:** no matter how many times or from how many sources data is imported, GA holds unique records.
- AI agents (Claude Code, Codex, Hermes, etc.) can query and write to GA.
- Messaging access (iMessage, Slack, others).
- Share with family and doctors, who use their own devices. Doctors get a human-readable view **and** a standard FHIR export via API.
- Runs on a Mac first: both a laptop that's sometimes offline and a Mac that stays at home. Deployable as a Docker image to any server later.

**Non-goals for now**
- Multiple patients (family records). One patient only (the user), but nothing may assume a single patient in a way that blocks adding family later. **[user]**
- An iOS app for Apple Health sync. Exported files are enough for now; the app is a later goal. **[user]**
- Syncing between the laptop and the home Mac. Each runs its own copy. **[call]**
- Mapping all 5,531 EHI tables. Map only the tables needed for the clinical picture. **[call]**

**Anti-goals / safety defaults [call]** (the user skipped this question, so these are defaults)
- GA binds to localhost by default. Nothing is reachable from outside until the user turns on remote access or creates a share.
- A public share link exposes only that share's read-only view and FHIR export. It never exposes the Medplum admin app or the full API.
- No silent merges. When a cross-source match is uncertain, GA flags it instead of merging.
- Every resource extracted by an LLM keeps a link to its source file (the original is stored as a Binary/DocumentReference) and carries an extraction tag. A person can always check it against the original.
- No PHI in the git repo: no lab values or real data in docs, tests or fixtures. Data volumes are gitignored. Tests on real data read from paths outside the repo.
- Least build effort. Use widely used open source; write glue, not platforms. **[user]**

## 3. Architecture

```
            ┌────────────── ga-server (docker compose / bundled image) ──────────────┐
importers ─►│  Medplum server (FHIR R4 API, auth, AccessPolicy, SMART)  ◄─ Medplum app│
 (CLI)      │  Postgres · Redis                                                       │
            │  FHIR-Converter (C-CDA → FHIR)                                          │
            │  share view (read-only HTML + scoped FHIR)                              │
            └──────────▲────────────────────────▲─────────────────────▲──────────────┘
                       │ MCP (FHIR tools)       │ Tailscale (family)  │ Tailscale Funnel (doctor link)
             Claude Code / Codex / Hermes   family devices        doctor browser / EHR
                       ▲
              messaging gateway (iMessage, Slack) — existing agent with GA as a tool
```

- **FHIR server: Medplum** (Apache 2.0) **[call]**. Picked over HAPI because Medplum ships login, invites, per-user AccessPolicy, SMART-on-FHIR and a web app. With HAPI we would build all of those. Cost: it needs Postgres and Redis.
- **Packaging [call]:** `docker compose up` is the main path. A bundled single `ga-server` image (Medplum + Postgres + Redis + converter + importers, under a process supervisor) is packaging on top of it, for "one `docker run` on any server". All data lives in one named volume.
- **C-CDA conversion: Microsoft FHIR-Converter** (MIT, .NET), run as a container. **[call]**
- **Importers:** a small CLI (`ga import <path>`) in TypeScript, using `@medplum/core`. It detects the source type and runs the matching importer. **[call]** The language is the builder's choice if there's a strong reason.
- **Agent access:** an MCP server exposing FHIR tools against GA.
  - **[check]** The installed Claude healthcare plugin's FHIR MCP accepts `base_url` plus `bearer_token`, or a SMART `client_id`. It may work against Medplum with configuration only. Verify this.
  - For Codex and Hermes, use a standalone open source FHIR MCP server, or the same one if it can run standalone. **[check]**
  - Agents read through the stock FHIR MCP server. **All agent writes go through one GA MCP tool (`ga_import`, which takes a FHIR resource/Bundle plus a source document)** that runs the same import and dedup code as the CLI. No write path skips dedup. **[call]**
- **Remote access: Tailscale [call].** Family install Tailscale and get a Medplum login with an AccessPolicy. Doctors get a Tailscale Funnel URL for the share view only; they install nothing.

## 4. Data model and identity

- **One `Patient` per person.** Every source produces its own Patient. Each of the 8 C-CDAs will produce one, Apple clinical records contain 2, and EHI has its own. The importer **collapses these into the single GA Patient** and rewrites references to it. The source Patient identifiers (MRNs and similar) are added to `Patient.identifier`. **[call]**
- **The patient is chosen explicitly per import** (`--patient` defaults to the one patient). Nothing hard-codes "the patient", so family can be added later. Medplum Projects/compartments are left as they are. **[call]**
- **Provenance:** every imported resource carries `meta.source` (source file and type) and a `meta.tag` for the importer. LLM-extracted resources get an extra `extracted-by-llm` tag and a `derivedFrom` or Provenance link to the source DocumentReference. **[call]**

## 5. Deduplication (must-have)

The strategy is **conditional create on a stable identifier**: `POST` with `If-None-Exist: identifier=<system>|<value>`. The importer gives every resource a deterministic identifier before writing. Re-imports then become no-ops, and the design doesn't depend on how the server assigns IDs. **[call]**

| Source | Stable key → `identifier` | Notes |
|---|---|---|
| C-CDA | entry `<id root extension>` | **[check]** Does the same lab carry the same entry id across the 8 documents? If not, fall back to the content key. |
| EHI | `ORDER_PROC_ID`+`LINE` (results); each table's primary key otherwise | |
| Apple clinical-records | the source FHIR `id` plus the issuing server | These are copies of hospital FHIR resources. |
| Apple export.xml | hash of (type, start, end, value, sourceName) | |
| PDF / image (LLM) | content key | |
| SMART pull | source server base + resource id | |

**Cross-source dedup** (e.g. the same lab arriving via C-CDA, EHI and PDF): a content key such as (LOINC or normalized test name, effective date, value, unit) finds candidates.
- Exact match: keep one resource and add the second source to its identifiers/provenance.
- Uncertain match (same test and date but different value or unit, or the date matches to the day only): keep both and flag them with a `possible-duplicate` tag plus a link. The user or an agent reviews it. **[user: no silent merges; mechanics are a call]**

**Updates from newer sources [call]:** when an incoming resource matches an existing identifier and the source is newer (C-CDA document `effectiveTime`, EHI/SMART `meta.lastUpdated`, or the file date as a fallback), GA updates it. Medplum keeps the earlier version as history. Older-or-equal sources are a no-op. If the existing version was last changed by a person or agent rather than an importer (judged from `meta.tag`/author), GA doesn't overwrite it. It flags a `source-conflict` instead. Milestone-1 acceptance relies on this to report current meds and BP-med status correctly.

**[check]** Confirm whether Medplum supports `If-None-Exist` conditional create and conditional update. If it doesn't, the importer searches first and then creates.

## 6. Sources (from recon of the user's real files)

| Source | Location (outside repo) | Format | Milestone |
|---|---|---|---|
| Epic "Health Summary" | `<real-data-dir>/HealthSummary_<date>/IHE_XDM/*/DOC000{1-8}.XML` | C-CDA R2.1 (IHE XDM). 8 docs, all with labs, vitals, meds, problems, allergies, immunizations, social history. Overlap between them is heavy. | **1** |
| Outside lab PDF | `<real-data-dir>/<lab-report>.pdf` | 8 pages, text layer, no images. Probably a non-US checkup (guess). | **1** |
| Epic EHI export | `<real-data-dir>/<ehi-export-folder>/` | 5,531 TSV tables + schema HTML. The data is small (~85 result rows, ~60 encounters). Also RTF notes and PDF media. | 2 |
| Apple Health export | `<real-data-dir>/<apple-health-export>/` | `export.xml` is 2 GB, so it needs a streaming parser. `clinical-records/` has only 3 FHIR JSONs. Also ECGs and GPX routes. | 2 |
| SMART-on-FHIR pull | hospital portals | Patient standalone launch | 3 |

- **PDF/image importer: two modes [user].**
  - **Local agent (preferred, default):** the agent the user is already running (Claude Code, Codex, etc.) reads the document and calls `ga_import` with the extracted resources plus the original file. GA itself sends nothing anywhere. A short agent instruction file (skill/AGENTS.md) defines the extraction schema and the LOINC coding expectations. **[call]**
  - **API (supported):** `ga import file.pdf --llm api` calls the Claude API with the user's `ANTHROPIC_API_KEY`, using the same schema. This mode is opt-in only.
  - In both modes, the original is stored as a DocumentReference with a Binary, and the resources get the `extracted-by-llm` tag. Text comes from the text layer when there is one, otherwise from the model's vision.
- **EHI importer:** map only PATIENT, ORDER_RESULTS (+ORDER_PROC), ORDER_MED, PROBLEM_LIST, PAT_ENC, allergies, immunizations and vitals tables to FHIR. Attach RTF notes and media as DocumentReferences. **[call]**
- **Apple Health importer:** stream-parse the clinically relevant types (BP, heart rate, weight/BMI, glucose, SpO2, etc.) into vital-signs Observations. Clinical records go through the same dedup as a SMART pull. Workout routes are skipped for now. ECGs are optional. **[call]**

## 7. Sharing (later milestone)

- **Family:** a Medplum invite and login with an AccessPolicy (read-only by default), reached over Tailscale. **[check]** Do Medplum invites need SMTP? If so, the builder needs a fallback (e.g. a manual invite link).
- **Doctor share:** the user creates a share and picks the scope (resource types, date range, or everything) and an expiry.
  - GA issues an unguessable token URL served via Tailscale Funnel.
  - The URL opens a human-readable summary page, and the same token gives read-only FHIR API access, including `Patient/$everything` / Bulk-style export of the scoped data.
  - The user can revoke a share, and every access is logged (AuditEvent). **[call]**
  - The page is a small read-only view built with Medplum React components. **[call]**

## 8. Messaging (last milestone)

GA doesn't build its own chat bots. An existing open source agent gateway (Hermes Agent, OpenClaw or similar) is set up with GA's MCP server as a tool. **[check]** Which widely used gateway supports iMessage as well as Slack on macOS. **[call]**

## 9. Milestones

1. **Statin question.** Medplum via compose, the C-CDA importer with dedup, updates and patient collapse, the `ga_import` MCP tool, lab PDF import in local-agent mode, and Claude Code connected over MCP. API mode can follow later in milestone 1.
2. EHI importer and Apple Health importer, through the same dedup.
3. SMART-on-FHIR pull from hospital portals.
4. Sharing: family logins and doctor links with the readable view and FHIR export, plus Tailscale.
5. Messaging gateway.
6. Bundled single image, and an iOS app for Apple Health (the app comes later still).

## 10. Acceptance tests for milestone 1

Run against the real files at the paths above, from outside the repo.
1. `docker compose up` on a clean Mac gives a healthy Medplum at `localhost` with nothing bound to external interfaces.
2. Import the 8 C-CDAs and the PDF, record resource counts per type, import everything again, and confirm the counts haven't changed.
3. Exactly one Patient exists, and every resource references it.
4. Each of these inputs is present and traceable to a source file: age, sex, total cholesterol, HDL, LDL, systolic BP, BP-med status, diabetes status or A1c, smoking, eGFR, BMI. Items missing from the sources are reported as missing, not invented.
5. In Claude Code connected to GA, the atorvastatin question gets an answer with record citations, a risk score, and a list of missing inputs.
6. Importing an older C-CDA after a newer one doesn't revert any record.
7. Automated tests with synthetic fixtures only (no PHI) cover the dedup keys and patient collapse.

## 11. Left to the builder

- Process supervisor and layout for the bundled image. Medplum version pinning.
- Exact MCP server choice for the non-Claude agents, after the [check] items.
- LLM prompt and schema for the PDF extraction, and LOINC mapping approach.
- How the possible-duplicate review is surfaced (agent tool, CLI listing or UI).
- CLI ergonomics.
