---
name: ga-lipids
description: Visualize the user's lipid panels (total cholesterol, LDL, HDL, triglycerides) from GA over time as an HTML chart. Use when asked to chart, plot or show cholesterol, LDL, HDL or triglyceride trends.
argument-hint: "[since YYYY]"
allowed-tools: Bash(node .claude/skills/ga-lipids/build.ts:*)
---

Run this from the repo root, passing any date range the user gave:

```sh
node .claude/skills/ga-lipids/build.ts $ARGUMENTS
```

It reads GA directly, builds the chart from `template.html`, writes it to `/tmp/ga-reports/` (outside the repo, owner-only: it contains health data), opens it, and prints a short summary: panel count and date range, missing tests, AI-extracted panels, possible duplicates, statin markers and the file path.

Relay that summary in a few lines. Do not interpret the trend clinically unless asked; the chart is the deliverable.

If the command fails with "GA is not running" or "run ga setup first", tell the user to run `docker compose up -d` or `node src/cli.ts setup`.

How the script groups values (so you can explain the chart if asked): one panel per collection day; direct LDL (LOINC 18262-6) is preferred over calculated (13457-7), which is preferred over text-only LDL from PDFs; missing tests stay empty; only mg/dL results are charted, and others are counted as skipped; a statin start is marked only when the medication record names the drug.
