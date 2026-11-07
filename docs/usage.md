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

The stdio MCP server exposes `health_summary` (a one-call snapshot: age and sex, current lists, key labs, latest vitals, screenings and vaccines due, last visit, imported sources), `lab_results` (lab results as compact rows, filtered by test name and dates, newest first; `summary: true` gives one trend entry per test), `current_medications`, `current_problems` and `allergies` (active records, each marked current or unconfirmed by the hospital currency rule, with the reason), `vitals` (clinic and Apple Health readings marked home or clinic; Apple daily summaries with `daily: true`), `notes_search` (text search in clinical notes and MyChart messages, with snippets), `fhir_search`, `fhir_read`, `ga_import`, `whats_new` (what arrived since you last looked, with out-of-range labs, new medications and their FDA label sections, status changes and follow-ups; `markSeen: true` stores the time; CLI `ga whats-new [--since YYYY-MM-DD]`), `concepts_to_review` (source terms with no standard code) and `map_concept` (map one term to a validated code), `vaccine_gaps` (adult vaccination status against the CDC 2025 schedule), `health_maintenance` (screenings, vaccines and doctor-planned follow-ups with status, importance and the guideline's why and cost; CLI `ga maintenance [--as-of YYYY-MM-DD]`), `postpone` (not now, until a date, or dismiss an item) and `record_followup` (record a follow-up found in a note, after a preview and your yes), and `cardiovascular_risk_10yr` (PREVENT and Pooled Cohort Equations, tested against the preventr R package).

Codex, Hermes or any MCP client: register a stdio MCP server with command `node /absolute/path/to/ga-server/src/cli.ts mcp`, and point the agent at [AGENTS.md](../AGENTS.md) (PDF extraction rules, how to read GA's records) and `.claude/skills/<name>/SKILL.md` for the slash-command procedures.

## Import

```sh
ga import <folder>             # C-CDA export (folder of XML files); re-importing is a no-op
ga import /path/to/ehi-folder --tz America/New_York  # Epic EHI export; --tz = zone of the export's local times
ga import /path/to/apple_health_export  # unzipped Apple Health export folder (unzip export.zip first)

ga import file.pdf --llm api   # PDF/image via the Anthropic API (needs ANTHROPIC_API_KEY); once per file
```

An Epic EHI export brings encounters, problems, labs, medications, immunizations, vitals, social and family history, questionnaires, health maintenance, clinical notes (DocumentReference) and MyChart messages (Communication). The whole export is also archived as one DocumentReference. Re-importing the same export is a no-op. Without `--tz`, `GA_EHI_TZ` or this machine's zone is used.

An Apple Health export brings per-reading vitals, daily summaries (heart rate, steps, distance, activity rings), nightly sleep, ECGs, and the Health Records inside it (allergies, patient identifiers). The folder is archived as one DocumentReference; re-importing is a no-op, and a newer export updates the changed days.

`--llm api` sends the file to the Anthropic API. The default for PDFs is your own agent, so nothing leaves the machine except through the agent you already use: ask it "Import /path/to/file.pdf into GA." It reads the file and calls `ga_import` (see `.claude/skills/ga-import/extract.md`, also `/ga-import <file>` in Claude Code, and [AGENTS.md](../AGENTS.md)).

## Review flags and limits

- `possible-duplicate`: the same test on the same day with a different value, unit or time. Both are kept and point at each other (`urn:ga-server:ext:possible-duplicate-of`). Find them with `fhir_search` `{resourceType: "Observation", params: {_tag: "urn:ga-server:tag|possible-duplicate"}}`, or search `_tag=urn:ga-server:tag|possible-duplicate` in the app.
- `source-conflict`: a newer import differs from a record a person or agent changed; GA kept the existing record and never overwrites it. Same search with `source-conflict`.
- A PDF/image is imported once; importing the same file again is refused.
- Stale medications: a medication dropped from a newer list is not marked stopped. A portal-synced medication is current only if its `last-seen` matches its source's latest sync; otherwise, an `active` medication whose source date is older than the newest C-CDA or EHI import, or than the newest sync of a portal with medications enabled, is unconfirmed. A portal that syncs only labs never makes a medication, problem or allergy unconfirmed.
