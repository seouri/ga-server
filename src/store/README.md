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
- `search(type, query, base)` / `searchJson(...)`: a searchset Bundle (object or JSON text); `type` an array of types: a system-level search across them.
- `put(resource, { history? })`: import keeping the given id, versionId and lastUpdated (for migrations).
- Binaries: `putBinaryStream(contentType, data, id?, replace?)`, `openBinary(id)`, `deleteBinary(id)`.
- `StoreError` (an `OperationOutcomeError` with an HTTP `status`), `INDEX_VERSION` (the on-disk index format) and `IndexFormatError` (thrown by the constructor for a file in another format: rebuild it from its source).

From `definitions.ts`: `loadDefinitions(types?)` (indexes the FHIR definitions for `types`, default every R4 resource type; called by `Store`), `storedTypes()`, `PATIENT_COMPARTMENT_PARAMS`. The definitions go into `@medplum/core`'s global index, so a process holds **one type set**: loading again with the same set is a no-op, with another set it throws. Every `Store` in a process uses the same `types`.

## HTTP surface

Every request except `GET /healthz` needs `Authorization: Bearer <token>` (compared in constant time); without it, 401. `GET /healthz` is 200 once the token and the database are open, else 503, and carries no data.

Under `/fhir/R4/`:

- `GET|POST <Type>` (search; `POST <Type>/_search` with a form body); system-level search `GET ?_type=A,B` (or `POST _search`; as Medplum, `<Type>?_type=A,B` is the same search and the last `_type` counts): filters and `_sort` (`_id`, `_lastUpdated`, as Medplum) common to the types, paged by cursor across them; `GET <Type>/<id>`, `PUT <Type>/<id>` (`If-Match` → 412 on another version), `PATCH <Type>/<id>` (JSON Patch, or FHIRPath Patch as a Parameters), `DELETE <Type>/<id>` (`If-Match`); `POST <Type>` (`If-None-Exist`).
- Conditional `PUT <Type>?query`, `PATCH <Type>?query` (JSON Patch) and `DELETE <Type>?query`.
- History: `<Type>/<id>/_history[/<vid>]`, `<Type>/_history`, `_history` (`_count`, `_since`).
- `POST /` batch and transaction bundles (urn rewriting, also with its colons URL-encoded inside strings; conditional references; GET/POST/PUT/PATCH/DELETE entries, a PATCH entry's patch as a base64 JSON Patch `Binary` or a `Parameters` (FHIRPath Patch, or JSON Patch as `op` parts); `POST Binary` entries with base64 `data` (top-level entries; a failed transaction keeps none), a nested bundle as a `POST /` entry).
- `Patient/<id>/$everything` (`_count`, `_offset`, `_since`, `_type`, `start` and `end` by Medplum's care dates); `<Type>/$validate`.
- `Binary`: `POST` and `PUT Binary/<id>` stream the raw body to disk (`Content-Encoding` gzip or deflate decoded), `GET Binary/<id>` streams it back, `DELETE`.
- `GET metadata`: a CapabilityStatement of what this store supports.
- `ETag`, `Last-Modified` and `Location` headers as Medplum sends them; errors are OperationOutcomes. `_pretty=true` indents; `Prefer: return=minimal` sends an empty body.

Search: the common FHIR search features (all parameter types, prefixes, the modifiers `:missing`, `:exact`, `:contains`, `:text`, `:not`, `:identifier` (`subject:identifier=sys|value`), `:of-type` (an Identifier's `typeSystem|typeCode|value`), a uri's `:above` and `:below` (by path segment) and reference type modifiers (`subject:Patient`), composite parameters (`code-value-quantity=http://loinc.org|2093-3$gt200`: one repetition's components, each by its own type), chains and reverse chains (`_has`), mixed and nested up to Medplum's limit of three links, through canonical references and `_compartment` too (a link with several target types names one, `subject:Patient.name`, as Medplum), `_include`/`_revinclude` with `:iterate` (Medplum's limit: 5 rounds, 1000 entries, then 400) and canonical references (resolved by `url`), `_sort`, `_count`, `_elements`, `_summary` (`true`, `data`, `text`, `count`, `false`; on searches only: a read ignores it, as Medplum), `_total`, `_filter`), paged by cursor. Anything unsupported is a 400 OperationOutcome naming it, never a silently wrong answer.

## Deliberate differences from Medplum

- Transactions are all or nothing: a failing entry fails the whole transaction with its status, as Medplum's tests expect with its `transaction-bundles` project feature (without the feature, Medplum keeps the other entries and answers 200 with the failed entry's status).
- A batch or transaction with no entries answers 200 with an empty response Bundle (R4 `Bundle.entry` is 0..*; Medplum refuses it with 400 `Missing bundle entries`).
- A reference to a `urn:uuid`/`urn:oid` no entry defines is 400 (Medplum stores it as written); `urn:oid` fullUrls are rewritten like `urn:uuid`.
- Every urn fullUrl of a transaction is resolved before its entries run (a create or conditional PUT, each on its own: its one match, else a new id). If an earlier entry changes what a later conditional entry matches and another entry references its urn, the transaction is 400 (Medplum fails that entry and leaves references to its urn pointing at no resource); with no reference the entry runs (Medplum still fails it).
- PUT or PATCH of a deleted record is 410 (Medplum brings it back).
- Ids need not be UUIDs (R4 `id`: letters, digits, `-` and `.`, up to 64): `PUT Patient/123` of a missing record is 404 (Medplum refuses a non-UUID id with 400 `Invalid id`).
- Ids are case-sensitive, as R4 defines them: `Patient/<ID IN UPPER CASE>` is another (missing) record (Medplum's uuid column folds case and finds the record).
- A negative `_count` or `_offset` is 400 (Medplum clamps it to its default).
- A conditional request (update, delete, If-None-Exist, conditional reference) needs a real search criterion: only paging, sorting, shaping or format parameters, or empty values, are 400.
- `:contains` and `:exact` on a token parameter are 400: R4 defines them for string parameters only (Medplum accepts both on tokens; `:exact` as plain equality).
- A token search without a modifier matches codes, not a CodeableConcept's `text` (that is `:text`, as R4 defines it; Medplum also matches the text by plain equality).
- `_sort` by a parameter with several values uses the lowest value ascending and the highest descending, for tokens as for dates (Medplum sorts a token both ways by one value; its own test calls this store's order the ideal).
- Date prefixes on ranges follow R4, as Medplum's opt-in `range-search` project feature does: `gt`/`ge`/`lt`/`le` match a Period that overlaps the range above or below the value, and apply to every value of a multi-valued date (Medplum without the feature compares a Period by its start and ignores the prefix on a multi-valued date).
- `eq` with a dateTime against a date never matches: R4 `eq` needs the search value's range to contain the target's, and an instant does not contain a day. Medplum matches the dateTime against the date's day, with or without `range-search`.
- `MeasureReport.period` is a date parameter like any other (Medplum trials overlap ranges there: `eq`/`ne` as overlap, `lt`/`gt` against the far end of the search value).
- `_include`/`_revinclude` and chains (`questionnaire.identifier`, `_has:QuestionnaireResponse:questionnaire:…`) through a versioned canonical (`url|version`) resolve to the resource with that `url` and `version`, as R4 canonicals mean (Medplum resolves `url|version` to nothing, and a `_revinclude` or reverse chain finds only references to the bare `url`).
- `_include`/`_revinclude` naming a parameter that is not a reference is 400, as R4 search.html (Including other resources) defines them on reference parameters (Medplum evaluates it, finds no references and answers 200).
- An invalid `_include`/`_revinclude` parameter is 400 even when nothing matches (Medplum checks it only when there are matches and answers 200 otherwise).
- `POST _search` (form body) is the system-level search, as R4 defines it (Medplum 5.2.14 has no such route and answers 400).
- System-level search pages by cursor, with next links at `fhir/R4?…` (Medplum pages by `_offset` unless sorted by `_lastUpdated` ascending, and its links point at `fhir/R4/MultipleTypes?…` or the path type's URL).
- `_summary=count` (or `_total`) of a `_type` search counts the matches of every listed type (Medplum 5.2.14's count counts one of them).
- `meta.compartment` holds Patient compartments only: the store has no projects, so `_compartment:missing=true` finds a record in no patient's compartment (as Medplum's own test expects outside a project; inside a Medplum project every record is also in `Project/<id>`'s compartment, so there it finds none); Medplum's `meta.accounts` add no compartment.
- `:of-type` and composite parameters (`code-value-quantity=…$gt200`) work as R4 defines them (Medplum 5.2.14 refuses both with 400: `Invalid modifier :of-type`, `Unrecognized search parameter type: composite`). R4's `DocumentReference-relationship` gives each component the other's expression; the store pairs `relatesto` with `target` and `relation` with `code`, as R5 fixed it. ResearchStudy's `progress-status-*` composites name components R4 does not define: 400.
- A uri's `:below` matches the value and every uri under it by path segment, `:above` the value and every uri it is under (Medplum ignores both modifiers and matches the value only).
- `:identifier` applies to reference parameters only, `:of-type` to tokens on an Identifier, `:above`/`:below` to uris (token `:above`/`:below` are terminology, below): elsewhere 400 (Medplum ignores `:identifier`, `:above`, `:of-type` on strings and references, and `:contains`, `:of-type` on uris, and answers 200).
- No `_deleted` parameter: the store keeps no deleted records (Medplum's soft delete), so `_deleted` is an unknown parameter (400).
- No login, users, projects or access policies: one bearer token; meant for loopback or a private network only, not as a public FHIR server.

## Next phase: full FHIR spec support

Not supported yet; each answers with an error (400, or 404/405 for an unknown route) and an OperationOutcome naming it:

- Special search parameters; on tokens the modifiers `:above`, `:below`, `:in`, `:not-in` (terminology).
- Date search values below day precision (`2024`, `2024-05`) and comma lists of dates (400, as Medplum without its `range-search` project feature).
- `_contained`, `_text`, `_content`, and `_include=*` (Medplum 5.2.14 refuses it too; plan 4 decides).
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
