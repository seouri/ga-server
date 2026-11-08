# GA's own FHIR store on SQLite: Design

First of the one-click-deploy projects (then: C-CDA converter swap, "Deploy GA" page, passkey-encrypted backups; native apps later). Legend: **[user]** decided by the owner, **[call]** designer's call (open to override), **[spike]** measured in a throwaway spike.

Spike write-up: branch `spike-sqlite-store`, `docs/superpowers/spikes/2026-11-07-sqlite-fhir-store.md` (prototype `src/store/` on that branch, 370 lines).

## Intent

GA should run where the owner's Mac need not be awake: reliably, at about $5 a month, securely, deployable as easily as ordering on Uber Eats **[user]**. Today GA depends on Medplum (server, Postgres, Redis: about 850 MB of memory) plus a 400 MB C-CDA converter, which rules out a $4-5 container. GA uses Medplum only as a FHIR record store with one login: no bots, subscriptions, access policies beyond its own, or multi-user features. Replacing it with GA's own store in one SQLite file makes GA one small process.

Records stay FHIR resources (FHIR export keeps working); what goes away is the FHIR server **[user: "non-FHIR server", FHIR as the format]**. `fhir_search` stays broad: GA does not yet know how much search it will need **[user]**.

## Goals

- **Footprint:** GA as a whole (store + gateway + sync + tools) runs in **512 MB** of memory on a small Linux container **[call]**. The spike's process peaked at 657-945 MB, ~250 MB of it the full FHIR definitions: trimming is required, not optional.
- **Speed:** the heavy tools (`health_summary`, `vitals`, `whats_new`) are no slower than on Medplum on the owner's record (Medplum medians: 165 ms, 72 ms, 2.0 s) **[call]**. Spike medians were 738 ms, 240 ms, 3.3 s because `node:sqlite` is synchronous and GA's parallel searches serialized.
- **Same answers:** every GA tool returns the same result as on Medplum for the owner's record (spike: 28/30 identical; the two differences were an unsorted GA query and Medplum-signed attachment URLs) **[call]**.
- **Broad search:** `fhir_search` supports the common FHIR search features on every resource type; anything unsupported returns a clear error, never a silently wrong answer **[user + call]**.
- **One-time move** from the existing Medplum install with every resource id, version id and lastUpdated preserved, then switch over **[call]**.

## Non-goals

- The C-CDA converter swap (its own project **[user]**); the Microsoft converter keeps running as today.
- The "Deploy GA" page, cloud hosting, encrypted backups, native apps, push relay.
- A FHIR REST server for other apps; multi-patient installs; terminology services.
- Search features no use has needed: composite and special parameters, `:above`/`:below`/`:in`, chains deeper than one level, `_summary=true` (the spike skipped these; return "not supported").

## Anti-goals

- No silent wrong answers: an unsupported search errors.
- No PHI in the repo, tests or logs (the existing rules).
- Tests never write to the owner's real record.
- No regression in share-link scoping (the security core in `src/share/scope.ts`).

## Decisions

- **Engine:** Node's built-in `node:sqlite`, one file, WAL mode **[spike/call]**. No native npm SQLite dependency unless the speed goal cannot be met otherwise (then `better-sqlite3` is the fallback, a builder decision with a recorded reason).
- **FHIR knowledge from `@medplum/core` (Apache-2.0), already a GA dependency:** FHIRPath evaluation for indexing, the official search-parameter definitions, and `validateResource` offline (spike: 78 µs/resource). `@medplum/definitions` (or the minimal subset GA needs) becomes a real dependency instead of copying it from the Medplum container **[spike]**.
- **Index:** each resource is indexed by evaluating every applicable search parameter's FHIRPath; search translates to SQL over the index **[spike]**. Store sort keys as columns, page by cursor (not offset) **[spike recommendation]**.
- **Client shape:** GA keeps calling a `MedplumClient`. The store answers through the client's `fetch` (as in the spike), so the ~80 call sites, the sync dry-run proxy and the tests keep working **[spike]**.
- **One owner of the file:** exactly one process opens the database and serves the others over local HTTP with the same fetch-shaped API **[spike/call]**. Reason: the stdio MCP server (launched by Claude Code on the host), `ga-sync` and `ga-gateway` are separate processes, and on macOS the containers reach the host filesystem through a VM, where SQLite file locking is unreliable. Which process owns it (gateway, a dedicated `ga-store` service, or one merged GA service) is left to the builder, with the 512 MB goal in mind; a single GA process serving everything is the likely end state for cloud deploy.
- **Server-set metadata, matching Medplum's behaviour GA relies on:** generated ids, `meta.versionId`, `meta.lastUpdated`, history rows for **every** type, `If-Match` → 412 on version mismatch, `If-None-Exist` conditional create, `meta.compartment` for patient-compartment members (share scoping reads it), validation errors in the shape `engine.ts isValidationFailure` expects (400 + element paths) **[inventory/spike]**.
- **Medplum quirks to keep (found by the spike):** a Period with no end counts as ending at its start; `_elements` keeps required fields and adds the SUBSETTED tag; partial dates in search are rejected as Medplum does (or accepted consistently — builder chooses, documents it); undated records sort first on `-date` (GA's code compensates) **[spike]**.
- **Binary:** files in a directory beside the database (or BLOBs, builder's call), served at a GA URL; the presigned `/storage/...` handling in `smart/sync.ts`, `share/scope.ts`, `share/summary.ts` adapts **[call]**.
- **Login:** none. Medplum's ClientApplication/AccessPolicy/ProjectMembership, the admin password, `ga setup`'s Medplum admin calls and the 5-logins-a-minute limit go away. The local HTTP the store serves listens only on localhost / the internal Docker network, never on the public gateway port **[call]**.
- **Person-edit detection:** the owner never edits records by hand **[user]**; with Medplum's admin app gone, writes come only from GA. `meta.author` comparisons (`engine.ts`, `concepts-cli.ts`) are simplified: every write is GA's; the `person-edited` / `source-conflict` paths for hand edits are retired or kept only for agent writes as they are today (builder decides from the code, keeps tests meaningful) **[user/call]**.
- **Switchable during the move:** a config setting selects Medplum or the SQLite store, so the owner can fall back until confident; Medplum is removed from the default compose once the SQLite store is the default and has run on the owner's record **[call]**.
- **Migration:** `ga migrate-store` (CLI) copies every resource GA can read from Medplum (patient compartment plus referenced Medications, Endpoints, Basic, ConceptMaps, Provenance, AuditEvents, DocumentReferences and their Binaries), preserving ids, version ids, lastUpdated, tags and extensions, and full history; then verifies by replaying GA's read tools on both and reporting differences (the spike's replay, made a command) **[call]**.
- **Backups:** `scripts/backup.sh` switches from `pg_dump` to an online SQLite backup plus the Binary directory (encryption is the later backups project) **[call]**.
- **`concepts_to_review`:** add a `_sort` so its order no longer depends on storage order (the spike's one tool mismatch) **[spike]**.

## Settled after the builder check [call]

- **Memory beats speed** if the two goals conflict: the owner ranked low cost and reliability first. Plan a memory spike first (trimmed definitions, chosen driver) before building out the store; if speed then misses, the fallback goal is "within 1.5× of Medplum" on the heavy tools, recorded with measurements.
- **The C-CDA converter is outside the 512 MB target.** Until its own project, it runs only when a C-CDA import needs it (a compose profile or started on demand), not always-on.
- **Local HTTP is authenticated.** The store owner requires a bearer token from a 0600 file in `.ga/` (same pattern as the notify bridge token), compared in constant time; it listens on localhost and the internal Docker network only, never through the public gateway or Funnel.
- **History:** the migration copies full history for the types GA reads history of (MedicationStatement, MedicationRequest, Condition, AllergyIntolerance, Patient) and the current version of everything else, preserving version ids. From the switch on, every write keeps history for every type.
- **Cutover downtime is acceptable:** `ga migrate-store` stops `ga-sync` and `ga-gateway` while it copies (minutes on the owner's record) and restarts them on the store; no delta pass.
- **Switch scope:** while the setting exists, the Medplum path only has to keep working as it does today (reads, writes, sync, shares, setup). New behaviour (Binary URLs, no-login setup) is built for the SQLite store only. Removing Medplum (compose, setup, code, docs) is a follow-up after the owner has run on the store; not part of this project.
- **Patient compartment** follows the FHIR Patient CompartmentDefinition shipped in the definitions (as Medplum does), including referenced resources GA stores with the patient (Medication, Provenance, DocumentReference/Binary as today). Migration verifies that every resource's compartment matches Medplum's `meta.compartment`; `src/share/scope.ts` tests run against the store. Any mismatch blocks cutover.
- **Writers:** without a login, a write's author comes from GA's existing writer tags (`writer-importer`, `writer-agent`, sync); `source-conflict` keeps protecting agent-written records from later imports via those tags. Paths that existed only for hand edits in the Medplum app are removed with their tests.
- **"Same answers" gate:** zero unexplained differences in the migration replay. Allowed and listed in the report: freshly signed attachment URLs and order among equal sort keys in queries without a tiebreaker. The owner reads the report before switching.
- **One door to the file:** every process, including CLI commands on the host (`ga import`, `ga share`, `ga status`), goes through the store owner; when it is not running they fail with "GA is not running: start it with docker compose up -d". Only `ga migrate-store` opens the new file directly, before the owner starts on it.

## Constraints

- Node 26 strip-only TypeScript, vitest; no PHI anywhere in the repo.
- Existing tests: ~665 unit (fake clients) and ~150 integration (real Medplum, throwaway `ga-test*` projects). Integration tests must run against the SQLite store (temp files, never the real one) and, while the switch exists, against Medplum.
- Docs: README, docs/operations.md (where data lives, backup/restore, uninstall, admin app), AGENTS.md, setup.sh, compose.yaml update to the store.

## Left to the builder

Which process owns the file; worker thread vs async driver vs better-sqlite3 for speed; schema and index layout; how to trim definitions to the memory goal; BLOB vs files for Binary; cursor format; partial-date policy; exact migration verification output; how the integration suite runs against both stores during the transition.
