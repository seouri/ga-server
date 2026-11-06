# GA server

A local Medplum FHIR server for one person's health records, with an MCP server so your agent can read it and import into it. Milestone 1 goal: an agent answers "Is starting Atorvastatin 40 mg the right decision?" from GA data.

## Setup (new Mac)

Prerequisites: Docker Desktop, Node 26 (runs the `.ts` sources directly).

```sh
npm install              # first: the ga-sync service runs this repo's code
docker compose up -d     # Medplum, Postgres, binary storage, C-CDA converter, daily portal sync
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

## Hospital portals (SMART)

GA can fetch your records from Epic patient portals (MyChart) by itself, over SMART on FHIR, with read-only access. You register GA once as your own app with Epic, then connect each hospital once; after that the `ga-sync` service fetches daily. Tokens are encrypted in `.ga/smart/`; nothing leaves the machine except requests to the hospitals' own servers.

### 1. Register the app with Epic (once)

```sh
ga keys      # creates GA's signing key (.ga/smart/, mode 0600) and prints the public JWKS and PEM
```

1. Create a free account at https://fhir.epic.com and choose Build Apps, then Create.
2. Application audience: **Patients**. Make it a **confidential client** (asymmetric key, `private_key_jwt`).
3. Incoming APIs: the **USCDI R4** read and search APIs (AllergyIntolerance, Condition, DiagnosticReport, DocumentReference, Binary, Encounter, Immunization, MedicationRequest, Observation, Patient, Procedure, and the rest you want). Read only; GA never writes.
4. Turn on **refresh tokens** (persistent access), so GA can fetch without you logging in each time.
5. Redirect URI: `http://localhost:8765/callback`.
6. Public key: paste the `ga keys` output, the JWKS or the PEM, whichever the form accepts. If it only takes a JWK Set URL, host `.ga/smart/public.jwks.json` at any public static URL: it is a public key, never health data.
7. Mark the app **ready for production** and note its **client ID**. Epic distributes it to organizations; that can take a while.

Unverified until a real registration goes through (record the answers here): the exact form fields, whether Epic accepts the `localhost` redirect for production, whether each organization must activate the app first, and whether Epic issues refresh tokens without the `openid` scope (GA requests only `offline_access launch/patient patient/*.read`).

**Fallback A (no refresh tokens).** If Epic issues no refresh token or caps access at about an hour, GA fetches only during `ga connect`: log in again whenever you want fresh data. Between logins the source shows `off`.

### 2. Connect each hospital

Find the hospital's FHIR R4 base URL in Epic's endpoint list (https://open.epic.com/MyApps/Endpoints), for example `https://fhir.example-hospital.org/api/FHIR/R4`.

```sh
ga connect https://fhir.example-hospital.org/api/FHIR/R4 --client-id <client ID> --name "Hospital A"
```

`--client-id` is needed only the first time. Your browser opens the MyChart login; choose the longest access duration offered. GA then runs a **dry run**: it fetches everything, prints per type how many records it fetched and how many would be created, linked to a record GA already holds, updated or flagged, and writes no records (only a status entry, so your agent knows the source is not enabled yet). Records from C-CDA or EHI imports are linked only where Epic shares an ID with the portal: if a type GA already holds from Epic shows `created`, those are likely duplicates of what you have, so leave that type disabled. Enable the types that link or are new to GA:

```sh
ga sync --enable Condition,Observation,MedicationRequest fhir-example-hospital-org
ga sync                 # fetch every connected source now (prints counts only)
ga sync --dry-run       # counts only, writes nothing
ga status               # per source: status, last success, STALE flag, enabled types
ga disconnect fhir-example-hospital-org   # deletes the tokens; records already fetched stay
```

A source's name for these commands is its key (the FHIR host with `-` for `.`, shown by `ga status`) or its `--name`. A source with no enabled types only ever dry-runs; `ga status` shows it `off (not_enabled)` until you enable types. Two syncs of one source never run at once: the second waits up to 30 seconds, then reports `busy` and changes nothing. After `ga disconnect`, `ga connect` reconnects it.

### 3. Daily sync

`docker compose up -d` also starts `ga-sync`, which runs `ga sync --daemon`: a sync at startup, then once 24 hours have passed (it checks hourly, so a sleeping Mac catches up on wake; an hour after a failed run), logging counts only (`docker compose logs ga-sync`). It runs as your user so files in `.ga/` stay yours; on Linux export your ids first (`UID=$(id -u) GID=$(id -g) docker compose up -d`, or put `UID` and `GID` in `.env`). Docker Desktop on macOS maps ownership itself.

### What syncs and what doesn't

Synced: every patient-scoped type the portal offers (problems, diagnoses, labs, vitals, medications, immunizations, allergies, procedures, encounters, reports, clinical notes and more). Records already in GA from C-CDA or EHI imports are linked, not copied; re-fetching unchanged data changes nothing.

Not synced: MyChart messages and some note types (they keep coming from EHI exports); Quest and LabCorp results not ordered through Epic; Apple Health (import its export); PDFs (`/ga-import`).

**Stale sources.** If a source is `off` (login needed), `error`, or not synced for over 48 hours, `ga status` marks it STALE and your agent says so in the first line of its answer. `off`: run `ga connect <url>`, except `off (not_enabled)`: enable types with `ga sync --enable <Type,...> <source>`. `error`: retried on the next run, or `ga sync` now.

**Troubleshooting `ga connect`.** The browser must reach http://localhost:8765/callback on this machine; GA listens on 127.0.0.1:8765 only. If a firewall blocks it, another process holds port 8765, or the browser resolves localhost to [::1] where something else listens, connect times out or errors but fails safely (the code is useless without GA's PKCE verifier and state). Fix: free port 8765 (lsof -i :8765), allow loopback, retry ga connect.

## Sharing

`ga share` makes a private link to a read-only view of part of your record, for a doctor or family. They open it in any browser; no app or account. The link is the key: anyone who has it can see what it shares until it expires or you revoke it.

| `--for` | Shows (`--scope`) | Expires (`--expires`) | Layout | Questions a day (`--questions`) |
|---|---|---|---|---|
| `doctor` (default) | labs, medications, problems, allergies, immunizations, vitals | 7 days | A (one page) | 20 |
| `family` | all | never | B (tabs) | 20 |

Groups for `--scope`: labs, vitals, medications, problems, allergies, immunizations, visits, notes, procedures, family, messages, apple, or `all`. `--since 12m|2y|YYYY-MM-DD` and `--until YYYY-MM-DD` limit dated events; active problems, medications and allergies show whatever their date. `--expires 7d|12h|YYYY-MM-DD|never` (a date means through the end of that day). Portal status entries, provenance, the access log and the full EHI and Apple Health archives are never shared.

```sh
ga share --for doctor --label "Dr. Kim"                 # link + QR code, scope and expiry
ga share --for family --label Mom --scope labs,vitals,medications --since 2y
ga shares                                               # id, label, audience, scope, expiry, status, last access, accesses
ga shares show <id>                                     # the link and QR again
ga revoke <id>                                          # works at once, no restart
ga share log [<id>]                                     # who opened what, when, from which IP; questions asked
ga share export <id> [--out dir]                        # <label>-summary.pdf and <label>-records.json (FHIR), mode 0600
```

**Turning on links.** `docker compose up -d` starts `ga-share`, which serves the links on `127.0.0.1:8110` only. Tailscale Funnel puts it on the internet over HTTPS:

1. In the Tailscale admin console, allow Funnel for your tailnet (Access controls: the `funnel` node attribute; Tailscale offers to add it the first time).
2. On the GA Mac: `tailscale funnel --bg 8110` (the macOS app's CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). `ga share` checks `tailscale funnel status` and prints this command if Funnel is off; it never turns Funnel on itself. `tailscale funnel reset` turns it off (and clears any other `tailscale serve` setup).

Links use your machine's Tailscale name (`https://<machine>.<tailnet>.ts.net/s/...`), so every recipient sees it; rename the machine in Tailscale if you mind. `GA_SHARE_URL` overrides the base URL.

**Links work only while the GA Mac is awake and online.** For a patient portal upload, an email attachment or anyone who needs it offline, use `ga share export` and send the files instead.

**Questions.** Recipients can ask Claude about what the link shows, answered from the shared records only. Put `ANTHROPIC_API_KEY=...` in `.env` (gitignored) and `docker compose up -d ga-share`; without it the page says questions are not set up. Cost cap: each link allows `--questions` questions a day (default 20), and each answer is bounded in turns and tokens. Questions are kept in the access log; answers are not.

**Log.** Every view, download and question is a local AuditEvent in Medplum (tag `urn:ga-server:share|<id>`), never shared. Share settings are in `.ga/share/shares.json`; link tokens are encrypted beside them.

**Troubleshooting.** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8110/` should print `404` (only `/s/<token>` routes exist); if it fails, `docker compose logs ga-share`. If `ga share log` shows the same IP for every visitor, Funnel is not passing the client IP in `X-Forwarded-For`: the failed-link rate limit then applies to everyone at once, so tell us.

## Review flags and limits

- `possible-duplicate`: the same test on the same day with a different value, unit or time. Both are kept and point at each other (`urn:ga-server:ext:possible-duplicate-of`). Find them with `fhir_search` `{resourceType: "Observation", params: {_tag: "urn:ga-server:tag|possible-duplicate"}}`, or search `_tag=urn:ga-server:tag|possible-duplicate` in the app.
- `source-conflict`: a newer import differs from a record a person or agent changed; GA kept the existing record and never overwrites it. Same search with `source-conflict`.
- A PDF/image is imported once; importing the same file again is refused.
- Stale medications: a medication dropped from a newer list is not marked stopped. A portal-synced medication is current only if its `last-seen` matches its source's latest sync; otherwise, an `active` medication whose source date is older than the newest Epic import is unconfirmed.

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

Docker named volumes `ga-postgres` and `ga-binary`. Config and credentials: `.ga/config.json` (gitignored). Portal keys, client ID, source list and encrypted tokens: `.ga/smart/`. Shares and their encrypted link tokens: `.ga/share/`. Ports bind to `127.0.0.1` only; nothing is exposed to the network unless you turn on Tailscale Funnel for share links (see Sharing).

## Admin app

The Medplum app runs at http://localhost:3000. Log in as `admin@example.com` with the `adminPassword` from `.ga/config.json`: `ga setup` replaces Medplum's seeded default with a random password and stores it there (mode 0600). Re-running setup reuses it. **Back up `.ga/config.json`**: it holds the only copy of the admin password and client secret, and losing it locks you out of the admin account.

## Security

The server accepts browser requests only from the app origin `http://localhost:3000` (`MEDPLUM_ALLOWED_ORIGINS`), so other web pages open in your browser can't call it. VM-context bots are disabled. Ports bind to `127.0.0.1`. Anyone who can read `.ga/config.json` has full access.
