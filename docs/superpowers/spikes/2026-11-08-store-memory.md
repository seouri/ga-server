# Spike: store memory and driver (2026-11-08)

Task 1 of the SQLite store plan. Question: which SQLite driver and threading, how far trimming the FHIR definitions cuts memory, and whether GA fits 512 MB. Synthetic data only; counts and timings only. Scripts lived in a temp dir (not committed). The store under test is the prior spike's (`spike-sqlite-store:src/store/store.ts`, `fetch.ts`); GA's real MCP tools ran against it through a `MedplumClient` whose `fetch` answers from SQLite.

## Decision (binds Task 5)

**Driver: `node:sqlite` (built in); threading: the store runs on the main thread of the process that owns the file, no worker; definitions: trimmed to STORED_TYPES (+ referenced datatypes), 60 MB.**

- SQLite settings: `cache_size` 64 MB, `mmap_size` 0. Node: `--max-old-space-size=192` for the GA process.
- Trade-off: `node:sqlite` blocks the event loop while a search runs. In a store-only process that means one search at a time (the slowest measured was 40 ms). If GA's tools run in the same process as the store, one `health_summary` blocks the loop for about 1 s at today's query speed (measured 1.0-1.9 s maximum stall). A worker removes the stall but adds 70-120 MB and gives no latency gain. Memory beats speed, so: main thread. Revisit only if Tasks 3/4 leave heavy tools slow and the gateway must serve during them.
- `STORED_TYPES` = every Patient compartment type in the shipped CompartmentDefinition (66) plus the shared and GA-internal types: 76 resource types, 345 datatypes (vs 754 in the full set). This is wider than the brief's list: GA searches every compartment type (`src/share/scope.ts` `PATIENT_COMPARTMENT`, e.g. `AdverseEvent` with `_tag`). With the brief's list, `health_summary` and `whats_new` returned section errors. Searching a type outside the list fails with "Unknown search parameter" (a clear error, not an empty result).

## Dataset

30,062 synthetic resources shaped like GA's: 21,560 Observation (lab results from two sources, Apple Health vitals, blood pressure, daily step totals), 1,500 Encounter, 1,200 DocumentReference (inline text), 2,000 Provenance, 1,500 AuditEvent, 500 DiagnosticReport, 400 Communication, 300 each Condition/MedicationRequest/Procedure, 200 MedicationStatement, 100 Immunization, 200 Practitioner/Organization, Patient, Endpoint. 483,342 index rows (the owner's record had 689k), 155 MB file, load 15.5 s.

## Definitions memory (Linux, node:26.13.0-alpine, after forced GC; process baseline ~94 MB)

| Load | RSS retained | RSS peak | JS heap after GC | Load time |
|---|---|---|---|---|
| Full (as in the spike) | +94 MB | +193 MB | 24 MB | 400 ms |
| Trimmed from the bundles (committed `loadDefinitions`) | +60 MB | +158 MB | 18 MB | 270-350 ms |
| Trimmed, from a pre-built 4.6 MB snapshot-only file (not built) | +30 MB | +38 MB | 21 MB | 130 ms |

- The definitions themselves are small in the heap (18-24 MB). Most of the RSS is left over from parsing `profiles-resources.json` (35 MB). The allocator keeps that memory after GC and does not give it back to the OS. Parsing in a throwaway worker did not help (tried).
- The spike's "~250 MB for definitions" was measured on macOS, where freed pages stay counted in RSS. On macOS: full +210 MB.
- Validation with the trimmed set matches the full set on all 30,062 resources: same issue counts (3,500 synthetic Provenance/AuditEvent records the generator gave an invalid `identifier`, rejected by both), 52-53 µs per resource. The heavy tools return byte-identical output with trimmed and full definitions.

## Store and tools: latency and RSS (Linux, trimmed definitions, medians of 7)

GA process = GA's MCP server + tools + store in one process (module baseline ~155 MB before anything loads).

| Config | health_summary | vitals | whats_new (since) | lab_results summary | RSS steady / peak |
|---|---|---|---|---|---|
| main, cache 200 MB + mmap 800 MB (spike defaults) | 1,041 ms | 176 | 471 | 190 | 461 / 531 MB |
| worker, same | 1,008 | 182 | 493 | 202 | 474 / 626 |
| main, cache 16 MB | 1,227 | 201 | 544 | 221 | 429 / 473 |
| worker, cache 16 MB | 1,217 | 207 | 608 | 234 | 447 / 504 |
| main, cache 16 MB, mmap 0, old space 192 MB | 1,498 | 250 | 666 | 265 | 261 / 312 |
| worker, same | 1,505 | 228 | 662 | 270 | 348 / 381 |
| **main, cache 64 MB, mmap 0, old space 192 MB (chosen)** | **988** | **168** | **503** | **190** | **308 / 337** |
| main, cache 200 MB + mmap, old space 192 MB | 1,061 | 181 | 518 | 201 | 376 / 404 |

- Full definitions: same latencies, steady RSS ~50-100 MB higher.
- Most of the growth while tools run is garbage the GC has not yet collected and SQLite page cache, not retained data. Capping the old space at 128-192 MB cut the peak from 473 to 312-317 MB, with no out-of-memory error and no slowdown.
- Event loop: main thread, maximum stall 993-1,959 ms (the timer fired only between tool calls); worker, 52-108 ms (GA's own JavaScript).
- better-sqlite3 13.0.3 (installed only in a temp copy, measured on macOS only, main thread): `health_summary` 868-873 vs 944-948 ms, `vitals` 153 vs 180 ms, about 8-15% faster. Not chosen: same engine, same gap to the goal, and a native dependency for every platform.
- A pool of reader workers could run GA's parallel searches at once, but each isolate costs memory and a $5 container has about one vCPU. Rejected under "memory beats speed".

## Speed goal: missed; cause is the queries, not the driver

Goal (Medplum medians on the owner's real record): `health_summary` 165 ms, `vitals` 72 ms, `whats_new` 2.0 s. The synthetic record is a different dataset, so these comparisons are indicative only. `whats_new` meets the goal (0.5 s). `health_summary` (~1.0 s) and `vitals` (~170 ms) do not.

Profile of one `health_summary`: 92 searches, 790 of 980 ms inside synchronous `store.search`, the rest GA's own work. The slowest are `Observation?subject&category&code:text&_tag[:not]&_sort=-date,_id&_count=2`, at 30-40 ms each for 0-2 results. The `:text` filter is a `lower(val) like '%…%'` scan over the index table, and the sort is a correlated subquery per row. A worker or another driver cannot remove that: the searches share one connection and serialize either way. The work belongs to Tasks 3/4: an indexed form for `:text` (normalized text column or FTS5) and sort keys stored as columns. If those still miss, the fallback goal is "within 1.5x of Medplum".

## 512 MB: projected met in one GA process, not yet shown end to end

- Measured: store + GA's MCP server and tools in one process, chosen config, 337 MB peak (308 steady) on 30k resources.
- Projected for one GA process (store + gateway + sync + tools): about 380-420 MB peak. The page cache is capped at 64 MB and the JS heap at 192 MB, so a record with 1.4x the index rows should not raise it much. Gateway and sync code and buffers are an estimated +30-60 MB, not measured. Large imports are Task 9's measurement.
- A separate `ga store serve` process pays a second Node baseline plus definitions and page cache (about 95 + 60 + 64 MB), which puts the total near 512 MB. If Task 5 keeps the store in its own process, it should load the pre-built trimmed file (saves ~30 MB retained, ~120 MB at startup peak) and run with a small old space. One merged GA process is the comfortable fit.
- Not yet measured: gateway and sync in the same process, the owner's real record size, and a cgroup memory limit (`docker run -m 512m`). Task 5/9 should run the stack under that limit.
