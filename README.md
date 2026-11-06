# GA server

A local Medplum FHIR server for one person's health records, with an MCP server so your agent can read it and import into it. Milestone 1 goal: an agent answers "Is starting Atorvastatin 40 mg the right decision?" from GA data.

## Setup (new Mac)

Prerequisites: Docker Desktop, Node 26 (runs the `.ts` sources directly).

```sh
docker compose up -d     # Medplum, Postgres, binary storage, C-CDA converter
npm install
node src/cli.ts setup    # creates the patient and .ga/config.json, rotates the Medplum admin password
npm link                 # optional: puts `ga` on your PATH (examples below use it)
```

## Import

```sh
ga import <folder>             # C-CDA export (folder of XML files); re-importing is a no-op
ga import /path/to/ehi-folder --tz America/New_York  # Epic EHI export; --tz = zone of the export's local times
ga import /path/to/apple_health_export  # unzipped Apple Health export folder (unzip export.zip first)

ga import file.pdf --llm api   # PDF/image via the Anthropic API (needs ANTHROPIC_API_KEY); once per file
```

An Epic EHI export brings encounters, problems, labs, medications, immunizations, vitals, social and family history, questionnaires, health maintenance, clinical notes (DocumentReference) and MyChart messages (Communication). The whole export is also archived as one DocumentReference. Re-importing the same export is a no-op. Without `--tz`, `GA_EHI_TZ` or this machine's zone is used.

An Apple Health export brings per-reading vitals, daily summaries (heart rate, steps, distance, activity rings), nightly sleep, ECGs, and the Health Records inside it (allergies, patient identifiers). The folder is archived as one DocumentReference; re-importing is a no-op, and a newer export updates the changed days.

`--llm api` sends the file to the Anthropic API. The default for PDFs is your own agent, so nothing leaves the machine except through the agent you already use: ask it "Import /path/to/file.pdf into GA." It reads the file and calls `ga_import` (see `.claude/skills/ga-import/extract.md`, also `/ga-import <file>` in Claude Code, and `AGENTS.md`).

## Review flags and limits

- `possible-duplicate`: the same test on the same day with a different value, unit or time. Both are kept and point at each other (`urn:ga-server:ext:possible-duplicate-of`). Find them with `fhir_search` `{resourceType: "Observation", params: {_tag: "urn:ga-server:tag|possible-duplicate"}}`, or search `_tag=urn:ga-server:tag|possible-duplicate` in the app.
- `source-conflict`: a newer import differs from a record a person or agent changed; GA kept the existing record and never overwrites it. Same search with `source-conflict`.
- A PDF/image is imported once; importing the same file again is refused.
- Stale medications: a medication dropped from a newer C-CDA list is not marked stopped. An `active` MedicationStatement whose source date is older than the newest C-CDA import is unconfirmed.

## Connect an agent

The stdio MCP server exposes `fhir_search`, `fhir_read`, `ga_import`, `vaccine_gaps` (adult vaccination status against the CDC 2025 schedule) and `cardiovascular_risk_10yr` (PREVENT and Pooled Cohort Equations, tested against the preventr R package).

- Claude Code: open this repo; `.mcp.json` registers `ga-server`.
- Codex / Hermes: register a stdio MCP server with command `node /absolute/path/to/ga-server/src/cli.ts mcp`. Point the agent at `AGENTS.md` for the PDF extraction rules.

## Using GA in Claude Code

Start Claude Code in this repo and approve `ga-server` (check with `/mcp`). To use GA from any folder, register it once for your user:

```sh
claude mcp add --scope user ga-server -- node /absolute/path/to/ga-server/src/cli.ts mcp
```

The server tells Claude that GA is your health record, so plain questions work. Claude reads with `fhir_search`/`fhir_read` and cites the records it used.

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
> Is starting Atorvastatin 40 mg the right decision?
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

## Adding a skill

A skill is a repeatable report, visualization or workflow that the agent runs against GA. It adds no server code. Each skill is a folder in `.claude/skills/`, and Claude Code loads it for anyone who opens this repo. It runs when you type `/<name>`, or when your request matches its description.

```
.claude/skills/ga-lipids/
  SKILL.md          # instructions (required)
  template.html     # optional supporting files: templates, examples
```

`SKILL.md` starts with frontmatter, then plain instructions:

```markdown
---
name: ga-lipids
description: Visualize the user's lipid panels from GA over time. Use when asked about cholesterol, LDL, HDL or triglyceride trends.
argument-hint: "[since YYYY]"
allowed-tools: mcp__ga-server__fhir_search mcp__ga-server__fhir_read
---

1. Search GA Observations for total cholesterol (LOINC 2093-3), HDL (2085-9), triglycerides (2571-8)
   and LDL as calculated (13457-7), direct (18262-6) or text-only "LDL cholesterol". Limit to $ARGUMENTS if given.
2. Fill the data slot in template.html, save the page and open it.
3. Report which tests were found, which are missing, and which values were extracted by AI from PDFs.
```

Rules for skills in this repo:

- **Read data from GA every time.** Never put values in the skill or its templates. Each person who clones the repo sees only their own data.
- **No personal details:** no names, file paths, dates or results from anyone's record. Skills are committed and may be public.
- **Expect varied coding.** The same test can arrive with different LOINC codes, or as text only from a PDF. Search for every form, and say what was found and what's missing rather than guessing.
- **Cite records and keep GA's flags visible:** `possible-duplicate`, `extracted-by-llm`, and medications that may no longer be active.
- **Writes go through `ga_import` only,** so dedup applies.
- **Fast and exact: ship a script.** When a skill only moves data from GA into a page or file, put that in a script in the skill folder. It reads GA with `src/config.ts` (`loadConfig`, `getClient`), and `SKILL.md` just runs it and relays its summary. The data never passes through the model, so it's fast and can't be mistyped. See `.claude/skills/ga-lipids/build.ts`, tested in `tests/ga-lipids.test.ts`.
- **Exact math belongs in code, not skill instructions.** A risk score, for example, should be a tested MCP tool, and the skill calls it.
- **Mirror the skill for other agents.** Add a line to `AGENTS.md` naming the skill and its folder, so Codex and Hermes can follow the same instructions.
- **Try it before committing.** Run `/<name>` in Claude Code against your own GA. Also check what it does with an empty record.

Add `disable-model-invocation: true` to the frontmatter if a skill should run only when typed.

## Where data lives

Docker named volumes `ga-postgres` and `ga-binary`. Config and credentials: `.ga/config.json` (gitignored). Ports bind to `127.0.0.1` only; nothing is exposed to the network.

## Admin app

The Medplum app runs at http://localhost:3000. Log in as `admin@example.com` with the `adminPassword` from `.ga/config.json`: `ga setup` replaces Medplum's seeded default with a random password and stores it there (mode 0600). Re-running setup reuses it. **Back up `.ga/config.json`**: it holds the only copy of the admin password and client secret, and losing it locks you out of the admin account.

## Security

The server accepts browser requests only from the app origin `http://localhost:3000` (`MEDPLUM_ALLOWED_ORIGINS`), so other web pages open in your browser can't call it. VM-context bots are disabled. Ports bind to `127.0.0.1`. Anyone who can read `.ga/config.json` has full access.
