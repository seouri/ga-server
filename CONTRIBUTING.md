# Contributing

Thanks for helping. GA is a personal health record, so two rules come before anything else:

- **Never commit real health data**: no names, dates of birth, record numbers, hospital identifiers, file paths or results, in code, tests, fixtures, docs, issues or commit messages. Use synthetic records.
- **Tests never touch a real patient.** Integration tests create their own throwaway patient (`tests/integration/helpers.ts`).

## Development

Set up as in the [README](README.md) (`./setup.sh`). Node 26 runs the TypeScript sources directly in strip-only mode, so avoid TypeScript-only runtime syntax (parameter properties, enums, namespaces).

```sh
npm test                                     # unit tests (no Docker needed)
npm run typecheck
npm run test:int -- tests/integration/<file>.test.ts   # one file at a time; needs GA running
```

Integration tests run one file at a time because the FHIR server rate-limits logins; if you see HTTP 429, wait a minute. CI runs the unit tests and the typecheck on every push and pull request.

## Where things are

- `src/`: CLI (`src/cli.ts`), MCP server (`src/mcp.ts`), the dedup engine (`src/engine.ts`), importers (`src/ccda.ts`, `src/ehi/`, `src/apple/`), portal sync (`src/smart/`) and sharing (`src/share/`).
- `.claude/skills/`: the `/ga` slash commands; see [docs/skills.md](docs/skills.md).
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: the design and plan behind each milestone. Read the relevant spec before changing behaviour.
- `AGENTS.md`: what agents need to know to read and write GA correctly. Update it when behaviour agents rely on changes.

## Pull requests

Keep changes small and focused, with a test for new logic, and prefer widely used open-source libraries over new code. Describe what changed and why. By contributing you agree your contribution is licensed under the [Apache License 2.0](LICENSE).
