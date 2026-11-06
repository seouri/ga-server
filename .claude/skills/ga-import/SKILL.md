---
name: ga-import
description: Import health records into GA from a local file or folder - a PDF or photo of a lab report, a C-CDA (Epic Health Summary) folder, an Epic EHI export, or an Apple Health export. Use when asked to add, import or load a medical document or export into GA.
argument-hint: "<path to file or folder>"
allowed-tools: Read Bash(node src/cli.ts import:*) mcp__ga-server__ga_import mcp__ga-server__fhir_search mcp__ga-server__fhir_read
---

Import `$ARGUMENTS` into GA. If no path was given, ask for one. The path must exist on this machine.

- **PDF or image** (`.pdf`, `.png`, `.jpg`, `.jpeg`): read it yourself and call `ga_import`, following [extract.md](extract.md). GA never sends the file anywhere.
- **Anything else**: run `node src/cli.ts import <path>` from the repo root and relay its report (counts only). It detects the kind:
  - Epic EHI export (folder with `EHITables/`); add `--tz <IANA zone>` if the user names the site's time zone.
  - Apple Health export (folder with `export.xml`); an `export.zip` must be unzipped first.
  - C-CDA: a folder of Epic Health Summary XML files, or one XML file.

Re-importing is safe: GA deduplicates, and an unchanged source changes nothing. If the CLI fails with "GA is not running" or "run ga setup first", tell the user to run `docker compose up -d` or `node src/cli.ts setup`.
