# FHIR store on SQLite

A FHIR R4 record store in one SQLite file (`node:sqlite`, WAL), with binaries as files beside it. Resources stay FHIR JSON; each one is indexed by evaluating its type's official SearchParameters (FHIRPath, via `@medplum/core`), and FHIR search is SQL over that index. One process owns the file and serves it over local HTTP in Medplum's REST shape, so a `MedplumClient` in another process reads and writes it. Used by GA.

This directory is the whole store, code and tests (`test/`): its files import only Node built-ins, the packages below and each other. `test/boundary.test.ts` enforces that, so the directory can become its own repository as is (see [Tests](#tests)).

## Requirements

- Node >= 26 (`node:sqlite`; TypeScript runs as-is through Node's type stripping, no build step).
- `@medplum/core` 5.2.14, `@medplum/definitions` 5.2.14, `@medplum/fhirtypes` 5.2.14 (types only). Tests: `vitest` 5.1.0.
- No other dependencies, no native modules.

## Running it

```sh
node serve.ts --file <path/to/store.db> --token-file <path/to/token> [--host 127.0.0.1] [--port 8120] [--max-binary-bytes 2147483648] [--types Patient,Observation,...]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--file` | required | The SQLite file; created if missing. Binaries go to `binary/` next to it. |
| `--token-file` | required | Bearer token file. Created on first start (32 random bytes, base64url, 0600 in a 0700 directory); an empty or short one is refused. |
| `--host` | `127.0.0.1` | Interface to listen on. |
| `--port` | `8120` | Port (`0`: any free port). 8120 is an arbitrary default with no meaning. |
| `--max-binary-bytes` | 2 GiB | Largest Binary body accepted (streamed to disk). JSON bodies are capped at 16 MiB. |
| `--types` | every R4 resource type (147) | Comma-separated resource types the store accepts; others are 400. A smaller set loads fewer definitions and uses less memory (about 10 MB less RSS for 76 types). |

No environment variables are read. SIGTERM and SIGINT close the server and the database. A second server on the same port fails before it touches the token file or the database; only one process may open a file.

## API

From `server.ts`:

- `serveStore(opts: ServeOptions): Promise<http.Server>` with `ServeOptions = { file; host?; port; tokenFile; maxBinaryBytes?; types? }`. Listens, then opens the token file and the database; the server's `close` closes the database.
- `storeToken(file): string`: the token file's contents (created as above if missing).
- `JSON_LIMIT`, `DEFAULT_BINARY_LIMIT`.

From `serve.ts`: `runStore(opts)` (serve, handle signals, log one line) and `parseServeArgs(argv)`; an embedding app calls `runStore` with its own options.

From `store.ts`, for in-process use (one `Store` per file, in the owning process only):

- `new Store(file, { types? })`; `close()`; `db` (the `DatabaseSync`).
- `create(resource, ifNoneExist?)`, `update(resource, ifMatch?)`, `delete(type, id)`, `read(type, id)`, `readRow(type, id)`, `version(type, id, versionId)`, `history({ type?, id?, since?, count?, offset? })`, `find(type, query)`, `validate(resource)`.
- `search(type, query, base)` / `searchJson(...)`: a searchset Bundle (object or JSON text).
- `put(resource, { history? })`: import keeping the given id, versionId and lastUpdated (for migrations).
- Binaries: `putBinaryStream(contentType, data, id?, replace?)`, `openBinary(id)`, `deleteBinary(id)`.
- `StoreError` (an `OperationOutcomeError` with an HTTP `status`), `INDEX_VERSION` (the on-disk index format) and `IndexFormatError` (thrown by the constructor for a file in another format: rebuild it from its source).

From `definitions.ts`: `loadDefinitions(types?)` (indexes the FHIR definitions for `types`, default every R4 resource type; called by `Store`), `storedTypes()`, `PATIENT_COMPARTMENT_PARAMS`. The definitions go into `@medplum/core`'s global index, so a process holds **one type set**: loading again with the same set is a no-op, with another set it throws. Every `Store` in a process uses the same `types`.

## HTTP surface

Every request except `GET /healthz` needs `Authorization: Bearer <token>` (compared in constant time); without it, 401. `GET /healthz` is 200 once the token and the database are open, else 503, and carries no data.

Under `/fhir/R4/`:

- `GET|POST <Type>` (search; `POST <Type>/_search` with a form body), `GET <Type>/<id>`, `PUT <Type>/<id>` (`If-Match` → 412 on another version), `PATCH <Type>/<id>` (JSON Patch), `DELETE <Type>/<id>`; `POST <Type>` (`If-None-Exist`).
- Conditional `PUT <Type>?query` and `DELETE <Type>?query`.
- History: `<Type>/<id>/_history[/<vid>]`, `<Type>/_history`, `_history` (`_count`, `_since`).
- `POST /` batch and transaction bundles (urn rewriting, conditional references, GET/POST/PUT/PATCH/DELETE entries).
- `Patient/<id>/$everything` (`_count`, `_offset`, `_since`, `_type`); `<Type>/$validate`.
- `Binary`: `POST` and `PUT Binary/<id>` stream the raw body to disk, `GET Binary/<id>` streams it back, `DELETE`.
- `GET metadata`: a CapabilityStatement of what this store supports.
- `ETag`, `Last-Modified` and `Location` headers as Medplum sends them; errors are OperationOutcomes.

Search: the common FHIR search features (all parameter types, prefixes, the modifiers `:missing`, `:exact`, `:contains`, `:text`, `:not` and reference type modifiers (`subject:Patient`), one-level chains and `_has`, `_include`/`_revinclude`, `_sort`, `_count`, `_elements`, `_summary=count`, `_total`, `_filter`), paged by cursor. Anything unsupported is a 400 OperationOutcome naming it, never a silently wrong answer.

## Deliberate differences from Medplum

- Transactions are all or nothing: a failing entry fails the whole transaction with its status (Medplum keeps the entries before it and answers 200).
- A reference to a `urn:uuid`/`urn:oid` no entry defines is 400 (Medplum stores it as written); `urn:oid` fullUrls are rewritten like `urn:uuid`.
- Every urn fullUrl of a transaction is resolved before its entries run (a create or conditional PUT, each on its own: its one match, else a new id). If an earlier entry changes what a later conditional entry matches and another entry references its urn, the transaction is 400 (Medplum fails that entry and leaves references to its urn pointing at no resource); with no reference the entry runs (Medplum still fails it).
- PUT or PATCH of a deleted record is 410 (Medplum brings it back).
- A conditional request (update, delete, If-None-Exist, conditional reference) needs a real search criterion: only paging, sorting, shaping or format parameters, or empty values, are 400.
- `:contains` and `:exact` on a token parameter are 400: R4 defines them for string parameters only (Medplum accepts both on tokens; `:exact` as plain equality).
- A token search without a modifier matches codes, not a CodeableConcept's `text` (that is `:text`, as R4 defines it; Medplum also matches the text by plain equality).
- `_sort` by a parameter with several values uses the lowest value ascending and the highest descending, for tokens as for dates (Medplum sorts a token both ways by one value; its own test calls this store's order the ideal).
- Date prefixes on ranges follow R4, as Medplum's opt-in `range-search` project feature does: `gt`/`ge`/`lt`/`le` match a Period that overlaps the range above or below the value, and apply to every value of a multi-valued date (Medplum without the feature compares a Period by its start and ignores the prefix on a multi-valued date).
- `eq` with a dateTime against a date never matches: R4 `eq` needs the search value's range to contain the target's, and an instant does not contain a day. Medplum matches the dateTime against the date's day, with or without `range-search`.
- `MeasureReport.period` is a date parameter like any other (Medplum trials overlap ranges there: `eq`/`ne` as overlap, `lt`/`gt` against the far end of the search value).
- No login, users, projects or access policies: one bearer token; meant for loopback or a private network only, not as a public FHIR server.

## Next phase: full FHIR spec support

Not supported yet; each answers with an error (400, or 404/405 for an unknown route) and an OperationOutcome naming it:

- `_summary=true`, `_summary=data`, `_summary=text` (`_summary=count` works; `_summary=false` is accepted and changes nothing).
- Composite and special search parameters; the modifiers `:above`, `:below`, `:in`, `:not-in`, `:of-type`.
- Chains deeper than one level; reverse chains (`_has`) beyond one level.
- Date search values below day precision (`2024`, `2024-05`) and comma lists of dates (400, as Medplum without its `range-search` project feature).
- `_contained`, `_text`, `_content`, `_include:iterate`, `_revinclude:iterate` and `_include=*`.
- GraphQL; terminology operations (`$expand`, `$lookup`, `$validate-code`); every operation besides `$validate` and `Patient/$everything`.
- FHIR R4 only (the definitions ship R4); one patient-compartment definition (Patient).

Supported but slow on large results: `_sort` by a parameter that is not a date, `_id` or `_lastUpdated` aggregates index rows per candidate instead of walking a sort index.

## Tests

`test/*.test.ts` (vitest) test the store alone, against temp files, from this directory: in a host repository add `<this dir>/test/**/*.test.ts` to vitest's include.

As its own repository, with history: `git subtree split --prefix=src/store -b fhir-store` in the host repository, then clone that branch. Add:

`package.json`
```json
{
  "name": "fhir-sqlite-store",
  "private": true,
  "type": "module",
  "engines": { "node": ">=26" },
  "scripts": { "start": "node serve.ts", "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@medplum/core": "5.2.14", "@medplum/definitions": "5.2.14", "@medplum/fhirtypes": "5.2.14" },
  "devDependencies": { "@types/node": "26.6.6", "typescript": "7.0.2", "vitest": "5.1.0" }
}
```

`tsconfig.json` (type checking only: Node runs the `.ts` files directly)
```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "allowImportingTsExtensions": true, "rewriteRelativeImportExtensions": true,
    "types": ["node"]
  },
  "exclude": ["node_modules"]
}
```

Then `npm install && npm run typecheck && npm test`.

## License

The store uses `@medplum/core`, `@medplum/definitions` and `@medplum/fhirtypes`, which are Apache-2.0 (the FHIR definitions they ship are HL7's, CC0). The store's code is Apache-2.0.
