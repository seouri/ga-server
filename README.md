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
ga import file.pdf --llm api   # PDF/image via the Anthropic API (needs ANTHROPIC_API_KEY); once per file
```

`--llm api` sends the file to the Anthropic API. The default for PDFs is your own agent, so nothing leaves the machine except through the agent you already use: ask it "Import /path/to/file.pdf into GA." It reads the file and calls `ga_import` (see `skills/ga-extract/SKILL.md` and `AGENTS.md`).

## Review flags and limits

- `possible-duplicate`: the same test on the same day with a different value, unit or time. Both are kept and point at each other (`urn:ga-server:ext:possible-duplicate-of`). Find them with `fhir_search` `{resourceType: "Observation", params: {_tag: "urn:ga-server:tag|possible-duplicate"}}`, or search `_tag=urn:ga-server:tag|possible-duplicate` in the app.
- `source-conflict`: a newer import differs from a record a person or agent changed; GA kept the existing record and never overwrites it. Same search with `source-conflict`.
- A PDF/image is imported once; importing the same file again is refused.
- Stale medications: a medication dropped from a newer C-CDA list is not marked stopped. An `active` MedicationStatement whose source date is older than the newest C-CDA import is unconfirmed.

## Connect an agent

The stdio MCP server exposes `fhir_search`, `fhir_read`, `ga_import`.

- Claude Code: open this repo; `.mcp.json` registers `ga-server`.
- Codex / Hermes: register a stdio MCP server with command `node /absolute/path/to/ga-server/src/cli.ts mcp`. Point the agent at `AGENTS.md` for the PDF extraction rules.

## Where data lives

Docker named volumes `ga-postgres` and `ga-binary`. Config and credentials: `.ga/config.json` (gitignored). Ports bind to `127.0.0.1` only; nothing is exposed to the network.

## Admin app

The Medplum app runs at http://localhost:3000. Log in as `admin@example.com` with the `adminPassword` from `.ga/config.json`: `ga setup` replaces Medplum's seeded default with a random password and stores it there (mode 0600). Re-running setup reuses it. **Back up `.ga/config.json`**: it holds the only copy of the admin password and client secret, and losing it locks you out of the admin account.

## Security

The server accepts browser requests only from the app origin `http://localhost:3000` (`MEDPLUM_ALLOWED_ORIGINS`), so other web pages open in your browser can't call it. VM-context bots are disabled. Ports bind to `127.0.0.1`. Anyone who can read `.ga/config.json` has full access.
