# Gate: GA on the SQLite store (2026-11-08)

Task 9 of the SQLite store plan. It covers the integration suite on both stores, memory and speed on synthetic data and on a read-only copy of the owner's record, a large Apple Health import, and the `ga migrate-store` dry run on the owner's record. This file holds counts and timings only. The scripts lived in a temp dir and are not committed.

## Verdict

| Goal | Result |
|---|---|
| Speed (Medplum medians on the owner's record: `health_summary` 165 ms, `vitals` 72 ms, `whats_new` 2.0 s) | **Pass** on the copy of the owner's record: 109 ms, 18 ms, 1.70 s. On synthetic data, `health_summary` misses even the 1.5× fallback (247 ms): 389 ms, 446 ms in one process. The synthetic record has a lab-heavy shape: 4,960 lab results (20 tests × 124 dates × 2 sources) behind its 389k index rows. Size alone isn't the cause, since the owner's record had more index rows (689k, memory spike). So the goal is measured on the owner's copy, but `health_summary` slows as lab history grows. |
| 512 MB for GA (store + gateway + sync), normal use | **Pass, narrowly.** ga-store, gateway, sync and a separate tools process all ran inside a 512 MB container with no OOM. Peak anonymous memory was 477 MB on the owner's copy, and that figure includes one process more than the deployment has. |
| 512 MB during a large Apple Health import (Review Focus 4) | **Fail.** The `ga import` process ran out of heap in 512 MB. With a 1 GB heap it peaked at 724 MB. The store process stayed at 261 MB or less. |
| Real-record dry run (`ga migrate-store`) | **Would switch** (fix round 1, with two narrow gate rules). Gate passes with 0 problems. 8 C-CDA compartment differences and 1 `date=eq` replay row are allowed and listed. Nothing was switched (no `--yes`). |

## Integration suite

| Store | Files | Tests |
|---|---|---|
| SQLite (`GA_STORE=sqlite npm run test:int`) | 16 passed, 4 skipped | 146 passed, 7 skipped |
| Medplum (`GA_CONFIG=<live install> npm run test:int`, throwaway ga-test projects) | 18 passed, 2 skipped | 148 passed, 5 skipped |

Skipped on both: `real-data` and `smart-sandbox` (they need env vars). Skipped on SQLite only: `migrate` (moves an install between Medplum projects) and `migrate-store` (Medplum is the source; the Medplum run covers it).

How the suite runs on the store: `tests/integration/store-setup.ts` (a vitest `setupFiles` entry) gives each file its own temp store, served by a child process on a free port, plus a temp config, its token, and a self Patient made by `ga setup`. The child exits with the test worker. The live install's config and token are never read. `testProject()` is that store, `emptyTestProject()` empties only that store, and there are no logins or ga-test projects.

Product fixes:
- The store answers `POST <type>/$validate`. `ga_import` validates a batch before storing the file and failed on the store with "POST not allowed".
- The store deletes Binaries (`DELETE Binary/<id>`).
- The migrate-store replay compares date sort keys as instants. On the owner's record, both servers order `-date` by instant and by a Period's start. Two kinds of tie were classed as unexplained: one instant written with two offsets, and two Periods with the same start. These ties are the spec's allowed "order among equal sort keys". Fixing this took the unexplained replay rows from 4 to 1.

Test changes, each for a Medplum-only behaviour the spec drops or for running on two stores:
- `$everything` (not offered by the store) is replaced by a helper, `compartmentOf`. On Medplum it still calls `$everything`; on the store it runs one `_compartment` search per compartment type. Used in `cleanupTestPatient`, `ccda`, `engine`, `share-scope`, `smart-sync` and `smart-cli`.
- `stack`: the `auth/me`, Forbidden admin types and cross-project checks run on Medplum only, because the store has no login, project or admin records. The binary, batch and compartment checks run on both.
- `share-scope`:
  - The note's attachment URL is checked by its Binary id. On Medplum it is a presigned `/storage/` URL.
  - Dropping another patient's Binary by `securityContext` is checked on Medplum only. GA never sets `Binary.securityContext`, and the store keeps none (one patient per store).
- `share-cli`, `smart-cli`: the CLI child config comes from `childConfig()`. On the store that is the store URL and a copy of the token; on Medplum, the login fields as before.
- `emptyTestProject` now also deletes `Basic`. `migrate-store`'s seed writes one, and 11 had piled up in ga-test, which failed `migrate` on Medplum.
- `restoreConfig()` replaces `delete process.env.GA_CONFIG`. Deleting the variable fell back to the checkout's `.ga/config.json`, which a worktree doesn't have (a `stack` failure on Medplum).

## Memory and speed

Setup: Linux, `node:26.13.0-alpine`, one container with `-m 512m --memory-swap 512m --network none`.
- Running: ga-store (`node --max-old-space-size=192 src/store/serve.ts`), `ga gateway serve` (with `GA_PUBLIC_URL` set, so the OAuth/MCP side is loaded) and `ga sync --daemon` (no sources, idle).
- Tool workload: a fourth process, GA's MCP server and tools, calling the store over HTTP.
- Why a fourth process: the gateway's `/mcp` needs a passkey login, so this process stands in for the gateway's tool work. It double-counts one Node baseline, about 80 MB anonymous.
- Runs: 9 per tool. `whats_new` used `since: 2026-01-01` (never marks seen); `lab_results` used `summary: true`.

| | Synthetic (30,062 resources, 389k index rows) | Owner's record, read-only copy (30,128 resources) |
|---|---|---|
| `health_summary` median | 389 ms | **109 ms** (goal 165) |
| `vitals` | 9 ms | **18 ms** (goal 72) |
| `whats_new` | 322 ms | **1,702 ms** (goal 2,000) |
| `lab_results` summary | 96 ms | 28 ms |
| ga-store RSS idle / peak (anon idle) | 231 / 259 MB (164) | 232 / 287 MB (165) |
| gateway RSS idle (anon) | 150 MB (81) | 151 MB (81) |
| sync RSS idle (anon) | 148 MB (79) | 149 MB (79) |
| tools process peak RSS | 222 MB | 229 MB |
| container anonymous memory, peak (4 processes) | 422 MB | 477 MB |
| one process: store + tools in one Node, peak RSS | 309 MB (`health_summary` 446 ms, `whats_new` 349 ms) | 376 MB (`health_summary` 120 ms, `whats_new` 993 ms) |

- The container's `memory.peak` hit 512 MB on both runs. That figure includes the SQLite file's page cache, which the kernel reclaims; no process was killed.
- RSS also counts about 67-69 MB of file pages per process (the Node binary and modules), which the processes share.
- Expected total for the real deployment, where the gateway runs the tools: 477 − 81 ≈ 400 MB anonymous, plus about 70 MB of shared file pages, so about 470 MB. That fits 512 MB with little headroom.
- One process: store + tools peaked at 376 MB on the owner's copy. Gateway and sync code in the same process would add about 50-70 MB, so about 430-450 MB.
  - That is somewhat below the three-process total, because the Node baseline and definitions are paid once.
  - It would also make `whats_new` faster (993 vs 1,702 ms): its many small store requests skip HTTP.
- Caveats:
  - The tools ran with outbound fetch stubbed (503) and no network, so `whats_new` leaves out FDA label lookups for new medications. With only 1.70 vs 2.0 s, that is the thinnest margin; it would stay inside the 1.5× fallback.
  - The anonymous peaks are sampled every 0.2 s.
- The store process holds 165 MB anonymous when idle. Most of it is left over from parsing the definitions at startup (memory spike: +60 MB retained, +158 MB peak).

## Large Apple Health import (Review Focus 4)

The export was synthetic, generated in the temp dir and never the owner's file:
- 8 years, 1,180,934 records, 453 MB `export.xml`.
- Per day: heart rate every 5 minutes, steps, distance, SpO2, resting and walking heart rate, wrist temperature, sleep stages, and an activity summary. Weekly: weight and BP.

`ga import` into a temp store, in one container with ga-store:

| Limit | Result |
|---|---|
| `-m 512m`, Node's default heap | **OOM** after 73 s: "Reached heap limit", heap about 225 MB. Nothing was written past the archive. |
| `-m 1536m`, `--max-old-space-size=1024` | Completed: 44,637 resources created in 1,163 s. Import process peak RSS 724 MB, store 261 MB, container anonymous peak 743 MB. |

The memory is in the importer, not the store:
- `importAppleHealth` holds every mapped Observation plus the existing-record map, then passes the whole list to `importResources` in one call.
- The store process stayed at 261 MB or less while it received about 38 creates per second.
- The same importer runs on Medplum, so this predates the store.
- It matters for 512 MB because a chat upload (`import_file`) runs the import inside the gateway process.

## Real-record dry run (`ga migrate-store`, read-only)

How it ran:
- Function: `migrateStore()`, the code `ga migrate-store` runs, with `--services-stopped` and no `--yes`.
- Source: the owner's Medplum login from the live config, which was only read. Writes to Medplum are blocked (0 attempted).
- Output: a new temp file. The report and any incidental files went to a temp dir, not the live `.ga/`.
- The copy was deleted after the measurements above.

First run, before the gate rules (results below), then a rerun in fix round 1 (at the end of this section).

Results of the first run:
- **Copied:** 30,128 records in 24 types; 0 skipped, 0 uncounted. Copy and verify took 47 s.
- **History versions:** 325.
- **Binaries:** 81 copied, 0 failed, 0 unresolved.
- **Version mismatches:** 0. **Compartment mismatches:** 8 (Observation).
- **Replay:** 193 rows, 153 equal, 39 allowed, 1 unexplained.
  - By category: tool 33 equal and 1 allowed; GA's own searches 83 equal and 17 allowed; agent-style searches 37 equal, 21 allowed and 1 unexplained.
  - The allowed rows are signed attachment URLs and ties.

**First run's gate: would not switch.** It counted two problems, both explained after analysis:

1. **Compartment, Observation × 8 (all from C-CDA).**
   - The `subject` points at a Patient id that is not a UUID and does not exist in GA.
   - Medplum gives them no compartment, presumably because its compartment ids are UUIDs (not checked in Medplum's source). The store gives them that Patient's compartment.
   - Neither side puts them in the owner's compartment, so no tool, share or search for the owner sees them on either store.
   - So this difference is explained. **Later finding (2026-11-08):** these 8, plus 6 with no subject, were test records a draft integration test wrote into the live project on 2026-11-07, not an importer gap. They were deleted, the importer now refuses a record whose patient is not the one being imported, and the `orphanCompartment` rule below was removed.
2. **Replay: agent search `Observation` [`date`, `_sort`], extra:1** (the parity probe `date=eq<day>`).
   - The store returns one more record: a timed Observation whose UTC instant falls inside the queried day.
   - The cause was found with synthetic records in the ga-test project:
     - Medplum's `date=eq<day>` on a timed value matches only the exact instant of midnight UTC: midnight matched, midday UTC did not.
     - The store matches the whole UTC day, as FHIR's range semantics say.
   - GA's own code never sends `eq` dates; only an agent's `fhir_search` could. The store's answer is the correct one.
   - The integration probe agreed on both stores only because it falls outside the UTC day.

**Fix round 1: two narrow gate rules, then a rerun.** Both are reported as allowed and listed, with a count.
- Compartment (`orphanCompartment`, since removed: see the later finding above): allowed only when all three hold:
  - the record came from C-CDA (tag or identifier);
  - Medplum's compartment has no Patient;
  - every Patient compartment the store assigns is a Patient the store doesn't hold and not the self Patient.
  The report lists the record ids. Any other mismatch still blocks.
- Date eq (`eqDayExtras`, kind `medplum-eq-day`): allowed only when all three hold:
  - the query's one date is `eq<day>`;
  - the store side only adds records;
  - every date value of each added record is a time, one of them inside that UTC day and not its midnight.
  Missing records or order differences stay unexplained. The probe stays.

Rerun (same method; the copy was deleted afterwards):
- Copied 30,130 records, 325 history versions, 81 Binaries; 0 skipped, 0 uncounted, 0 version mismatches, 0 failed or unresolved Binaries, 0 blocked writes.
- Compartment mismatches 0; allowed C-CDA orphan-patient compartments: Observation 8.
- Replay: 193 rows, 153 equal, 40 allowed (one of them `medplum-eq-day`), 0 unexplained.
- **Gate: passes (0 problems).** `ga migrate-store --yes` would switch.

## Recommendations

1. **Before the switch.**
   - The gate now passes; the owner reads the report, including the 8 listed C-CDA records.
   - Those 8 records never got the GA patient as subject: an importer gap worth a look either way.
   - UTC day vs the owner's local day for `eq` and day-precision `ge`/`lt` is a product choice. GA's users think in local days.
2. **Apple import within 512 MB.** Stream the importer: map and import in batches, for example per 5,000 resources, instead of one array. Look up existing records per batch. Until then, import large exports from the host CLI, not through a chat upload.
3. **Memory headroom.**
   - Load the pre-built trimmed definitions snapshot in ga-store. The spike measured about 30 MB less retained and about 120 MB less startup peak.
   - Consider one GA process (store + gateway + sync). It is about 430-450 MB, faster for `whats_new`, and the likely cloud end state.
   - With three processes, the measured total is about 470 MB of 512 MB.
4. **Import speed:** about 38 creates per second over HTTP (19 minutes for 44,637 records). Batching writes into transactions would help both speed and memory.
