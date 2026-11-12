# Gannet: a FHIR store on SQLite

A FHIR R4 record store in one SQLite file (`node:sqlite`, WAL), with binaries as files beside it. Resources stay FHIR JSON; each one is indexed by evaluating its type's official SearchParameters (FHIRPath, via `@medplum/core`), and FHIR search is SQL over that index. One process owns the file and serves it over local HTTP in Medplum's REST shape, so a `MedplumClient` in another process reads and writes it. Used by GA.

This directory is the whole store, code and tests (`test/`): its files import only Node built-ins, the packages below and each other. `test/boundary.test.ts` enforces that, so the directory can become its own repository as is (see [Tests](#tests)).

## Requirements

- Node >= 26 (`node:sqlite`; TypeScript runs as-is through Node's type stripping, no build step).
- `@medplum/core` 5.2.14, `@medplum/definitions` 5.2.14, `@medplum/fhirtypes` 5.2.14 (types only), `graphql` 17.0.2 (`$graphql`, Medplum's version). Tests: `vitest` 5.1.0.
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

- `serveStore(opts: ServeOptions): Promise<http.Server>` with `ServeOptions = { file; host?; port; tokenFile; maxBinaryBytes?; types?; terminology?; graphqlIntrospection? }` (`graphqlIntrospection`: `$graphql` answers schema queries; off by default, as Medplum). Listens, then opens the token file and the database; the server's `close` closes the database.
- `storeToken(file): string`: the token file's contents (created as above if missing).
- `JSON_LIMIT`, `DEFAULT_BINARY_LIMIT`.

From `serve.ts`: `runStore(opts)` (serve, handle signals, log one line) and `parseServeArgs(argv)`; an embedding app calls `runStore` with its own options.

From `store.ts`, for in-process use (one `Store` per file, in the owning process only):

- `new Store(file, { types?, terminology? })` (`terminology`: the built-in bundle files to seed, default `@medplum/definitions`' `TERMINOLOGY_BUNDLE_FILES`, `[]` none; see [Terminology](#terminology)); `close()`; `db` (the `DatabaseSync`).
- `create(resource, ifNoneExist?, id?)` (`id`: a pre-assigned id, as a transaction gives a urn entry), `update(resource, ifMatch?)`, `delete(type, id, ifMatch?)`, `read(type, id)`, `readRow(type, id)`, `version(type, id, versionId)`, `history({ type?, id?, since?, count?, offset? })`, `find(type, query)`, `validate(resource)`.
- `search(type, query, base)` / `searchJson(...)`: a searchset Bundle (object or JSON text); `type` an array of types: a system-level search across them.
- `put(resource, { history? })`: import keeping the given id, versionId and lastUpdated (for migrations).
- Binaries: `putBinaryStream(contentType, data, id?, replace?)`, `openBinary(id)`, `deleteBinary(id)`.
- `StoreError` (an `OperationOutcomeError` with an HTTP `status`), `INDEX_VERSION` (the on-disk index format) and `IndexFormatError` (thrown by the constructor for a file in another format: rebuild it from its source; the format is 5 since the concept index and built-in terminology, so a file from an earlier version must be rebuilt).

From `terminology.ts`: `findTerminology(store, type, url, version?)` (the CodeSystem, ValueSet or ConceptMap an operation uses: `url|version` honoured, retired skipped, stored before built-in, then content, version, date, id; else 400 `<type> <url> not found`), `parentProperty(cs)`, `indexCodeSystem`, `importCodeSystem`, `dropCodeSystem`, `seedTerminology`, `isBuiltin`, `hierarchy(dir, rid, prop, code)` (the is-a walk as a recursive CTE). From `expand.ts`: `expandValueSet(store, valueSet, options)`, `inValueSet(store, url)` and `subsumedCodes(store, system, code, 'below' | 'above')` (SQL subqueries of a ValueSet's `(system, code)` membership and of the codes under or over a code, for search; 400 naming a url the store does not hold, or a CodeSystem it holds only as a stub with no concepts, such as the seeded SNOMED CT and LOINC: never an empty match).

From `definitions.ts`: `loadDefinitions(types?)` (indexes the FHIR definitions for `types`, default every R4 resource type; called by `Store`), `storedTypes()`, `PATIENT_COMPARTMENT_PARAMS`. The definitions go into `@medplum/core`'s global index, so a process holds **one type set**: loading again with the same set is a no-op, with another set it throws. Every `Store` in a process uses the same `types`.

## HTTP surface

Every request except `GET /healthz` needs `Authorization: Bearer <token>` (compared in constant time); without it, 401. `GET /healthz` is 200 once the token and the database are open, else 503, and carries no data.

Under `/fhir/R4/`:

- `GET|POST <Type>` (search; `POST <Type>/_search` with a form body); system-level search `GET ?_type=A,B` (or `POST _search`; as Medplum, `<Type>?_type=A,B` is the same search and the last `_type` counts): filters and `_sort` (`_id`, `_lastUpdated`, as Medplum) common to the types, paged by cursor across them; `GET <Type>/<id>`, `PUT <Type>/<id>` (`If-Match` → 412 on another version), `PATCH <Type>/<id>` (JSON Patch, or FHIRPath Patch as a Parameters), `DELETE <Type>/<id>` (`If-Match`); `POST <Type>` (`If-None-Exist`).
- Conditional `PUT <Type>?query`, `PATCH <Type>?query` (JSON Patch) and `DELETE <Type>?query`.
- History: `<Type>/<id>/_history[/<vid>]`, `<Type>/_history`, `_history` (`_count`, `_since`).
- `POST /` batch and transaction bundles (urn rewriting, also with its colons URL-encoded inside strings; conditional references; GET/POST/PUT/PATCH/DELETE entries, a PATCH entry's patch as a base64 JSON Patch `Binary` or a `Parameters` (FHIRPath Patch, or JSON Patch as `op` parts); `POST Binary` entries with base64 `data` (top-level entries; a failed transaction or a batch refused as a whole keeps none), a nested bundle as a `POST /` entry).
- `Patient/<id>/$everything` (`_count`, `_offset`, `_since`, `_type`, `start` and `end` by Medplum's care dates); `<Type>/$validate`.
- `POST $graphql` (`graphql.ts`, `graphql-types.ts`, ported from Medplum 5.2.14's `fhir-router` GraphQL): `{ query, operationName?, variables? }`; read by id (`Patient(id:)`) and search (`PatientList(...)`, every search parameter with `-` as `_`, `_count` at most 1000, `_sort`, `_filter`, `_cursor`) over the store's own types, each read and search a request through the REST path. A 200 is the GraphQL result as `application/json` (a missing read is `null` with its error, as Medplum); a Reference's `resource` (read once per query; `null` with a `Not found` error for a contained, absolute or missing reference, or a type the store does not hold, as Medplum's server), reverse lookups (`ObservationList(_reference: subject)`, `ObservationConnection(...)`), list-field arguments (`_count`, `_offset`, `fhirpath`, an element's string property such as `use` or `url`) and the Connection API (`PatientConnection`: `count`, `offset`, `pageSize`, `edges`, `next` as a `_cursor`); mutations (`mutation { PatientCreate(res:) … }`, `PatientUpdate(id:, res:)`, `PatientPatch(id:, patch: [{ op, path, value }])`, `PatientDelete(id:)`), each a REST write, so validated as REST (its OperationOutcome text is the field's error; `Invalid resourceType` or `Invalid ID` when `res` names another type or id, as Medplum; `res` has no `contained`, as Medplum), and a later read of that record in the same request sees the write; a `contained` resource of a type the store does not hold is a field error (`Abstract type "ResourceList" was resolved to a type "<Type>" that does not exist inside the schema.`: the list is `null`, the rest of the result stands); a missing query, a syntax error or a validation error (a type the store does not hold) is 400, a schema query (`__schema`, `__type`) with introspection off 403, each an OperationOutcome. The schema is built on the first request. Also a batch entry. `GET $graphql` is 400 `Unknown resource type`, as Medplum.
- `Binary`: `POST` and `PUT Binary/<id>` stream the raw body to disk (`Content-Encoding` gzip or deflate decoded), `GET Binary/<id>` streams it back, `DELETE`.
- `GET metadata`: a CapabilityStatement of what this store supports.
- Writes drop empty values (`identifier: []`, `display: ''`), as Medplum; an empty array item (`''` or `{}`) is 400, as Medplum (R4 JSON has no empty values).
- `ETag`, `Last-Modified` and `Location` headers as Medplum sends them; errors are OperationOutcomes. `_pretty=true` indents; `Prefer: return=minimal` sends an empty body.

Search: the common FHIR search features (all parameter types, prefixes, the modifiers `:missing`, `:exact`, `:contains`, `:text`, `:not`, `:identifier` (`subject:identifier=sys|value`), `:of-type` (an Identifier's `typeSystem|typeCode|value`), a token's `:in` and `:not-in` (a ValueSet's url, or `ValueSet/<id>`) and `:above` and `:below` (`system|code`, by the CodeSystem's is-a hierarchy), a uri's `:above` and `:below` (by path segment) and reference type modifiers (`subject:Patient`), composite parameters (`code-value-quantity=http://loinc.org|2093-3$gt200`: one repetition's components, each by its own type), chains and reverse chains (`_has`), mixed and nested up to Medplum's limit of three links, through canonical references and `_compartment` too (a link with several target types names one, `subject:Patient.name`, as Medplum), `_include`/`_revinclude` with `:iterate` (Medplum's limit: 5 rounds, 1000 entries, then 400) and canonical references (resolved by `url`), `_sort`, `_count`, `_elements`, `_summary` (`true`, `data`, `text`, `count`, `false`; on searches only: a read ignores it, as Medplum), `_total`, `_filter`, with `ss`, `sb`, `in` and `ni` on tokens), paged by cursor (`_offset` at most 10000, Medplum's default, else 400). Anything unsupported is a 400 OperationOutcome naming it, never a silently wrong answer.

## Terminology

- Every stored CodeSystem with `content` `complete`, `example` or `fragment` has its concepts indexed on write (tables `coding`, `coding_property`, `codesystem_property`, as Medplum's): one row per code, a synonym row per designation, a `parent` property row per nested concept; an update replaces them, a delete removes them. A concept property the CodeSystem does not declare is 400 `Unknown property: <code>` (Medplum's text).
- Built-in terminology: a store whose types include `CodeSystem` or `ValueSet` seeds Medplum's terminology bundles (1108 CodeSystems, 1346 ValueSets; a later entry with the same url replaces an earlier one, as Medplum) once, on open, in one transaction (about 4 s and 24 MB of file). The `meta` table's `terminology` row holds the `@medplum/definitions` version seeded; another version reseeds. Built-ins have stable ids (from type, url and version), show in search and read, have no history rows (Medplum keeps one per built-in; the store does not double the seed's size, so `_history` of a built-in is empty), and any write to them is 403 `Forbidden`, as Medplum answers for its R4 project.
- Memory: seeding adds about 62-69 MiB to the peak RSS (108-114 MiB worst seen) over reopening a seeded file; an all-types store's floor is already about 292 MiB, so the 220 MiB budget applies only to a type set without CodeSystem and ValueSet, which never seeds. `src/store/test/terminology-memory.test.ts` asserts the increment is at most 128 MiB; numbers and method in `docs/superpowers/spikes/2026-11-11-store-terminology-memory.md` of the host repository.
- Operations: `CodeSystem/$lookup`, `CodeSystem/$validate-code` and `CodeSystem/$subsumes` (GET or POST, type or instance level; the CodeSystem is chosen as `findTerminology` orders them), and Medplum's `CodeSystem/$import` (POST: concepts, properties and designations into a stored CodeSystem by id or `system`; into a built-in is 403 `Forbidden`). An update of a CodeSystem whose `content` is not indexed keeps its imported concepts, as Medplum.
- `ValueSet/$expand` (GET or POST; by `url`, inline `valueSet`, or instance level) and `ValueSet/$validate-code` (type or instance level), ported from Medplum: includes of whole CodeSystems, enumerated concepts, filters `is-a`, `descendent-of`, `is-not-a`, `=`, `in`, `exists`, `regex`, nested ValueSets and stored expansions; Medplum's text filter (code prefix, every word in the accent-folded display, under 3 characters the exact code only), its order (exact code, then pg_trgm `strict_word_similarity` of the display, then the code in Medplum's collation), its paging (`count`, default 10 with a filter; `offset` per include; at most 1000 codes, so a larger `count` fetches no more than 1001 rows per include; `total` counts the codes fetched, as Medplum), `displayLanguage`, `includeDesignations` and `excludeNotForUI`. Each include is one SQL query with its limit and offset. An expansion without a text filter lists codes in CodeSystem order, a hierarchy breadth-first (see Deliberate differences).
- ConceptMap (`conceptmap.ts`): every stored ConceptMap's `group[].element[].target[]` is indexed on write (table `concept_mapping`, as Medplum's `ConceptMapping`, a mapping's `dependsOn`, `product` and `property` entries in its `attributes` column; an element without a code is skipped). `ConceptMap/$translate` (GET or POST, type or instance level; the map by id, `url`, or `source`, the newest version; `system`+`code`, `coding` or `codeableConcept`; `targetsystem`; a group's `unmapped` `provided`, `fixed` or `other-map`) and Medplum's `ConceptMap/$import` (POST: mappings into a stored ConceptMap by id or `url`, in one transaction; the answer is the ConceptMap), ported from Medplum. Exported: `indexConceptMap(db, rid, cm)`, `translate(store, p)`, `importConceptMap(store, p)`.

## Deliberate differences from Medplum

- `$graphql` builds its schema from the store's own types (every type on an all-types store, GA's list on ga-store): a field for a type the store does not hold is a 400 validation error, not Medplum's schema with every R4 type. The schema is kept per type list and built on the first request.
- A `$graphql` mutation with several fields is not atomic: in a transaction entry, the writes of earlier fields are kept when a later field fails, because field errors still answer 200 (as Medplum). Mutation fields cost 0 in the cost rule (as Medplum), so a query of thousands of aliased creates passes it.
- Not ported from Medplum's GraphQL: per-project settings (`graphqlMaxDepth`, `graphqlMaxSearches`, `graphqlBatchedSearchSize`; the limits are fixed), access policies, the cache of introspection results (`shortcut: no introspection result cache`), and DataLoader (a per-request read cache replaces it).
- `$graphql` reverse lookups (`<Type>List(_reference: …)`, `<Type>Connection(_reference: …)`) leave out `_compartment` and the R4 search parameters whose target is every resource type (`Provenance.target`, `List.item`, `Task.focus`, `Observation.focus`, …): with them every pair of types gets two fields carrying the child's search arguments, about 400 MiB more for the schema on a store with every type (Medplum's schema has them). Such a field is a 400 validation error; search by that parameter instead (`ProvenanceList(target: "Patient/<id>")`).
- `$graphql` refuses a query deeper than 12 fields (`Field "<name>" exceeds max depth (depth=<n>, max=12)`; introspection fields don't count) or costing over 10,000 (`Query too complex`; Medplum's cost rule, also counting `*Connection` searches and a `_count` given as a variable), with 400 before anything runs: resolvers block the event loop. Medplum 5.2.14 only logs both, with those texts commented out. A search's `_count` is costed between 0 and 1000 (a literal, a sent variable, or the variable's default); fan-out through a list that is not a search (`contained`, a Bundle's entries) is costed at factor 1, as in Medplum's formula.
- `$graphql` refuses a query over 1000 tokens with 400 `GraphQL syntax error.` (Medplum has no token limit): graphql-js's overlapping-fields validation is quadratic in same-name fields, and the store answers requests one at a time, so 2,000 copies of one field (44 KB) would block it for about a minute. The largest query in the ported tests is 188 tokens, the standard introspection query 163.
- A concept's synonyms and designations are unique by code, text, language and canonical row; Medplum's key leaves out the language, so a translation whose text equals another language's (French "Patient") is dropped there and kept here (62 rows of the seeded terminology).
- Transactions are all or nothing: a failing entry fails the whole transaction with its status, as Medplum's tests expect with its `transaction-bundles` project feature (without the feature, Medplum keeps the other entries and answers 200 with the failed entry's status).
- An unexpected error in a batch entry answers that entry 500 `Internal error` (Medplum answers it 400 with the error's text); the batch's other entries stand.
- A batch or transaction with no entries answers 200 with an empty response Bundle (R4 `Bundle.entry` is 0..*; Medplum refuses it with 400 `Missing bundle entries`).
- A reference to a `urn:uuid`/`urn:oid` no entry defines is 400 (Medplum stores it as written); `urn:oid` fullUrls are rewritten like `urn:uuid`.
- Every urn fullUrl of a transaction is resolved before its entries run (a create or conditional PUT, each on its own: its one match, else a new id). If an earlier entry changes what a later conditional entry matches and another entry references its urn, the transaction is 400 (Medplum fails that entry and leaves references to its urn pointing at no resource); with no reference the entry runs (Medplum still fails it).
- PUT or PATCH of a deleted record is 410 (Medplum brings it back).
- Ids need not be UUIDs (R4 `id`: letters, digits, `-` and `.`, up to 64): `PUT Patient/123` of a missing record is 404 (Medplum refuses a non-UUID id with 400 `Invalid id`).
- Ids are case-sensitive, as R4 defines them: `Patient/<ID IN UPPER CASE>` is another (missing) record (Medplum's uuid column folds case and finds the record).
- A search whose value list is too long for one SQLite statement (about 1,000 comma values on one parameter, or `_filter` terms) is 400 `Search has too many values` (Medplum runs it).
- A negative `_count` or `_offset` is 400 (Medplum clamps it to its default).
- A conditional request (update, delete, If-None-Exist, conditional reference) needs a real search criterion: only paging, sorting, shaping or format parameters, or empty values, are 400.
- `:contains` and `:exact` on a token parameter are 400: R4 defines them for string parameters only (Medplum accepts both on tokens; `:exact` as plain equality).
- A token search without a modifier matches codes, not a CodeableConcept's `text` (that is `:text`, as R4 defines it; Medplum also matches the text by plain equality).
- `_sort` by a parameter with several values uses the lowest value ascending and the highest descending, for tokens as for dates (Medplum sorts a token both ways by one value; its own test calls this store's order the ideal).
- Date prefixes on ranges follow R4, as Medplum's opt-in `range-search` project feature does: `gt`/`ge`/`lt`/`le` match a Period that overlaps the range above or below the value, and apply to every value of a multi-valued date (Medplum without the feature compares a Period by its start and ignores the prefix on a multi-valued date).
- `eq` with a dateTime against a date never matches: R4 `eq` needs the search value's range to contain the target's, and an instant does not contain a day. Medplum matches the dateTime against the date's day, with or without `range-search`.
- `ap` on a date matches a date whose range overlaps the search value's, with no tolerance (R4 lists `ap` among the date prefixes and leaves the approximation to the server, suggesting about 10% of the gap to now), as a prefix and in `_filter` (Medplum 5.2.14 refuses it on dates with 400 `Unknown FHIR operator: ap`).
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
- `:identifier` applies to reference parameters only, `:of-type` to tokens on an Identifier, `:above`/`:below` to uris and tokens (on a token, terminology: below): elsewhere 400 (Medplum ignores `:identifier`, `:above`, `:of-type` on strings and references, and `:contains`, `:of-type` on uris, and answers 200).
- Token `:in`, `:not-in`, `:above` and `:below`, and `_filter` `in`, `ni`, `ss` and `sb`, work as R4 defines them, over the CodeSystems and ValueSets the store holds, built-in or stored (Medplum 5.2.14 refuses the modifiers with 400 `Invalid modifier :in for clinical-code`, and its `_filter` parser `ss` and `sb` with `Invalid operator: ss`). `:not-in` and `ni` match a record with no code in the ValueSet, as `:not` does. A url the store does not hold is 400 naming it (`ValueSet <url> not found`), never an exact match; `:above`/`:below` need `system|code` and a CodeSystem with an is-a hierarchy, else 400. `:in` and `:not-in` also take a relative `ValueSet/<id>` (R4 allows a relative or absolute uri). `_filter` `ss` and `sb` apply to tokens only, at the end of a chain too (a uri's path `:above`/`:below` is not subsumption): elsewhere 400 `Invalid operator: ss`, as Medplum.
- A terminology operation's `url|version` (`system`, `url`) selects that version, as an R4 canonical means (Medplum 5.2.14 drops the `|version` and uses the newest version; its `$lookup` then answers 404).
- R4 inputs the CodeSystem operations do not implement are 400 `<operation>: parameter <name> is not supported` (Medplum ignores them): `$lookup` `date`, `displayLanguage`, `property`; `$validate-code` `codeSystem`, `codeableConcept`, `date`, `abstract`, `display`; `$subsumes` `codingA`, `codingB`.
- `CodeSystem/$import` with a `system` that names a built-in (and no stored CodeSystem) is 403 `Forbidden`, as by id (Medplum finds only the project's own CodeSystems by url and answers 400 `CodeSystem <url> not found`).
- `$expand` and ValueSet `$validate-code` honour `compose.exclude` (Medplum ignores it), search a nested ValueSet in `$validate-code` (Medplum answers 400 `Missing system URL for ValueSet include`), and expand at instance level, `ValueSet/<id>/$expand` (Medplum: 404). A ValueSet that includes itself through others is 400 `Recursive ValueSet definition: <url>` (Medplum recurses without end).
- ValueSet filters `is-not-a` (the CodeSystem's codes outside the value's is-a set; without an is-a hierarchy, all but the code) and `regex` (the code or property value matches the whole pattern, in JavaScript's regex dialect; a pattern over 256 characters, unbalanced, or with a quantified group holding a quantifier such as `(a+)+` is 400; a `(` or `)` inside a character class counts as no group) work (Medplum 5.2.14 expands an include using either to no codes, so the built-ins patient-contactrelationship and iso3166-1-3 are empty there). Any other op than these, `is-a`, `descendent-of`, `=`, `in` and `exists` is 400 `ValueSet filter op <op> is not supported` (Medplum: no codes); `exists` also works in `$validate-code` (Medplum: no match).
- An expansion that walks a hierarchy without a text filter lists codes breadth-first in CodeSystem order, the same on every request, and `offset` windows of one `count` partition it. Medplum has no ORDER BY there: from the fourth level its order follows its Postgres plan (a level's parents in code order). R4 leaves expansion order open; the store keeps the `union` walk that ends on cycles.
- R4 inputs `$expand` and ValueSet `$validate-code` do not implement are 400 `<operation>: parameter <name> is not supported` (Medplum ignores them): `$expand` `valueSetVersion`, `context`, `contextDirection`, `date`, `designation`, `includeDefinition`, `activeOnly`, `excludeNested`, `excludePostCoordinated`, `exclude-system`, `system-version`, `check-system-version`, `force-system-version`; `$validate-code` `context`, `valueSet`, `valueSetVersion`, `systemVersion`, `date`, `abstract`, `displayLanguage`.
- An update of a ConceptMap replaces only its inline mappings: what `ConceptMap/$import` wrote stays (Medplum's update of a map with groups drops every mapping, imported ones included).
- R4 inputs `$translate` does not implement are 400 `$translate: parameter <name> is not supported` (Medplum ignores them): `conceptMap`, `conceptMapVersion`, `version`, `target`, `dependency`, `reverse`. An `unmapped` `other-map` chain that comes back to a map on its own chain is 400 (Medplum follows it again, without end).
- An operation's POST body must be a `Parameters` (400 `Expected a Parameters`); Medplum also reads a plain JSON object of parameter names.
- No `_deleted` parameter: the store keeps no deleted records (Medplum's soft delete), so `_deleted` is an unknown parameter (400).
- No login, users, projects or access policies: one bearer token; meant for loopback or a private network only, not as a public FHIR server.

## Next phase: full FHIR spec support

Not supported yet; each answers with an error (400, or 404/405 for an unknown route) and an OperationOutcome naming it. Plan 4 owns the rest:

- Plan 4 decides: `_text`, `_content`, `_contained`, special search parameters, `_include=*` (Medplum 5.2.14 refuses it too), `_filter` operators `ew` and `po` (Medplum's parser refuses both: `Invalid operator: ew`), Binary as FHIR JSON and its history, date search values below day precision (`2024`, `2024-05`) and comma lists of dates (400, as Medplum without its `range-search` project feature), and every other operation besides `$validate` and `Patient/$everything` (`$export`, `$graph`, `$match`, `Appointment/$book`, ... : the host repository's parity inventory of Medplum's tests lists them).
- FHIR R4 only (the definitions ship R4); one patient-compartment definition (Patient).

Supported but slow on large results: `_sort` by a parameter that is not a date, `_id` or `_lastUpdated` aggregates index rows per candidate instead of walking a sort index.

## Tests

`test/*.test.ts` (vitest) test the store alone, against temp files, from this directory: in a host repository add `<this dir>/test/**/*.test.ts` to vitest's include.

As its own repository, with history: `git subtree split --prefix=src/store -b fhir-store` in the host repository, then clone that branch. Add:

`package.json`
```json
{
  "name": "gannet",
  "private": true,
  "type": "module",
  "engines": { "node": ">=26" },
  "scripts": { "start": "node serve.ts", "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@medplum/core": "5.2.14", "@medplum/definitions": "5.2.14", "@medplum/fhirtypes": "5.2.14", "graphql": "17.0.2" },
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
