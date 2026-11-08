# Spike: GA's FHIR store on SQLite (2026-11-07)

Throwaway. Question: can a small FHIR store on Node's built-in SQLite replace Medplum for GA, and how much FHIR search does GA need? Context: one-click personal deployment at about $5/month needs GA to fit one small container (256-512 MB); Medplum's stack (server, Postgres, Redis) is about 850 MB.

Code on this branch: `src/store/store.ts` (303 lines), `src/store/fetch.ts` (67), harness in `src/store/spike/` (406). The store indexes each resource by evaluating Medplum's search-parameter definitions with `@medplum/core`'s FHIRPath; GA reaches it through an ordinary `MedplumClient` whose `fetch` answers from SQLite, so GA ran unchanged. No real data is in the repo; the SQLite copy and logs were kept outside it. Medplum was read-only during the spike (a write guard counted 0 attempts).

## Method

Copied the owner's patient compartment from the running Medplum into SQLite (ids, versionId, lastUpdated, tags, extensions preserved; full history only for MedicationStatement, MedicationRequest, Condition, Patient). Recorded every request GA's read tools made against Medplum, then ran the same tool calls and searches with GA pointed at SQLite and compared outputs. Added ~50 agent-style `fhir_search` queries, including chained, `_revinclude` and `_has` probes.

## Results

| Category | Match |
|---|---|
| GA tools (30 calls) | 28/30 byte-identical; `concepts_to_review status:suggested` differed only in row order |
| `fhir_read` (4) | 3/4; Medplum signs attachment URLs per read |
| Distinct searches GA's tools sent (121) | result sets 120/121; order 100/100 where GA sorts; totals and next links 121/121 |
| Agent-style `fhir_search` (52) | 20 exact, 16 differ only among equal sort keys, 3 unsorted paging, 2 partial dates Medplum rejects and SQLite accepts, 9 empty on both |

Writes (create, update with If-Match/412, history, If-None-Exist, Binary, delete) passed a smoke test on a copy. Not replayed: import, share and migrate paths; 87 Medplum `_cursor` pages (Medplum's own token).

Mismatch causes: ties in sort order (agent queries without a tiebreaker; GA's own `-date,_id` sorts all matched); unsorted order (7/21 matched; `concepts_to_review` should add `_sort`). Medplum behaviours copied to match: a Period without an end counts as ending at its start; `_elements` keeps required fields and adds SUBSETTED; next links rename `_elements` to `_fields`; partial dates are rejected.

## Size, speed, memory

- SQLite 301 MB vs Medplum database 1,121 MB (Medplum figure includes 392 MB of Observation history not copied). 30,125 resources, 689k index rows. Load 25 s (3 s fetch, ~20 s indexing).
- Single searches (median): GA's 4.6 ms SQLite vs 6.8 ms Medplum; agent-style 1.2 vs 7.5 ms; wide Observation queries up to ~80 vs ~25 ms.
- Tools (median): `health_summary` 738 vs 165 ms; `vitals` 240 vs 72 ms; `whats_new` (since a date) 3.3 vs 2.0 s; `lab_results` 31 vs 23 ms; lists, notes and `fhir_read` faster on SQLite. Cause: `node:sqlite` is synchronous, so GA's parallel searches serialize.
- Memory: GA process peak RSS 657-945 MB with the store (cache-dependent) vs 361 MB on Medplum; the FHIR definitions alone ~250 MB. The Medplum stack it replaces uses ~846 MB.
- Validation: `validateResource` works offline with the shipped definitions, 78 µs per resource, 0 issues on the copy.

## Search features

- Used by GA's read tools: tokens (system-only, system|code, OR lists), `:text`, `:not`, `_tag:not`, dates with `ge`/`lt`, `_lastUpdated`, small `_filter` (`eq`/`or`), `_id` lists, `_include`, `_elements`, multi-key `_sort`, `_count`/`_offset`, `_total`, history, reads.
- Used only by import, share, migrate code (not replayed): `:missing`, `_compartment`, `_summary=count`, If-None-Exist, batch.
- Used only by agent-style queries: `_revinclude`, one-level chains, `_has`, `:contains`, partial dates, quantity.
- Implemented: all of the above. Skipped: composite and special parameters, `:above`/`:below`/`:in`, multi-level chains, `_summary=true`.

## What production would need

1. One process owns the SQLite file and serves the others over HTTP (stdio MCP, ga-sync and ga-gateway cannot safely share a file across the Docker VM boundary); the fetch-shaped API fits this.
2. Speed: worker thread or async driver, sort keys as columns, cursor paging.
3. Binary storage and an attachment URL scheme.
4. Full history for every type; server-set metadata on every write (compartment, versions) that sharing relies on.
5. Trimmed definitions to cut memory toward 512 MB; `@medplum/definitions` as a real dependency (the spike copied it from the Medplum container).
6. Migration from Medplum, backup, tests.

Estimate: 3-5 weeks to production quality. Search correctness: low risk. Medium risk: memory target and the single-owner design, and matching latency on the heavy tools.
