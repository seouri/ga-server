# Store $graphql: memory (2026-11-11)

Store parity plan 3, Task 2, R7. Question: does building the GraphQL schema on the first `$graphql` request keep the store within its budgets: at most 128 MiB of RSS growth on an all-types store, and at most 220 MiB total for ga-store (GA's types)?

Scope measured: Task 2's schema (read by id and search fields for each type, the output types of every reachable FHIR type). Reverse lookups, the Connection API, `resource` on Reference and list-field arguments (Task 3) and input types (Task 4) are not in it yet. Task 3 and 4 rerun both tests.

## How it was measured

Each test runs the store in a child process with `--expose-gc` and an `--import` hook. On SIGUSR2, the hook runs a full GC and prints `process.memoryUsage()` (RSS and V8 heap used). The test reads that line once before and once after one request, `{ PatientList(_count: 1) { id } }`. Reading after a full GC gives the steady state. Without the GC, start-up garbage (the R4 definitions parse) dominates RSS: `ps` RSS before the request ran 260-330 MiB and fell, or did not move, after it.

- `src/store/test/graphql-memory.test.ts`: `serveStore` with every R4 type and `terminology: []`, on a fresh file. Asserts that RSS after minus RSS before is at most 128 MiB.
- `tests/store-graphql-memory.test.ts`: `node --max-old-space-size=192 src/store-serve.ts`, as compose runs ga-store (GA's types, which include neither CodeSystem nor ValueSet, so nothing seeds), on a fresh file. Asserts that RSS after is at most 220 MiB, on Linux only. That follows `tests/ehi-memory.test.ts`: the budget is the Linux container's, and macOS keeps more in RSS. On other platforms the test prints the figures without asserting.

Linux numbers come from the same steps in `node:26.13.0-alpine` (docker, worktree mounted read only), run from a scratch script because vitest's native binaries in `node_modules` are macOS builds.

## Results (3 runs each; medians in bold)

| Store | Platform | RSS before → after (MiB) | V8 heap before → after (MiB) |
| --- | --- | --- | --- |
| All types, growth | Linux (alpine, Node 26.13.0) | 198→203, 197→202, 203→209: **+5** (cap 128) | 26 → 32 |
| All types, growth | macOS (Darwin 25.6, Node 26.13.0) | 234→245, 269→270, 269→270: **+1** (cap 128) | 26 → 32 |
| GA's types, total | Linux (alpine, Node 26.13.0) | 164→167, 178→179, 165→168: **168** (cap 220) | 22 → 25 |
| GA's types, total | macOS (Darwin 25.6, Node 26.13.0) | 235→238, 232→235, 233→236: **236** (printed only) | 22 → 25 |

- The schema costs about 6 MiB of heap with every R4 type and 3 MiB with GA's types.
- Both caps hold where they apply.
- On macOS, ga-store already sits at 232-235 MiB before any `$graphql` request. That is above 220 MiB, without GraphQL. It is the platform's accounting: the same process on Linux holds 164-178 MiB.
