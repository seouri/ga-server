# Store terminology seed: memory (2026-11-11)

Store parity plan 2, Task 2, R11. Question: does seeding Medplum's five terminology bundles (`TERMINOLOGY_BUNDLE_FILES`, about 22 MB of JSON) keep ga-store, opened with every R4 type, under 220 MiB peak RSS?

## How it was measured

`src/store/test/terminology-memory.test.ts` runs `node --max-old-space-size=192 --import <exit hook> src/store/serve.ts --file <temp> ...` (all types, as ga-store runs but with every type) in a child process. It waits for `/healthz` to answer 200, which happens once the database is open and the seed is done, then sends SIGTERM. On exit, the hook prints `process.resourceUsage().maxRSS`, the kernel's peak RSS, in KiB on both Linux and macOS. The test starts the child twice:
1. on a fresh file, which seeds;
2. on the seeded file, which does not reseed: the floor without the seed.

## Results (macOS, Darwin 25.6, Node 26.13.0)

| Run | Peak RSS | Time to healthy |
| --- | --- | --- |
| Fresh file, seeds | 354-361 MiB (4 runs alone); 400-406 MiB in the first runs (alongside other work) | 3.9-4.5 s |
| Seeded file reopened, no seed | 292 MiB (every run) | 0.39-0.40 s |
| **Increment (seed minus reopen)** | **62-69 MiB alone; 108-114 MiB worst seen** | |

- Seed time in process: about 3.5-3.6 s (Store open with the seed minus without).
- File: 23.7 MiB after the seed, against 0.13 MB for an empty store.
- Rows: 1108 CodeSystems and 1346 ValueSets as resources (2,454 `builtin` rows), 29,875 `coding` rows, 11,789 `coding_property` rows.
- Lowering SQLite's page cache to 8 MiB during the seed changed the peak by about 6 MiB, so it was not kept.
- Not measured on Linux (no docker for this task).

## Ruling (controller, 2026-11-11)

- The absolute 220 MiB budget (R11) applies to ga-store with GA's type set. That set has neither CodeSystem nor ValueSet, so it never seeds (R3).
- An all-types store is not held to 220 MiB. Its floor without any seed is already 292 MiB on macOS, and about 287 MB on Linux by the 2026-11-08 store-memory spike.
- The test therefore asserts the seed's increment, with the same child setup: peak RSS when seeding minus peak RSS when reopening the seeded file must be at most 128 MiB. It logs both absolute numbers.
