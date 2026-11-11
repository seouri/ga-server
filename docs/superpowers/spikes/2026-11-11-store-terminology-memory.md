# Store terminology seed: memory (2026-11-11)

Store parity plan 2, Task 2, R11. Question: does seeding Medplum's five terminology bundles (`TERMINOLOGY_BUNDLE_FILES`, about 22 MB of JSON) keep ga-store, opened with every R4 type, under 220 MiB peak RSS?

## How it was measured

`src/store/test/terminology-memory.test.ts` runs `node --max-old-space-size=192 --import <exit hook> src/store/serve.ts --file <temp> ...` (all types, as ga-store runs but with every type) in a child process. It waits for `/healthz` to answer 200, which happens once the database is open and the seed is done, then sends SIGTERM. On exit, the hook prints `process.resourceUsage().maxRSS`, the kernel's peak RSS, in KiB on both Linux and macOS. The test starts the child twice:
1. on a fresh file, which seeds;
2. on the seeded file, which does not reseed: the floor without the seed.

## Results (macOS, Darwin 25.6, Node 26.13.0)

| Run | Peak RSS | Time to healthy |
| --- | --- | --- |
| Fresh file, seeds | 406 MiB | 3.99 s |
| Seeded file reopened, no seed | 292 MiB | 0.40 s |

- Seed: about 3.5-3.6 s in process, measured as Store open time with seed minus without.
- File: 23.7 MiB after the seed, against 0.13 MB for an empty store. It holds 29,875 `coding` rows and 11,789 `coding_property` rows.
- Lowering SQLite's page cache to 8 MiB during the seed changed the peak by about 6 MiB, so it was not kept.

## Verdict: R11 not met

- The floor alone is 292 MiB, which is already over the 220 MiB budget before any seeding. That floor is an all-types store: full R4 definitions, measured on macOS, where freed pages stay counted in RSS. The 2026-11-08 store-memory spike measured the full definitions at about +193 MB peak over a ~94 MB baseline on Linux, so roughly 287 MB, also over 220.
- The seed adds about 114 MiB on top of that floor, from parsing one bundle (up to 9 MB of JSON) plus the write transaction.
- Not measured on Linux: docker is out of scope for this task.
- GA's own store (`GA_STORE_TYPES`) has neither CodeSystem nor ValueSet, so it never seeds (R3), and this cost does not apply to GA today.
- The test asserts the 220 MiB budget and fails on this machine. The controller or owner rules on the budget for an all-types store.
