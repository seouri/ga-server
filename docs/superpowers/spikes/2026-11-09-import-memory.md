# Import memory: profile of today's importer (Apple Health, 2 GB)

Synthetic export from `tests/fixtures-gen/apple.ts`: 3,650 days, 5.7 M Records, 2.0 GB `export.xml`, 73,001 resources after aggregation.
Child `node src/cli.ts import <dir>` against a temp SQLite store served by the test process; macOS, Node 26.13 (Linux figure from `node:26.13.0-alpine`).
RSS sampled by `tests/memory.ts` (`ps -o rss=` every 200 ms); phases by a scratch copy of `importAppleHealth` logging `process.memoryUsage()` and the peak RSS within each phase.

## Peak per phase (3,650 days, uncapped)

| Phase | peak RSS in phase | RSS after | heapUsed after |
|---|---|---|---|
| start (modules loaded) | - | 66 MiB | 15 MiB |
| archive (`archiveFolder`) | 307 MiB | 307 MiB | 10 MiB (external 273, arrayBuffers 265) |
| read (`readExport` into Readings/Daily) | 580 MiB | 580 MiB | 320 MiB |
| build (`result()`, mapClinical, mapEcgs) | 826 MiB (1,153 on a second run with snapshots) | 826 MiB | 370 MiB |
| compare (`existing`, empty store) | 826 MiB | 535 MiB | 333 MiB |
| write (`importResources`, 73,001 resources) | about 934 MiB at its start, 129 MiB later | - | - |

Whole-run peak: 826 to 934 MiB (recon: about 950). The write phase is slow against the SQLite store (about 25 MB of db per 3 minutes; still running after 90 minutes, then killed), so a full 3,650-day run takes hours: `GA_BIG_IMPORT=1` is for a patient machine. The 60-day export (about 60 MB, 8 s) peaks at 392 MiB RSS, 365 days (218 MB, 7,301 resources, 112 s for two passes) at 284 MiB; a second import of the same 365 days finds all 7,300 unchanged (compare peak 238 MiB).

Heap caps on today's code (read phase, 3,650 days): `--max-old-space-size=128` out of memory after 117 s, 256 out of memory after 227 s (live 232 MiB and growing; the read phase alone needs about 320 MiB of heap). With the real harness, the 128 MiB run dies with exit -1 (OOM) at 408 MiB RSS, so the big test fails on the exit code, not on the RSS cap.

## Top retainers (heap snapshot, 3,650 days, after read and after build)

Self size by type: strings 272 MiB (269 after build) of 318 MiB; plain objects 23 MiB (33 after build); arrays 11 (14); `Array` objects 7 (9); hidden 4 (5); code 4.
So the retained heap is strings: 131,400 ISO date strings (6 MiB), and tens of thousands of sliced substrings of the XML chunks (the `e="2016-... -0500" ...` attribute runs of 60 KiB, `sourceName`/`device` text), i.e. record attribute values that keep their parent chunk alive, plus the Observation objects held in `Readings.out` and the per-day aggregates in `Daily`. At 365 days the live heap is 41 MiB (strings 36, of which about 12 are module source), so it grows with the export.
Outside the heap: the archive phase holds 265 MiB of ArrayBuffers (whole-file read before streaming), and build adds about 250 MiB of RSS over its heap (young generation and fragmentation).

## Baselines

- Bare `node`: 11 MiB RSS (macOS), 53 MiB (alpine Linux).
- Child with `src/import.ts`, `src/apple/import.ts` and `src/config.ts` loaded: 72 MiB RSS, 17 MiB heap (macOS); 107 MiB RSS (HWM 109), 20 MiB heap (alpine Linux Node 26.13).
- Gateway (`ga-server-ga-gateway-1`, `docker stats --no-stream`, read-only): idle 99 to 107 MiB over several samples. Busy: not measured (that needs load on the owner's running gateway, which this task must not touch).

## Constants

The 512 MB server budget is 190 MiB for gateway plus child. With the gateway at about 104 MiB idle the child gets 86 MiB, but an empty child with the importer loaded is already 107 MiB on Linux (72 MiB on macOS). The 190 MiB split cannot hold even for an empty child on the target OS, before any data. Controller to rule: options are cutting the child baseline (lazy-load the importer modules; the TypeScript stripping loader and `@medplum/*` are most of it), a leaner gateway, or a bigger budget.
Set meanwhile to the budget target: `IMPORT_CHILD_HEAP_MB = 64`, `IMPORT_CHILD_RSS_MB = 86` in `src/limits.ts`. Today's importer fails both by a wide margin.
