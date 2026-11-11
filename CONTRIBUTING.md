# Contributing

Thanks for helping. GA is a personal health record, so two rules come before anything else:

- **Never commit real health data**: no names, dates of birth, record numbers, hospital identifiers, file paths or results, in code, tests, fixtures, docs, issues or commit messages. Use synthetic records.
- **Tests never touch the live record.** Integration tests run in a separate Medplum project named `ga-test`, never in GA's own `Guardian Angel` project: `tests/integration/global-setup.ts` makes or reuses it once per run (your GA config is only read, for the Medplum address and admin password), points `GA_CONFIG` at a temp copy of its config for every test file, and empties it at the start and at the end of every run. Every file and every writing helper checks the project name first and refuses anything not named `ga-test*`. With `GA_STORE=sqlite` each file gets its own temp store instead.

## Development

Set up as in the [README](README.md) (`./setup.sh`). Node 26 runs the TypeScript sources directly in strip-only mode, so avoid TypeScript-only runtime syntax (parameter properties, enums, namespaces).

```sh
npm test                                     # unit tests (no Docker needed)
npm run typecheck
npm run test:int -- tests/integration/<file>.test.ts   # one file at a time; needs GA running
```

Integration tests run one file at a time because the FHIR server rate-limits logins; if you see HTTP 429, wait a minute. `GA_CONFIG` (or the checkout's `.ga/config.json`) must hold `baseUrl` and `adminPassword`, which the run uses to make the `ga-test` project. Because every run empties that project, run one integration run at a time on a machine: two at once (say from two checkouts) wipe each other's records mid-run. When several checkouts or agents share one GA, serialize runs with a lock (for example a `mkdir` lock around `npm run test:int`). CI runs the unit tests and the typecheck on every push and pull request.

## Where things are

- `src/`: CLI (`src/cli.ts`), MCP server (`src/mcp.ts`), the dedup engine (`src/engine.ts`), importers (`src/ccda.ts`, `src/ehi/`, `src/apple/`), portal sync (`src/smart/`) and sharing (`src/share/`).
- `.claude/skills/`: the `/ga` slash commands; see [docs/skills.md](docs/skills.md).
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: the design and plan behind each milestone. Read the relevant spec before changing behaviour.
- `AGENTS.md`: what agents need to know to read and write GA correctly. Update it when behaviour agents rely on changes.

## Pull requests

Keep changes small and focused, with a test for new logic, and prefer widely used open-source libraries over new code. Describe what changed and why. By contributing you agree your contribution is licensed under the [Apache License 2.0](LICENSE).
