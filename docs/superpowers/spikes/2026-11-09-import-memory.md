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

## After Task 3 (batched importer, heap cap 64 MB, real temp SQLite store)

The 3,650-day export is written in 146 batches of 500. Each 60-minute run was cut off by its time limit; a `skipThrough 101` run reads the whole file and writes batches 102–145, which covers the end-of-read state and the daily, sleep and tail batches.

| Run | Linux VmHWM (node:26.13.0-alpine) | macOS peak RSS (ps) | Peak heapUsed (sampled) |
|---|---|---|---|
| From batch 0, 60 min (batches written: 77 Linux, 83 macOS) | 206 MiB | 235 MiB (archive phase) | 41–43 MiB |
| Whole read + batches 102–145 | 257 MiB (tail writes; 185 at end of read) | 218 MiB | 41 MiB (34 at end of read) |

- The 64 MB heap cap holds for the whole read, with no out-of-memory error. The live heap is about 15–20 MiB while reading readings and about 33 MiB at the end of the read, which is 10 years of daily state plus the reading-key set.
- RSS sits far above `IMPORT_CHILD_RSS_MB = 86`. Two things cause it:
  - the empty-child baseline is 107 MiB;
  - V8's young generation and code space sit outside `--max-old-space-size` (heapTotal up to 93 MiB).
- The constants are unchanged; Task 5's worker-thread measurement decides them.
- Time: the engine's per-Observation `code`+`date` content-match search takes 81% of request time and slows from about 1.4 to about 75 ms per call as the store grows. Batch time goes from 13 s to 88 s, so a full 2 GB import still takes hours.

### Retained heap per year (fix round 1)

The synthetic export now writes sleep as watchOS 9+ does: one in-bed span and 35 stage segments a night (Core, Deep, Core, REM, Awake), about 1,570 Records a day. Below is the heap that the read keeps alive across the whole export (the `Readings` key set plus all `Daily` state). It is measured as heapUsed with both objects held minus heapUsed after they are released, each after a full GC, with heap cap 64 and America/New_York.

| Export | Before (sleep intervals with four strings each) | After (instants, shared offset/source/stage strings) |
|---|---|---|
| 365 days (10,220 asleep and 365 in-bed intervals, 5,110 reading keys) | 4.7 MiB | 2.6 MiB |
| 1,095 days | 14.7 MiB (4.9 MiB/yr) | 7.6 MiB (2.5 MiB/yr) |

At this rate, 10 years keep about 25 MiB live on top of the working set of a batch (15–20 MiB measured). The 2 GB runs above used the earlier four-segment sleep shape; they were not repeated for this change.

## Task 5: the import in a worker thread inside the gateway

Setup: a gateway stand-in loads `src/gateway/server.ts` and runs one `import_file` job (`startJob`, unzip, archive, batched import) in a worker with `resourceLimits` {old 64 MB, young as below}. Export: the 365-day synthetic export from `tests/fixtures-gen/apple.ts` (218 MB `export.xml`, 7 MB zip, 7,300 resources). Environment: `node:26.13.0-alpine`, store in a second container.
- The cgroup peak is from `docker stats` sampled about every second, as in the recon; idle it reads 104 MiB, like the real gateway.
- RssAnon and VmHWM are from `/proc/self/status`. VmHWM includes about 70 MiB of file-backed pages (the node binary and ICU), so it is not the container's figure.

| young MB | batch | cgroup peak (docker stats) | VmHWM | peak RssAnon | RssAnon before batch 0 | time |
|---|---|---|---|---|---|---|
| idle (no job) | - | 104 MiB | 169 | 99 | - | - |
| default | 900 | 247 | 353 | - | - | 187 s |
| 16 | 500 | 191 | 282 | - | - | 123 s |
| **8** | **500** | **174 / 175 (two runs)** | 249 / 272 | 170 | 153 | 119-158 s |
| 8 | 250 | 180 | 255 | 170 | 151 | 117 s |
| 16 | 250 | 196 | 273 | 187 | 163 | 117 s |

- Chosen: `IMPORT_WORKER_HEAP_MB = 64` and `IMPORT_WORKER_YOUNG_MB = 8`, with the Apple batch size kept at 500.
  - Whole gateway at its peak: 175 MiB, within 190.
  - The import's increment over the idle gateway: about 71 MiB, within `IMPORT_WORKER_RSS_MB = 86`.
- The young generation is what the cap was missing. V8's default young generation (semi-spaces) sits outside `maxOldGenerationSizeMb` and cost about 70 MiB here.
- Smaller batches did not help: 250 gave the same or more, because the per-batch working set is small next to the fixed costs.
- The peak by phase:
  - Most of the peak comes before the first batch is written: 153 of 170 MiB RssAnon, during the unzip, the streamed archive upload and the read.
  - Part of that is off-heap (zlib and tar buffers, streams), which `resourceLimits` does not cap.
  - The batches add about 17 MiB on top.
- The worker's own baseline is small next to a child process: the worker's isolate and modules sit inside the figures above, with no second node binary or second set of `@medplum/*` code.
- Not measured here: the 3,650-day (2 GB) export through the worker. The read's retained daily state grows about 2.5 MiB a year (see above), so expect about 20 MiB more at 10 years. Task 7's whole-server run is the gate (Ruling 7).
- Too-small caps: with `maxOldGenerationSizeMb: 2`, V8 aborts the whole process while creating the worker's isolate. That is a fatal error, not `ERR_WORKER_OUT_OF_MEMORY`. With 8 MB the worker runs out of memory cleanly while loading modules, and the gateway lives on (tested).

## Task 6: Epic EHI and C-CDA through the worker

Setup as in Task 5: the gateway stand-in (now `tests/import-memory-host.ts`) runs one `import_file` job on a zipped upload in a worker with
`resourceLimits` {old 64, young 8}, store in a second container, `node:26.13.0-alpine`. Exports: `tests/fixtures-gen/ehi.ts`, every
fixture table's rows times the factor (new ids, dates a day earlier per copy), each copy with a 60 KB RTF note (distinct text per copy),
a 30 KB plain-text note and a 15 KB RTF message. The zip is small (synthetic text compresses well); the unzipped bytes are below.

| Export | Importer | status | records | time | idle anon | peak anon (increment) | docker stats peak |
|---|---|---|---|---|---|---|---|
| factor 900, 102 MB (45 MB tables, 56 MB Rich Text; 2,700 notes, 1,800 messages) | before Task 6 (80207ab, one batch) | failed: out of memory, 3 attempts | - | 9 s | 96 | 226 | 201 |
| same | batched, 4 MB document batches | done | 27,904 created | 206 s | 97-102 | 183, 201, 203 | 192, 200, 182 |
| same | + 1 MB document batches | done | 27,904 | ~180 s | 98-99 | 192, 184 | 188, 192 |
| same | + reused read buffer, sparse rows (committed) | done | 27,904 | 181 s | 100 | 185 (85) | 183 |
| same, distinct notes (every Rich Text file stored) | committed | done | 28,803 | 184-198 s | 98-101 | 194 (96), 180 (79) | 187, 192 |
| factor 4500, 512 MB (224 MB tables, 281 MB Rich Text; 13,500 notes, 9,000 messages) | committed | done, 0 invalid | 139,504 created | 1,306 s | 99 | 221 (122) | 258 |

- The peak is always before the first batch is committed: after the archive upload, while the concept-learning pre-pass reads every
  record table and the first batch is linked. From there on the batches stay below it (notes and messages included).
- It grows with the export: anon 180-194 at 102 MB, 221 at 512 MB. Worker heap (V8 used, macOS) at the same point: 32 MB at 102 MB,
  43 MB at 512 MB; without the pre-pass 31 MB, but the records batches then reach 43-44 MB at 512 MB anyway (38 at 102 MB). The heap
  stays under the 64 MB cap (no out-of-memory at 512 MB); what grows is how far V8 lets it grow before collecting, plus the per-key
  indexes (O(visits, orders, doses, answer sets)) of the mapper in progress.
- Against the targets (Ruling 7): 102 MB is at the line (docker stats 183-192 vs 190; increment 79-96 vs 86); 512 MB is over
  (258 / 122). Task 7's whole-server run is the gate.
- Per document batch: 4 MB of JSON per batch put the notes phase at 55 MB used heap; 1 MB keeps it at about 33.
- One note: a single 5 MB RTF note imports (its text attachment is then rejected by the store as invalid, as before Task 6); a 10 MB
  one runs the worker out of memory (the RTF is read whole and converted to text and base64).

C-CDA (one document converted whole by the vendored converter, which builds the full tree): the largest fixture (`ccda-epic-style.xml`,
40 KB) imports. Synthetic Health Summaries (the fixture's entries repeated with new ids; dense entries only, so a narrative-heavy
document may fall at another size): 2.5 MB and 3.7 MB import (Linux 3.7 MB: anon 188, docker 192, 123 s); 4.9 MB, 6.1 MB and 49 MB
run the worker out of memory (Linux 4.9 MB confirmed). Converting 6 MB retains about 32 MB (18 MB tree, 14 MB bundle).
