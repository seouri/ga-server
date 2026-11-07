# GA (Guardian Angel)

[![test](https://github.com/seouri/ga-server/actions/workflows/test.yml/badge.svg)](https://github.com/seouri/ga-server/actions/workflows/test.yml) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) ![Node 26](https://img.shields.io/badge/node-26-339933.svg)

**All of your health records in one place, on your own computer, for your AI agent.** GA keeps one person's records in a local FHIR server and lets Claude Code, or any MCP agent, read them, import into them and share them. Hospital portals, Epic exports, Apple Health and lab PDFs land in one deduplicated record.

GA is a working implementation of [Guardian Angel](https://guardian.ga.org): the patient's own decision-making layer on top of the health record, which the EHR itself cannot become.

> **Not medical advice.** GA is not a medical device. Answers support a conversation with your clinician; they don't replace one. See [TERMS.md](TERMS.md).

## Quick start

You need [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/), [Node 26](https://nodejs.org/en/download) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup).

```sh
git clone https://github.com/seouri/ga-server.git && cd ga-server
./setup.sh      # checks Docker and Node, installs, starts GA, creates your record
claude          # start Claude Code in this folder; approve the ga-server MCP server once
```

Then bring in your records and ask, in plain words:

```
> /ga-import ~/Downloads/apple_health_export
> What were my last three LDL results, and where did each come from?
> Anything due for my health?
> Share my labs from the last 2 years with Dr. Kim for a week.
```

## What GA does

- **One record from every source:** Epic patient portals (MyChart, synced daily), Epic and C-CDA exports, Apple Health, and lab PDFs or photos, with duplicates caught and the same test under different names counted as one ([one test, one name](docs/concepts.md)).
- **Answers with citations:** labs and trends, current medications and problems, vitals, notes and messages, each value with its date and source.
- **What's new:** what arrived since you last looked, from out-of-range labs to new medications with their FDA label.
- **What's due:** screenings and vaccines against USPSTF and CDC guidelines, with the reasons, shown next to your doctor's own plan; follow-ups your doctor wrote in a note or message; a "By the way" reminder in chat and a calendar feed of due dates.
- **Decision support:** 10-year cardiovascular risk (PREVENT and Pooled Cohort Equations) and charts such as your lipid trend.
- **Sharing:** private, expiring links for a doctor or family, approved by you.
- **Your choice of AI:** Claude Code, or claude.ai, ChatGPT, Gemini and Grok over the internet.

More examples: [Using GA](docs/usage.md).

Use GA from claude.ai, ChatGPT, Gemini or Grok: see [docs/chat-apps.md](docs/chat-apps.md). Share links, chat apps and hospital portal logins also need [Tailscale](https://tailscale.com/download) (free for personal use) to reach GA over the internet.

## How it works

```mermaid
flowchart LR
  you([You]) --> agent["Claude Code or any MCP agent<br/>/ga, /ga-import, /ga-lipids"]
  agent -- "stdio MCP: health_summary, lab_results, vitals, current meds/problems/allergies,<br/>notes_search, fhir_search, ga_import, whats_new, health_maintenance, cardiovascular risk" --> mcp["ga mcp"]
  apps(["claude.ai, ChatGPT,<br/>Gemini, Grok"]) -- "Tailscale Funnel, /mcp" --> gateway
  agent -- "runs CLI: ga import, ga share" --> cli["ga CLI"]
  mcp --> fhir[("FHIR server<br/>Docker, local Postgres")]
  cli -- "dedup engine" --> fhir
  files["C-CDA, Epic EHI,<br/>Apple Health, PDFs"] --> cli
  epic["Epic portals<br/>(SMART on FHIR, read-only)"] -- "daily" --> sync["ga-sync"] --> fhir
  fhir --> gateway["ga-gateway<br/>127.0.0.1:8110"] -- "Tailscale Funnel" --> people(["Doctors, family,<br/>your calendar"])
```

Everything runs on your computer. It talks only to your own hospitals (to fetch your records), and your records leave it only to the people you share a link with and to your own AI provider (the agent or chat app you connect, and share-link questions if you turn them on). The agent never talks to the FHIR server directly: it goes through GA's MCP tools and CLI, which add provenance, deduplication and scope checks.

## Documentation

| Guide | What's in it |
|---|---|
| [Using GA](docs/usage.md) | Slash commands and example prompts, other MCP agents, importing C-CDA, Epic EHI, Apple Health and PDFs, review flags |
| [Hospital portals](docs/hospital-portals.md) | Connecting Epic patient portals (MyChart) for daily automatic sync |
| [Registering GA with Epic](docs/epic-setup.md) | One-time Epic app registration, field by field |
| [GA from chat apps](docs/chat-apps.md) | Setup for claude.ai, ChatGPT, Gemini, Grok and remote Claude Code |
| [One test, one name](docs/concepts.md) | How GA links the same test, vaccine or drug across sources under standard codes, and how to review what it mapped |
| [Sharing](docs/sharing.md) | Private links for doctors and family: summary, PDF and FHIR downloads, questions |
| [Running GA](docs/operations.md) | Where data lives, **backup and restore**, uninstall, admin app |
| [Adding a skill](docs/skills.md) | Writing your own `/` command against GA |
| [AGENTS.md](AGENTS.md) | What an agent needs to know to read and write GA correctly |

## Status and limits

Early, and built for one person's own use. One patient per install. Runs on macOS; Linux should work (Docker plus Node 26) but is less tested. Hospital sync is tested with Epic only. Share links and daily sync work only while the computer running GA is awake and online.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) (never commit real health data), and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Use is also subject to [TERMS.md](TERMS.md).
