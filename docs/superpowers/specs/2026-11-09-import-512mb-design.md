# Exports import within 512 MB: Design (Apple Health, Epic EHI, C-CDA)

Legend: **[user]** decided by the owner, **[call]** designer's call (open to override), **[measured]** measured on 2026-11-09 with synthetic data.

## Intent

GA will run on a small always-on server (the later Deploy GA project) where GA's services share 512 MB. The owner exports Apple Health on the iPhone, moves `export.zip` to the Mac, and uploads it to the server through GA's upload link in a browser (`upload_link`, then `import_file`) **[user]**. The import must work there. Today it does not: the importer needs about twice the whole server's memory for a real-sized export **[measured]**.

What matters is stability and integrity: everything GA imports today is imported, without error, with nothing half-written or duplicated. Speed does not matter **[user]**.

## Current state [measured]

Synthetic export: 2.2 GB `export.xml`, ten years, about 1,560 Records a day (heart rate, energy, steps, distance, HRV, SpO2, weight, body fat, resting and walking heart rate, sleep, ActivitySummary), no real data. GA's real code in Docker (`node:26.13.0-alpine`), a throwaway SQLite store in a second container.

| Step | Code | Memory |
|---|---|---|
| Upload | `src/gateway/uploads.ts` (`acceptUpload`): streamed to disk, 2 GB cap (`MAX_UPLOAD`) | fits |
| Unzip | `unzipSafe` (yauzl, streamed) | fits |
| Import | `src/apple/import.ts` `importAppleHealth` | about 950 MiB peak, then about 680 MiB while writing |

The import was still writing after 30 minutes (store file 343 MB) when it was stopped. The store container stayed near 140 MiB during it. Other measurements the same day, with data the size of the owner's record (about 30,000 records): the store peaks near 240 MiB under GA's heavy reads; the running gateway uses about 100 MiB and `ga-sync` about 80 MiB.

Why the importer holds memory (from reading the code; the builder confirms by profiling before changing it):

- `readExport` streams `export.xml` line by line, but `Readings` and `Daily` collect every resulting resource, and `importAppleHealth` builds one array of all of them before writing anything.
- `existing()` loads a projection of every Apple Health Observation and DocumentReference GA already holds, to skip unchanged ones.
- `importResources` (`src/engine.ts`) receives the whole array in one call.
- `archiveFolder` (`src/archive.ts`) tars the export to a `.tar.gz`, then `storeDocument` (`src/document.ts`) reads that file whole into memory to upload it as a Binary (about 155 MB for the owner's real export).
- `import_file` (`src/tools/imports.ts`) runs the import inside the gateway process; its job lives only in memory, and the unzipped folder is deleted when the job ends.

## Goals

1. **Fits [user]:** a 2 GB Apple Health export imports through `upload_link` → `import_file` while the store, the gateway and `ga-sync` keep running, all within 512 MB together. Budget for the gateway process during the import, including the import: **190 MiB [call]** (512 minus the store's 240 and sync's 80).
2. **Same result [user]:** the records written are exactly those today's importer writes for the same export: same types, same identifiers, same values, same skips and report counts. Re-importing a newer export still updates only changed records, and re-importing the same one is still a no-op.
3. **Integrity [user]:** an import either completes or can be resumed; it never leaves duplicates, and a record is never silently dropped (every skip is counted in the report, as today).
4. **Resume [user]:** if the server restarts or the import fails partway, it resumes from where it stopped. After a restart it resumes on its own **[user]**, skipping what is already written.
5. **Every export kind [user]:** resume and auto-resume cover every `import_file` export (Apple Health, Epic EHI, C-CDA), and the Epic EHI import must also fit the budget (goal 1) with the same-result and integrity goals (2, 3). C-CDA files are small; the builder confirms they fit.
6. **Status stays visible:** `import_status` reports progress and the final report or the error, also for a resumed import **[call]** (today a job is lost on restart).

## Non-goals

- More of the export as records (workouts, routes, per-sample heart rate): later; the list stays what GA imports today **[user]**.
- Speed: an import may take hours **[user]**.
- Notifying the owner that an import finished or failed: needs the later communication-channel work **[user]**. The owner's interim idea for that work, recorded here: GA keeps the result and adds it at the end of its next answer, like the existing `whats_new` "by the way" line.
- C-CDA rework beyond confirming it fits; importing directly from the iPhone; changing the Mac flow (it runs the same importer, so it gets the lower memory too).
- The Deploy GA server itself.

## Anti-goals

- A partial import that looks complete, a duplicate record, or a dropped record without a counted reason.
- A resume that writes a record twice or skips one that was never written.
- Starving the store or the gateway: the import must not make GA's other tools fail or time out while it runs.
- Real data in tests, fixtures or logs; tests never touch the owner's record.

## Constraints

- Node 26 strip-only TypeScript, vitest; no new dependency unless unavoidable.
- Works on both stores: Medplum (the default; search offsets capped at 10,000, page by `_lastUpdated`/cursor) and GA's SQLite store.
- Keeps the existing identifiers (`urn:ga-server:id:apple-health`), tags, Provenance, the import lock (`withImportLock`), and the AGENTS.md rules for Apple Health data.
- The archive copy of the whole export stays **[call]**; it is uploaded without reading the file into memory.

## Decisions

- **Server store [answered]:** the 512 MB server runs GA's own SQLite store (the budget comes from the SQLite store project; Medplum with Postgres and Redis does not fit 512 MB). The importers still work on Medplum, which the Mac uses until the switch, and tests cover both.
- **Import in a child process [call]:** `import_file` runs each import in a child Node process with its own heap limit (`--max-old-space-size`), not inside the gateway, so an overrun fails the import (which then resumes or stops with its error) and never takes down share pages or chat apps. The gateway starts and supervises it, and resumes unfinished jobs at its own startup. The 190 MiB goal covers gateway plus child.
- **Import lock per batch [call]:** each batch takes and releases `withImportLock`, so `ga-sync` and `ga_import` can run between batches during a multi-hour import, and the lock's 2-hour stale-holder rule never fires mid-import. State that spans batches (daily summaries) lives in the import process; correctness across interleaved writes rests on the stable identifiers.
- **Exact report after resume [call]:** counters and skip tallies are saved with the checkpoint after each committed batch, so a resumed import's final report equals an uninterrupted run's (goal 2). A batch interrupted mid-write is redone; its identical records count once.
- **Disk [call]:** the uploaded zip is deleted once it has been unzipped successfully (the unzipped folder is enough to resume); the archive tarball is streamed to the Binary upload without reading it into memory. The server's disk size is not known yet; the design keeps at most one copy of the export plus its compressed archive at a time.
- **Time zone [answered]:** containers use the owner's zone from `.env` (`TZ`, docs/operations.md), so daily summaries match the Mac; the zone (and an EHI import's `tz`) is saved with the job so a resume uses the same one.
- **EHI measured first [call]:** the Epic EHI import's memory has not been measured; the builder measures it on a synthetic export the size of a real one before reworking it, the same way as Apple Health.
- **Measure first [call]:** the builder turns the synthetic measurement into a repeatable test before changing code. A generator writes a synthetic export: small in unit tests, 2 GB in a manual or integration run. The test checks the importer's peak memory against the budget, and the records written against today's importer (goal 2).
- **Write as you read [call]:** records are written in bounded batches while the export is read, so memory does not grow with the export. The unchanged-record check and the engine work per batch, not on the whole export. Where a result depends on the whole export (daily summaries need a whole day; daily steps take the largest source per day), the builder keeps only the state that needs (per day, per type) and writes a day once it is complete.
- **Resume by checkpoint plus identifiers [call]:** progress is recorded on disk in `.ga`; the job record, the uploaded zip and the unzipped folder are kept until the job ends. On restart the gateway finds unfinished jobs and continues them. Because every Apple Health record has a stable identifier, a resumed batch that was partly written is safe to write again: existing identical records are skipped.

## Left to the builder

Batch size; the checkpoint format and where it lives; how daily summaries are carried across batches; how `existing()` becomes batch-sized (per batch identifier lookups, or a bounded scan); the archive upload without a full read (streamed Binary, `src/store` already streams Binary bodies); what `import_status` shows while resuming; how many times an import retries a failing batch before stopping with the error.
