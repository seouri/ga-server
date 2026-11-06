# Adding a skill

Back to the [README](../README.md).

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
- **Mirror the skill for other agents.** Add a line to [AGENTS.md](../AGENTS.md) naming the skill and its folder, so Codex and Hermes can follow the same instructions.
- **Try it before committing.** Run `/<name>` in Claude Code against your own GA. Also check what it does with an empty record.

Add `disable-model-invocation: true` to the frontmatter if a skill should run only when typed.
