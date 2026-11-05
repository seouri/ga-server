# GA server

A local Medplum FHIR server for one person's health records, with an MCP server so your agent can read it and import into it. Milestone 1 goal: an agent answers "Is starting Atorvastatin 40 mg the right decision?" from GA data.

## Setup (new Mac)

Prerequisites: Docker Desktop, Node 26 (runs the `.ts` sources directly).

```sh
docker compose up -d     # Medplum, Postgres, binary storage, C-CDA converter
npm install
node src/cli.ts setup    # creates the patient and .ga/config.json
npm link                 # optional: puts `ga` on your PATH (examples below use it)
```

## Import

```sh
ga import <folder>             # C-CDA export (folder of XML files); re-importing is a no-op
ga import file.pdf --llm api   # PDF/image via the Anthropic API (needs ANTHROPIC_API_KEY)
```

`--llm api` sends the file to the Anthropic API. The default for PDFs is your own agent, so nothing leaves the machine except through the agent you already use: ask it "Import /path/to/file.pdf into GA." It reads the file and calls `ga_import` (see `skills/ga-extract/SKILL.md` and `AGENTS.md`).

## Connect an agent

The stdio MCP server exposes `fhir_search`, `fhir_read`, `ga_import`.

- Claude Code: open this repo; `.mcp.json` registers `ga-server`.
- Codex / Hermes: register a stdio MCP server with command `node /absolute/path/to/ga-server/src/cli.ts mcp`. Point the agent at `AGENTS.md` for the PDF extraction rules.

## Where data lives

Docker named volumes `ga-postgres` and `ga-binary`. Config and credentials: `.ga/config.json` (gitignored). Ports bind to `127.0.0.1` only; nothing is exposed to the network.

## Security

The default Medplum admin password is a setup shortcut. Change it before sharing the machine or exposing any port.
