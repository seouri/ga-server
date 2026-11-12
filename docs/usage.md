# Using GA

Back to the [README](../README.md).

## Claude Code

**Start Claude Code in this repo** (`cd ga-server && claude`) and approve `ga-server` when asked (check with `/mcp`). That's all: the repo's `.mcp.json` registers GA's MCP server, and its slash commands come with it.

To use GA from any folder instead, register it once for your user:

```sh
claude mcp add --scope user ga-server -- node /absolute/path/to/ga-server/src/cli.ts mcp
```

The server tells Claude that GA is your health record, so plain questions work. Claude starts with `health_summary` (a one-call snapshot), reads lab results with `lab_results`, medications, problems and allergies with `current_medications`, `current_problems` and `allergies`, vital signs with `vitals`, note and message text with `notes_search`, and everything else with `fhir_search`/`fhir_read`, and cites the records it used.

**Slash commands** (shipped in `.claude/skills/`; anyone who clones the repo gets them):

| Command | What it does |
|---|---|
| `/ga <question>` | Answers strictly from GA, citing each record's date, value and source file. Says so when GA has nothing. |
| `/ga-import <path>` | Imports a file or folder, like `ga import`. Claude reads a PDF or photo itself; C-CDA, Epic EHI and Apple Health exports go through the CLI. |
| `/ga-lipids [since YYYY]` | Charts total cholesterol, LDL, HDL and triglycerides over time as a local HTML page. |

```
> /ga Is starting Atorvastatin 40 mg the right decision?
> /ga Did I miss any vaccinations for my age?
> /ga How are my diabetes-related labs?
> /ga How have my weight and resting heart rate changed since 2022, and how does that line up with my A1c?
> /ga-import ~/Downloads/vaccination-record.pdf
> /ga-import ~/Downloads/apple_health_export
> /ga-lipids since 2019
```

**Ask about your health**

```
> How is my liver function over time? Any concerns?
> What were my last three LDL results, and where did each come from?
> List my active medications and problems.
> Did my blood pressure change after I lost weight?
```

**Stay on top of your health**

```
> Anything due for my health?
> What's new in my record since I last looked?
> What's due in the next 6 months?
> Not now for the colorectal screening; remind me after March.
> I had a colonoscopy in 2024; mark colorectal screening done.
> Record the lipid recheck my doctor asked for in her Nov 3 message.
```

`health_maintenance` lists screenings (USPSTF) and vaccines (CDC) with the guideline's reasons and source, and your doctor's own plan (Epic health maintenance, or a follow-up recorded from a note or message) next to it. `whats_new` shows what arrived since you last looked: out-of-range labs, new medications with their FDA label, status changes, new notes and messages. After answering a health question the agent may add one "By the way" line about the most important item due. `postpone` with `done` records that you already had a screening (give at least the year it was done, YYYY, YYYY-MM or YYYY-MM-DD, in the past; not for vaccines, import the record). GA can also text you alerts and replies ([GA texts you](notifications.md)). `ga calendar` gives a private calendar link of the due dates ([chat apps](chat-apps.md#calendar-feed)).

**Import documents**

```
> Import /path/to/checkup-2024.pdf into GA.
> Import ~/Downloads/HealthSummary_<date> into GA.
```

Claude reads the PDF or photo itself and saves the results with `ga_import`. GA stores the original file and links every extracted record to it. For a folder of C-CDA XML files, Claude runs the CLI (`node src/cli.ts import <folder>`, or `ga import` after `npm link`). The MCP tools can't import C-CDA themselves.

**Review and tidy**

```
> Show records tagged possible-duplicate and explain each pair.
> Which records were extracted by AI, and from which files?
> Is any active medication older than my newest Epic import?
```

**Visualize**

```
> Show me a nice visualization of my lipid profile over time.
> Chart my weight and BMI since 2019.
```

Claude builds a local HTML page from GA data and opens it in your browser.

Answers support a conversation with your clinician; they don't replace one.

### Other agents

`ga perf [--days N]` (default 7) prints per-tool calls, median and p95 time, average Medplum requests and error rate from `.ga/perf.jsonl`, plus texted-reply timing; the log holds no arguments or record content.

The stdio MCP server exposes `health_summary` (a one-call snapshot: age and sex, current lists, key labs, latest vitals, screenings and vaccines due, last visit, imported sources), `lab_results` (lab results as compact rows, filtered by test name (or a list of up to 10 names) and dates, newest first; `summary: true` gives one trend entry per test), `current_medications`, `current_problems` and `allergies` (active records, each marked current or unconfirmed by the hospital currency rule, with the reason), `vitals` (clinic, Apple Health and document readings marked clinic, home or unknown (a PDF does not say where it was taken); a systolic and diastolic taken together form one blood pressure row; the same reading from a document and another source is one row; Apple daily summaries with `daily: true`), `notes_search` (text search in clinical notes and MyChart messages, with snippets), `fhir_search`, `fhir_read` (`ids` reads up to 20 of one type in one call), `ga_import`, `whats_new` (what arrived since you last looked, with out-of-range labs, new medications and their FDA label sections, status changes, new notes and messages, and follow-ups; `markSeen: true` stores the time; CLI `ga whats-new [--since YYYY-MM-DD]`), `concepts_to_review` (source terms with no standard code) and `map_concept` (map one term to a validated code), `vaccine_gaps` (adult vaccination status against the CDC 2025 schedule), `health_maintenance` (screenings, vaccines and doctor-planned follow-ups with status, importance and the guideline's why and cost; CLI `ga maintenance [--as-of YYYY-MM-DD]`), `postpone` (not now, until a date, or dismiss an item) and `record_followup` (record a follow-up found in a note or MyChart message, after a preview and your yes), `cardiovascular_risk_10yr` (PREVENT 10- and 30-year ASCVD, total CVD and heart failure, with the HbA1c, UACR or full model when those are given, and Pooled Cohort Equations, tested against the preventr R package), and `liver_fibrosis_risk` (FIB-4 and NAFLD Fibrosis Score with their bands and citations).

Codex, Hermes or any MCP client: register a stdio MCP server with command `node /absolute/path/to/ga-server/src/cli.ts mcp`, and point the agent at [AGENTS.md](../AGENTS.md) (PDF extraction rules, how to read GA's records) and `.claude/skills/<name>/SKILL.md` for the slash-command procedures.

## Import

C-CDA converts inside GA (a patched copy of Medplum's converter in `vendor/medplum-ccda`); no extra service. Sections and entries GA could not convert are listed in the import report's `notImported`. Until November 2026 Microsoft's FHIR converter ran as a container for this; a config that still names it (`converterUrl`, `ccdaConverter`) works unchanged. After updating, run `docker compose up -d --remove-orphans` once to remove the old converter container.

```sh
ga import <folder>             # C-CDA export (folder of XML files); re-importing is a no-op
ga import /path/to/ehi-folder --tz America/New_York  # Epic EHI export; --tz = zone of the export's local times
ga import /path/to/apple_health_export  # unzipped Apple Health export folder (unzip export.zip first)

ga import file.pdf --llm api   # PDF/image via the Anthropic API (needs ANTHROPIC_API_KEY); once per file
```

An Epic EHI export brings encounters, problems, labs, medications, immunizations, vitals, social and family history, questionnaires, health maintenance, clinical notes (DocumentReference) and MyChart messages (Communication). The whole export is also archived as one DocumentReference. Re-importing the same export is a no-op. Without `--tz`, `GA_EHI_TZ` or this machine's zone is used.

An Apple Health export brings per-reading vitals, daily summaries (heart rate, steps, distance, activity rings), nightly sleep, ECGs, and the Health Records inside it (allergies, patient identifiers). The folder is archived as one DocumentReference; re-importing is a no-op, also when a later export writes the same times in another UTC offset, and a newer export updates the changed days.

Known limit (rare, not fixed): Health Records are identified by their hospital's host, like a portal sync. When two hospitals share one FHIR host (two tenants), the first FHIR base in sorted order gets the plain host key and the other a hashed key. A later export that adds or drops a tenant on that host can shift which tenant holds the plain key, and a portal sync (`ga connect`) of either tenant always uses the plain host key.

`--llm api` sends the file to the Anthropic API. The default for PDFs is your own agent, so nothing leaves the machine except through the agent you already use: ask it "Import /path/to/file.pdf into GA." It reads the file and calls `ga_import` (see `.claude/skills/ga-import/extract.md`, also `/ga-import <file>` in Claude Code, and [AGENTS.md](../AGENTS.md)).

GA looks up codes for new terms by searching the standard vocabularies, which sends the term's name (not values) to the National Library of Medicine and HL7's tx.fhir.org. `ga setup` writes `"terminologyLookup": true` into `.ga/config.json` and says so; to stop the search and the automatic mapping, set it to `false` (a later `ga setup` keeps your choice); `ga migrate` never maps automatically either way. See [concepts.md](concepts.md).

## Review flags and limits

- `possible-duplicate`: the same test on the same day, at the same moment with a different value, at another time with the same number (two sources' times for one result), or with no time of day on one side. Both are kept and point at each other (`urn:ga-server:ext:possible-duplicate-of`). Find them with `fhir_search` `{resourceType: "Observation", params: {_tag: "urn:ga-server:tag|possible-duplicate"}}`, or search `_tag=urn:ga-server:tag|possible-duplicate` in the app.
- `source-conflict`: a newer import differs from a record a person or agent changed; GA kept the existing record and never overwrites it. Same search with `source-conflict`.
- `person-edited`: set by older GA versions on a record a person had changed in the Medplum app. GA no longer sets it (records are told apart by GA's writer tags), but it keeps protecting such a record: a later source that differs adds `source-conflict`.
- A PDF/image is imported once: once a record extracted from it is in GA, importing the same file again is refused. A failed import that wrote no record can be retried; one that failed after writing some records is refused too, naming the stored document whose citing records must be deleted first.
- Stale medications: a medication dropped from a newer list is not marked stopped. A portal-synced medication is current only if its `last-seen` is at or after its source's latest successful sync (linked to several portals: the newest of their latest syncs; a portal that never synced, or no longer syncs that record type, has no say, and with none left it is unconfirmed); otherwise, an `active` medication whose source date is older than the newest C-CDA or EHI import, or than the newest sync of a portal with medications enabled, is unconfirmed. A portal that syncs only labs never makes a medication, problem or allergy unconfirmed.
