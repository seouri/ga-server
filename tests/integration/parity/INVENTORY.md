# Medplum 5.2.14 record tests in scope

One row per Medplum test (a `test.each` counts once, by its title template). Columns: file (path below `packages/`), title (describe path joined with " › "), status, feature, note.

- status: `ported` (a parity test titled `<title> [<file>]` exists), `skipped` (note says why), `plan-2` (terminology, all triaged by Task 1 of plan 2; none left), (`plan-3` is no longer used: all GraphQL rows are triaged).
- feature: `existing`, `summary`, `type`, `include`, `chain`, `modifier`, `composite`, `filter`, `meta`, `terminology`, `graphql`, `platform`.
- A note `not yet ported (Task N)` names the task that ports the row; the last task fails any row still carrying it.
- `tests/parity-inventory.test.ts` checks this file against the parity tests.

| file | title | status | feature | note |
| --- | --- | --- | --- | --- |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search total | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search count=0 | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search offset max | ported | existing | at Medplum's default maxSearchOffset (10000): its test sets 200 in-process |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › clampEstimateCount: offset = %p, %p estimated, %p returned => %p | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › returns estimate and accurate with forceAccurate | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › returns estimate without forceAccurate when below threshold | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › returns only estimate when above threshold | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › uses rowCount option for clamping | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › short-circuits when rowCount <= pageSize | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › short-circuits with offset when rowCount <= pageSize | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › short-circuits with explicit count when rowCount <= count | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › short-circuits when rowCount is 0 and no offset | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › does not short-circuit when rowCount is 0 with offset | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › does not short-circuit when forceAccurate is set | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › does not short-circuit when cursor is present | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › does not short-circuit when rowCount > pageSize | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › getCount › does not short-circuit when rowCount is undefined | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search _summary | ported | summary |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search _elements | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search next link | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search previous link | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for Communications by Encounter | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for Communications by ServiceRequest | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for QuestionnaireResponse by Questionnaire | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for token in array | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.id | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.meta.lastUpdated | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.identifier | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.name | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.given | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.address | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.postalCode | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.telecom | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.email | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.birthDate | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter and sort on same search parameter | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search birthDate after delete | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search identifier after delete | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › String filter | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › String filter with escaped commas | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by _id | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by _id with %s=%s | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by _compartment presence | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by chained _id | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by chained _id presence | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse filter by chained _id | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse filter by _compartment:_id | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Forward filter by _compartment.name | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained filter with _compartment as middle link | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Empty _id | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Non UUID _id | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Non UUID _compartment | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference string _compartment | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Handle_lastUpdated value %s, isValid? %s | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Handle non-string value | skipped | platform | repository API only: an object filter value; HTTP query values are always strings |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Handle string with null bytes | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by Coding | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by CodeableConcept | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by Quantity.value | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › ServiceRequest.orderDetail search | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Comma separated value | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token not equals | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token not equals matches missing value | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token array not equals | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Null token array not equals | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Missing | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Missing with logical (identifier) references | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Starts after | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Boolean search | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Boolean not equals matches missing value | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Not equals with comma separated values | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _id equals with comma separated values | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Error on invalid search parameter | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Patient search without resource type | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Subject search without resource type | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search on array columns using reference tables | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search on single columns using reference tables | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search sort order | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search with negated filter | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search on canonical reference | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Rejects too long chained search | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › disableChainedSearch › Rejects chained search through disabled type: %s | skipped | platform | disableChainedSearch (Medplum config) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › disableChainedSearch › Allows chained search not using disabled reference table: %s | skipped | platform | disableChainedSearch (Medplum config) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › disableChainedSearch › Chained search works again after reindex | skipped | platform | disableChainedSearch (Medplum config) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Invalid chained search parameters: %s | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search with modifier | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search deduplication | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token search deduplication | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include references success | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include canonical success | ported | include |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include PlanDefinition mixed types | ported | include |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include references invalid search param | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse include Provenance | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse include canonical | ported | include |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse include on denied type | skipped | platform | access policy |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search through denied type | skipped | platform | access policy |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include:iterate | ported | include |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include with target type | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _revinclude with target type | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _revinclude:iterate | ported | include |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include depth limit | ported | include |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include on empty search results | ported | include |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include on page boundary | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include with invalid reference | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › DiagnosticReport category with system | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Encounter.period date search | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Encounter.period dateTime search | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Condition.code system search | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Condition.code :not next URL | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference identifier search | ported | modifier |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Task patient identifier search | ported | modifier |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by dedicated token column search parameter, identifier | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by a shared token column search param, _security | ported | meta |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by _source | ported | meta |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by _tag | ported | meta |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token :text search | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › birthdate covers all hours: %d (%s) | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › birthdate with multiple values | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter search | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter eq | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter with UUID value | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter birthdate eq | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter ne | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter re | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter with reverse chained search | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter sw | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter with chained search | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › reverse chain with prefix modifier | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Lookup table exact match with comma disjunction | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Duplicate rows from token lookup | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter Task by due-date › with %s %s | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter Task by due-date › multiple resources | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Get estimated count with filter on human name | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Organization by name | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Ambiguous search columns | skipped | platform | Medplum-only resource types (ProjectMembership, User) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Practitioner by email is case insensitive | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Practitioner by identifier is case sensitive | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Patient by name with stop word | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Sort by ID | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Numeric parameter | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Disjunction with lookup tables | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Sort by unknown search parameter | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Date range search | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Multiple resource types with _type | ported | type |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Multiple resource types with _type uses offset pagination across combined results | ported | type |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Binary search not allowed | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreCareTeamRole | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreConditionAssertedDate | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreEncounterDischargeDisposition | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreGoalDescription | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCorePatient race, ethnicity, genderIdentity | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search patterns | ported | filter |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search with inline resource | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Basic reference | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Reference values with special characters | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Array reference column | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Invalid reference field | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Reference with sort | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › narrowed fields | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Multiple types | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Error on cursor and offset | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Cursor pagination | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Cursor pagination dedupes across page boundaries | skipped | platform | needs a client-set meta.lastUpdated (ties across a page boundary), which an HTTP create does not keep |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Cursor pagination with multiple resource types from _type | ported | type |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › V1 cursor is not parsed as V2 | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param: bare uuid matches (DeviceRequest.encounter) | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param: bare uuid matches (PractitionerRole.practitioner) | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param on array column: bare uuid matches (Encounter.location) | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Back-compat: bare uuid on multi-target subject column still defaults to Patient | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Non-uuid bare value is not rewritten (avoids corrupting unrelated values) | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Quantity search › Basic | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Quantity search › With units | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Quantity search › Approximately | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Invalid canonical chained search link | ported | chain |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Date array columns match search value %s | ported | existing |  |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › discourage sequential scans › config.fhirSearchDiscourageSeqScan | skipped | platform | SQL planner internals (discourage sequential scans) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › discourage sequential scans › config.fhirSearchMinLimit | skipped | platform | SQL planner internals (discourage sequential scans) |
| server/src/fhir/search.test.ts | systemRepo › Filter by _project | skipped | platform | systemRepo _project |
| server/src/fhir/search.test.ts | systemRepo › Sort by _project; desc=%s | skipped | platform | systemRepo _project |
| server/src/fhir/search.test.ts | systemRepo › Filter by _lastUpdated | ported | existing |  |
| server/src/fhir/search.test.ts | systemRepo › Sort by _lastUpdated | ported | existing |  |
| server/src/fhir/search.test.ts | systemRepo › Should calculate count with join | skipped | platform | getCount / SQL shape |
| server/src/fhir/search.test.ts | systemRepo › maxResourceVersion | skipped | platform | maxResourceVersion (Medplum internal) |
| server/src/fhir/search.test.ts | systemRepo › Search for deleted resources | skipped | platform | _deleted is a Medplum-only search parameter |
| server/src/fhir/search.test.ts | systemRepo › Reverse chained search with _filter | ported | filter |  |
| server/src/fhir/search.test.ts | systemRepo › invalid operators and modifiers › Reject invalid operator or modifier for %s | ported | modifier |  |
| server/src/fhir/search.test.ts | parseChainedParameter › reverse chained search with prefix operators | skipped | platform | parseChainedParameter unit test |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by Appointment.end | ported | existing |  |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by Slot.end | ported | existing |  |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by DiagnosticReport.study | ported | existing |  |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by Flag.category | ported | existing |  |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by AsyncJob.type and AsyncJob.status | skipped | platform | Medplum-only resource type / project |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for Practitioner by qualification-code | ported | existing |  |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for PractitionerRole by network | ported | existing |  |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for Login by project | skipped | platform | Medplum-only resource type / project |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for CoverageEligibilityRequest by coverage | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch success | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › FHIRPath Patch in batch | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction success | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction rollback | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Create batch wrong content type | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional create in transaction | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional update in transaction | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction bundle with ifMatch version checking | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction bundle with ifMatch fails on version mismatch | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch FHIRPath PATCH with stale ifMatch fails and does not modify resource | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch DELETE with ifMatch | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch FHIRPath PATCH with current ifMatch succeeds and persists | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction PATCH with stale ifMatch rolls back the whole transaction | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional update (create-as-update) in transaction | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Resolved intra-Bundle reference cycle with referential integrity validation | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Failed referential integrity check in transaction Bundle | skipped | platform | Medplum checkReferencesOnWrite project setting (the store does not check that references resolve) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional reference resolution | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Process batch create ifNoneExist invalid resource type | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch create as update with client-assigned ID | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Repeated batch of related upserts | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch does not retry on failure | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch resumes after graceful shutdown | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch makes partial results available when cancelled | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction bundle account propagation | skipped | platform | project/account compartments |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Nested transaction in batch | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › _include regression test | ported | existing |  |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Rate limited during batch execution | skipped | platform | rate limits |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch sleeps over rate limit | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Transaction bundle SERIALIZABLE retry › does not silently drop writes on serialization failure | skipped | platform | Medplum database isolation internals |
| server/src/fhir/repo.test.ts | FHIR Repo › getRepoForLogin | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Enterprise access is limited to super admins | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › setMode routes reads to reader until writer promotion › on creates | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › setMode routes reads to reader until writer promotion › on updates | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › getSearchProjectIds | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Read resource with undefined id | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Read resource with blank id | skipped | platform | over HTTP an empty id is the type search (Patient/), not a read |
| server/src/fhir/repo.test.ts | FHIR Repo › Read resource with invalid id | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Read Binary requires access to securityContext | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Write Binary rejects Binary securityContext | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Read invalid resource with `checkCacheOnly` set | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Read AuditEvent after update | skipped | platform | Medplum AuditEvent logging |
| server/src/fhir/repo.test.ts | FHIR Repo › Does not cache reads from the reader | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Only caches on read when cacheResourcesOnWrite is disabled | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Repo read malformed reference | skipped | platform | readReference is the repository API (the reference is parsed in-process); no HTTP route |
| server/src/fhir/repo.test.ts | FHIR Repo › Read references with various reference shapes | skipped | platform | readReferences is the repository API (the reference is parsed in-process); no HTTP route |
| server/src/fhir/repo.test.ts | FHIR Repo › Logs mixed cache access for readReferences across split resource types | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Logs mixed SQL access for multi-type search across split resource types | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Includes numResults in search AuditEvent entity detail | skipped | platform | Medplum AuditEvent logging |
| server/src/fhir/repo.test.ts | FHIR Repo › Logs mixed transaction access across repo and system repo | skipped | platform | Medplum logging |
| server/src/fhir/repo.test.ts | FHIR Repo › Read history › options: %s | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Read history › with config.maxSearchOffset | skipped | platform | Medplum server config (maxSearchOffset) set in-process; the HTTP side cannot change it |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient remove meta.profile | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › meta.project preserved after attempting to remove it | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient no changes | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient multiple names | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient with custom ID | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient with no author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as system ignores submitted meta.author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Super Admin update ignores submitted meta.author | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient ignores submitted meta.deleted | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Update Patient ignores submitted meta.deleted | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as ClientApplication with no author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as Practitioner with no author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as Practitioner on behalf of author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Skip background jobs when configured | skipped | platform | background jobs |
| server/src/fhir/repo.test.ts | FHIR Repo › Create resource with lastUpdated | skipped | platform | systemRepo-only: a custom meta.lastUpdated on create; over HTTP the server sets it |
| server/src/fhir/repo.test.ts | FHIR Repo › Create ResearchDefinition with long description (%s) | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with lastUpdated | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with missing id | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with matching versionId | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with different versionId | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with matching versionId | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with different versionId | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Delete resource with ifMatch | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with implicit array creation | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with FHIRPath Patch body | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with empty FHIRPath Patch body | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with invalid FHIRPath Patch body | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Compartment permissions | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Read history after delete | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › readVersion returns an unshared resource | skipped | platform | in-process object identity of repository results |
| server/src/fhir/repo.test.ts | FHIR Repo › Restore deleted resource | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Delete Binary | skipped | existing | the store's Binaries have no versions or history (store-compat.test.ts header); decide in plan 4 |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex resource as non-admin | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex resource not found | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex mixed resource types not allowed | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex resource errors logged | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Remove property | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Delete Questionnaire.subjectType | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Empty objects | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › $name › expungeResource in own project | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › $name › expungeResources in own project | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › $name › expungeResource in another project | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › $name › expungeResources with own-project and other-project IDs | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › Expunged tombstone has gone semantics after the resource ID is recreated | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › Expunge Binary deletes the stored object for every version | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › Expunge non-Binary does not touch binary storage | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › Super admin can expunge AuditEvent | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › expungeResource and expungeResources › Project admin can expunge AuditEvent | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Expunge too many IDs | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › Purge forbidden | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Purge Login | skipped | platform | expunge/purge admin operation |
| server/src/fhir/repo.test.ts | FHIR Repo › Malformed client assigned ID | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional update | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Double DELETE | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution failure | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution multiple matches | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution requires a project | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference replaced before validation | ported | existing |  |
| server/src/fhir/repo.test.ts | FHIR Repo › Prevents setting Project compartments | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Super admin can edit User.meta.project | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Super admin can edit Subscription.meta.project | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Handles resources with many entries stored in lookup table | skipped | platform | SQL storage internals |
| server/src/fhir/repo.test.ts | FHIR Repo › __version column | skipped | platform | SQL storage internals |
| server/src/fhir/repo.test.ts | FHIR Repo › Legacy UUID support -- non-conformant IDs that match UUID form are accepted | skipped | platform | assignedId repository option and expunge |
| server/src/fhir/repo.test.ts | FHIR Repo › Project.exportedResourceType | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Project.exportedResourceType allows resources in primary project | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › constructor and clone add the synthetic R4 project only once to shared context | skipped | platform | project/_project |
| server/src/fhir/binary.test.ts | Binary › Create and read binary | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Read binary not found | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Read binary without stored content | skipped | existing | not in plan 1: Binary as FHIR JSON (securityContext, a Binary without content), decide in plan 4 |
| server/src/fhir/binary.test.ts | Binary › Update and read binary | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Binary CORS | skipped | platform | CORS (Medplum server middleware) |
| server/src/fhir/binary.test.ts | Binary › Unsupported content encoding | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Deflate | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › GZIP | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Update with GZIP | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Upload binary in batch | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Update JSON | skipped | existing | not in plan 1: Binary as FHIR JSON (securityContext, a Binary without content), decide in plan 4 |
| server/src/fhir/binary.test.ts | Binary › Invalid Binary JSON | skipped | existing | not in plan 1: Binary as FHIR JSON (securityContext, a Binary without content), decide in plan 4 |
| server/src/fhir/binary.test.ts | Binary › Handle non-binary JSON | ported | existing |  |
| server/src/fhir/binary.test.ts | Binary › Error for disallowed file type | skipped | platform | Medplum's upload policy (blocked file extensions and executable content types) |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Default statement | ported | existing |  |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Include resource types | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Exclude resource types | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Read-only endpoint | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Per resource type interactions | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Search parameters are still generated for included resource types | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Disable supported profiles | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Replace supported profiles per resource type | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Add supported profiles to a type with none | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Empty array omits supported profiles for a type | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Overlay | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Overlay does not leak into subsequent builds | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/patient.test.ts | FHIR Patient utils › getPatientCompartmentParams | skipped | existing | Medplum helper functions (getPatients, compartment utils), no HTTP behaviour |
| server/src/fhir/patient.test.ts | FHIR Patient utils › getPatients | skipped | existing | Medplum helper functions (getPatients, compartment utils), no HTTP behaviour |
| server/src/fhir/patient.test.ts | FHIR Patient utils › Multiple patients | skipped | existing | Medplum helper functions (getPatients, compartment utils), no HTTP behaviour |
| server/src/fhir/patient.test.ts | FHIR Patient utils › Duplicate patients | skipped | existing | Medplum helper functions (getPatients, compartment utils), no HTTP behaviour |
| server/src/fhir/patient.test.ts | FHIR Patient utils › Follow search params | skipped | existing | Medplum helper functions (getPatients, compartment utils), no HTTP behaviour |
| server/src/fhir/patient.test.ts | FHIR Patient utils › External patient ID | skipped | existing | Medplum helper functions (getPatients, compartment utils), no HTTP behaviour |
| server/src/fhir/patient.test.ts | FHIR Patient utils › getPatientResourceTypes | skipped | existing | Medplum helper functions (getPatients, compartment utils), no HTTP behaviour |
| server/src/fhir/references.test.ts | Reference checks › Check references on write | skipped | platform | Medplum checkReferencesOnWrite project setting (the store does not check that references resolve) |
| server/src/fhir/references.test.ts | Reference checks › References to resources in linked Project | skipped | platform | project/_project |
| server/src/fhir/references.test.ts | Reference checks › Project reference validation | skipped | platform | project/_project |
| server/src/fhir/references.test.ts | Reference checks › ProjectMembership reference validation | skipped | platform | project/_project |
| server/src/fhir/references.test.ts | Reference checks › Check references with non-literal reference | ported | existing |  |
| server/src/fhir/references.test.ts | Reference checks › Check references with reference placeholder | skipped | platform | access policy compartment placeholder (%patient) |
| server/src/fhir/references.test.ts | Reference checks › Resources with identical references | skipped | platform | ReferenceTable internals (SQL storage) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Identifier | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › %s with empty value does not throw errors | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Multiple identifiers | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Update identifier | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Implicit exact | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Explicit exact | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › prefix on Patient-identifier | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-identifier | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-telecom | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-email | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-phone | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Not equals | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Search comma separated identifier exact | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Search on system | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Non-array identifier | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Leading whitespace | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › CodeableConcept text | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Identifier value with pipe | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Missing/present › %s :%s %s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Condition.code :%s search | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Non-strict mode › Handle malformed system | skipped | platform | Medplum repository option strictMode=false set in-process; HTTP writes are always validated, so the malformed data cannot be written |
| server/src/fhir/tokens.test.ts | Token-based searches › Non-strict mode › Handle malformed value | skipped | platform | Medplum repository option strictMode=false set in-process; HTTP writes are always validated, so the malformed data cannot be written |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › Sort by identifier | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › Sort by identifier with multiple values | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by system %s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by value %s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by system and value %s\|%s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by missing system and value %s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code and category by code=%s category=%s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :contains beginning of value %s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :contains middle of value %s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :text %s | ported | existing |  |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :text search for special chars › :text search for %s should match? %s | ported | existing | title appears twice in Medplum; one port covers both tables |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Formerly "legacy" column implementation search params use `token-column` strategy | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Search by system only works when using token columns | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Search by value always works | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Search by system and value only works when using token columns | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Sort by code always works | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › buildTokens › empty resource | skipped | platform | buildTokens unit test (Medplum token columns) |
| server/src/fhir/searchunique.test.ts | searchUnique › Multiple matches are logged once per window and the first match is returned | skipped | platform | Medplum logging window of an in-process repository helper |
| server/src/fhir/routes.test.ts | FHIR Routes › Get CapabilityStatement anonymously | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Get CapabilityStatement authenticated | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Get versions anonymously | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Get SMART-on-FHIR configuration | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Invalid JSON | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource success with %s FHIR JSON response format | ported | existing | standard format only; the legacy run is Medplum project setting legacyFhirJsonResponseFormat |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource invalid resource type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource incorrect resource type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource invalid content type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource _pretty | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource invalid UUID | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource invalid resource type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource not found | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource minimal | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource history | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource history invalid UUID | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource history invalid resource type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version invalid UUID | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version invalid version UUID | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version invalid resource type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version not found | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource not modified | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource not modified with empty strings | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource invalid | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource wrong content-type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource missing ID | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource not found | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource with precondition | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource with failed precondition | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource with failed precondition | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource invalid UUID | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource invalid resource type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource not found | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource wrong content type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource invalid resource type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource invalid result | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource success | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › FHIRPath Patch resource success | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search | ported | existing | Medplum reader/writer pool spies left out (internal) |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search by POST | ported | existing | Medplum reader/writer pool spies left out (internal) |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search by POST with multiple includes | ported | existing | Medplum reader/writer pool spies left out (internal) |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search multiple resource types with _type | ported | type |  |
| server/src/fhir/routes.test.ts | FHIR Routes › chainedSearchOnReader only routes chained searches to reader | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › readonlyBatchOnReader only routes read-only batches to reader | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › readonlyBatchOnReader does not break a nested read-only batch inside a transaction | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › Search invalid resource | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Search invalid search parameter | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate create success | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate create failure | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate unwraps the resource parameter of a Parameters body | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate rejects a Parameters body without a resource parameter | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate wrong content type | ported | existing |  |
| server/src/fhir/routes.test.ts | FHIR Routes › Reindex resource access denied | skipped | platform | reindex job |
| server/src/fhir/routes.test.ts | FHIR Routes › Resend subscriptions access denied | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › Resend as project admin | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › ProjectMembership with null access policy | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › Set accounts on create | skipped | platform | access policy / project / reader routing |
| server/src/fhir/structure.test.ts | FHIR structure › Can search Organization on _profile | ported | meta |  |
| server/src/fhir/structure.test.ts | FHIR structure › Can search MedicinalProductManufactured on _profile | ported | meta |  |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Success | ported | existing |  |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Inline DocumentReference attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Project setting enables inline DocumentReference attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Cursor pagination with _type | ported | existing |  |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Skips inlining attachments when the attachment cannot fit or be read | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Identifies inlineable Binary attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Reads current and versioned Binary attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Reads string and Buffer stream chunks into a Buffer | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Returns undefined and destroys the stream when the max byte count is exceeded | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | searchPatientCompartment › Successfully paginates through resource types | ported | existing | the helper's paging over HTTP ($everything _count/_offset) |
| server/src/fhir/operations/expand.test.ts | Expand › No ValueSet URL | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › ValueSet not found | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › No logical definition | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › No filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Multiple filters | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Invalid filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Filter token limit | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Success | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Success with count and offset | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › No duplicates | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Marital status | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Handle punctuation | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Handle empty string after punctuation | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › No null `display` field | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › User uploaded ValueSet | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › CodeSystem resolution | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › ValueSet that uses expansion instead of compose | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Returns error for recursive definition | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Subsumption | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Returns error when CodeSystem not found | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Prefers current Project version of common CodeSystem | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Prefers CodeSystem from linked Projects in link order | skipped | terminology | linked projects or project scoping |
| server/src/fhir/operations/expand.test.ts | Expand › Does not leak extended metadata when multiple ValueSets share a URL | skipped | terminology | linked projects or project scoping |
| server/src/fhir/operations/expand.test.ts | Expand › Expands ValueSet with explicit concepts from fragment CodeSystem | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Returns error when property filter is invalid for CodeSystem | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Includes ancestor code in is-a filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Text filter with is-a | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Excludes ancestor code in descendent-of filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Text filter with descendent-of | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › %s ValueSet shape has correct filter behavior › $name | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › $name | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › Sort order is deterministic when rows tie on relevance | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › Pagination is stable across offset windows | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Cost-based parent-filter strategy › countCandidatesBounded returns min(actual, limit) | skipped | terminology | in-process function, no HTTP request (countCandidatesBounded) |
| server/src/fhir/operations/expand.test.ts | Expand › Cost-based parent-filter strategy › descendant and ancestor strategies return identical members | skipped | terminology | in-process function, no HTTP request (expansionQuery) |
| server/src/fhir/operations/expand.test.ts | Expand › Recursive subsumption | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Recursive subsumption with filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Filter out abstract codes | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter with multiple values | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter with exists=true | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter with exists=false | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Reference to other ValueSet | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Display text override | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Minimum filter size for hierarchical expansion | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Expand with empty filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Expand with trailing quote | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Exact code match | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Exact code match with abstract filter | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Include pre-expanded ValueSet | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Resolve synonyms | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Condenses multiple synonyms in expansion | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › addExpansionItems() allows items out of order | skipped | terminology | in-process function, no HTTP request (addExpansionItems) |
| server/src/fhir/operations/expand.test.ts | Expand › Searches translated designations | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Only returns one (default) matching translation | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Honors ValueSet designation overrides | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Base resources are not shadowed for Super Admin | skipped | terminology | needs a Super Admin |
| server/src/fhir/operations/expand.test.ts | Expand › Display language › $name | ported | terminology |  |
| server/src/fhir/operations/expand.test.ts | Expand › Display language › Ancestor and descendant strategies agree under displayLanguage | skipped | terminology | in-process function, no HTTP request (expansionQuery) |
| server/src/fhir/operations/expand.test.ts | Expand › Display language › Paging counts codes, not translation rows | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Success | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Renders description for relationship and simple properties | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Coding parameter | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Not found | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › No full coding specified | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Checks project | skipped | terminology | project scoping: another project cannot see the CodeSystem |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Lookup using specific CodeSystem version | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Prefers complete CodeSystem over example even when example is newer | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Excludes retired CodeSystem from selection | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › GET endpoint | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › GET instance endpoint | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Error on instance system URL mismatch | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Instance endpoint with coding | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Error on instance coding system mismatch | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Correctly renders imported properties of different types | ported | terminology |  |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Outputs translated designations | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Explicitly included code succeeds | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Filter included code succeeds: %j | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Filter excluded code fails | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Returns negative result on display mismatch | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Returns negative result when no coding matches | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Returns error when no coding specified | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates coding via property filter | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates coding via property filter with multiple values | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates code when only example CodeSystem is present | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Does not validate display without authoritative CodeSystem | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › GET endpoint | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › GET instance endpoint | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Instance endpoint with coding | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates code against an include with multiple filters | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates system-less coding matched by a later include | ported | terminology |  |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Falls back to validating system URL when CodeSystem unavailable | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Success | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Coding parameter | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Not found | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › No full coding specified | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Checks project | skipped | terminology | project scoping: another project cannot see the CodeSystem |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Falls back to validating system URL | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Lookup using specific CodeSystem version | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › GET endpoint | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › GET instance endpoint | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Fail on instance system URL mismatch | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Instance endpoint with coding | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Fail on instance coding system mismatch | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Returns specified displayLanguage | ported | terminology |  |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › validateCodings | skipped | terminology | in-process function, no HTTP request (validateCodings) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Subsumes | ported | terminology |  |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Subsumed by | ported | terminology |  |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Equivalent | ported | terminology |  |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Not subsumed | ported | terminology |  |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Returns error on incomplete input | ported | terminology |  |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › GET endpoint | ported | terminology |  |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › GET instance endpoint | ported | terminology |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Batch success | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Batch invalid bundle | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Read resource by ID | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Read resource by ID not found | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update incorrect resource type | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update incorrect ID | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update incorrect precondition | ported | existing | title appears twice in Medplum; one port covers both |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update with correct precondition | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Delete with precondition | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Search by post | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Search multiple types | ported | type |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional update | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional update with unparsed query string | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Patch resource | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional PATCH | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional delete | ported | existing |  |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Create resource with query param account | skipped | platform | project/account compartments |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Custom system-level operation returns not found | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch with missing bundle type | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch with invalid bundle type | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch with missing entries | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch success | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch create success | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch create missing resource | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch create missing resourceType | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch create ignore http fullUrl | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch create does not rewrite identifier | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch create ifNoneExist success | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch create ifNoneExist multiple matches | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Use ifNoneExist result in other reference | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch update | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch update missing resource | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch patch | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch patch Parameters | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch FHIRPath patch | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch FHIRPath patch rewrites local references | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Batch FHIRPath PATCH with matching If-Match succeeds | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Batch FHIRPath PATCH with stale If-Match fails with 412 | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Batch PUT with stale If-Match fails with 412 | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Transaction PATCH with stale If-Match fails the whole transaction | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › JSONPath error messages | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › JSONPatch error messages | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch patch invalid url | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch patch missing resource | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch patch wrong patch type | ported | existing | title appears twice in Medplum; one port covers both |
| fhir-router/src/batch.test.ts | Batch › Process batch delete | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch delete invalid URL | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch missing request | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch missing request.method | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch unsupported request.method | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch missing request.url | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch not found | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process batch read history | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Conditional interactions | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Dispatches batch telemetry once across transaction retries | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Process Transactions › Embedded urn:uuid | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process Transactions › Encoded urn:uuid | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Process Transactions › Transaction update after create | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Valid null | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Concurrent conditional create in transactions | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Local reference resolution for update | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › No self-assigned ID in upsert | ported | existing |  |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Full run matches one-shot processBatch behavior | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Placeholder references survive serialize -> fromState -> resume | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Resume does not reprocess already-completed entries | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › processNextEntry before preprocess throws | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Malformed entries are captured as preprocess results | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Transaction resource type tracking › Gathers resource types from transaction entries | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Transaction resource type tracking › De-duplicates repeated resource types | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Transaction resource type tracking › Skips system-level entries with no resource type | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › Search entries are tagged with mode "match" | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include resolves a literal reference | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include does not throw on a dangling reference | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include with a target type filters by that type | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include deduplicates resources referenced more than once | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include does not re-include a resource already in the match set | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _revinclude resolves reverse references | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _revinclude with a target type filters the base resources | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include:iterate follows a chain of references | ported | include |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include without :iterate does not recurse | ported | include |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include resolves canonical references by exact URL | ported | include |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _revinclude resolves canonical references | ported | include |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › Invalid include parameter throws badRequest | ported | existing |  |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › Empty match set skips include processing | ported | existing |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Missing query | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Syntax error | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Introspection forbidden | skipped | graphql | Medplum runs with introspection on; store-only test |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Introspection allowed | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Allows value introspection | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read by ID | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read by ID not found | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search with _id | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search with _count | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search with based-on | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Sort by _lastUpdated asc | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Sort by _lastUpdated desc | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read resource by reference | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read resource by reference not found | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup with _reference | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup on contained resource with invalid id | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup without _reference | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup with Connection API and count | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup with Connection API count only (no edges) | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Max depth | skipped | graphql | skipped in Medplum 5.2.14 |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Max depth override | skipped | graphql | skipped in Medplum 5.2.14 |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › StructureDefinition query | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › _offset list field argument | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › _count list field argument | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › fhirpath list field argument | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › List field argument by name | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Extension list field argument | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › List field argument null values | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Connection API | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Connection API without count field | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Connection API without edges field | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Create Patient Record | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Create wrong resourceType error | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Updating Patient Record | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Invalid Update Mutation | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Update wrong resourceType error | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Update wrong ID error | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Delete Patient Record | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reference missing reference property | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Fragment inclusion | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Cursor pagination | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Patch Patient Record | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Invalid Patch Mutation | ported | graphql |  |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Invalid Patch Operations | ported | graphql |  |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › validateResourceWithJsonSchema | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Array properties | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Additional properties | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Required properties | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Null value | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Null array element | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Undefined array element | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Nested null array element | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/jsonschema.test.ts | FHIR JSONSchema › Deep nested null array element | skipped | platform | not in plan 1: operation $jsonschema, decide in plan 4 |
| server/src/fhir/operations/graphql.test.ts | GraphQL › IntrospectionQuery | skipped | graphql | skipped in Medplum 5.2.14 |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Get __schema | skipped | graphql | skipped in Medplum 5.2.14 |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Get __type | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Read by ID | skipped | graphql | Medplum presigns attachment URLs (Binary storage), in REST reads too: its test asserts photo.url is http(s); the store keeps the stored url (the fhir-router row covers the read) |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Read by ID not found | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Search | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Search with _id | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Search with _filter | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Search with _count | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Search with based-on | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Sort by _lastUpdated asc | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Sort by _lastUpdated desc | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Read resource by reference | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Read resource by reference not found | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Reverse lookup with _reference | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Reverse lookup without _reference | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Max depth | skipped | graphql | skipped in Medplum 5.2.14 |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Hidden fields in nested lookups | skipped | graphql | access policy |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Cannot read resource type | skipped | graphql | access policy |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Cannot read resource type in nested lookups | skipped | graphql | access policy |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Access policy criteria | skipped | graphql | access policy |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Access policy criteria in nested lookups | skipped | graphql | access policy |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Max searches exceeded | skipped | graphql | project setting |
| server/src/fhir/operations/graphql.test.ts | GraphQL › searchByReference › disabled without project setting | skipped | graphql | project setting |
| server/src/fhir/operations/graphql.test.ts | GraphQL › searchByReference › Respect project boundary | skipped | graphql | project setting |
| server/src/fhir/operations/graphql.test.ts | GraphQL › searchByReference › Respect access policy | skipped | graphql | access policy |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Create Task with groupIdentifier | skipped | graphql | access policy |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Uses reader instance when available | skipped | graphql | database platform (spy on pools or loaders) |
| server/src/fhir/operations/graphql.test.ts | GraphQL › GraphQL in batch users writer | skipped | graphql | database platform (spy on pools or loaders) |
| server/src/fhir/operations/graphql.test.ts | GraphQL › Cursor pagination | ported | graphql |  |
| server/src/fhir/operations/graphql.test.ts | GraphQL › dataloader deduplicates reads | skipped | graphql | database platform (spy on pools or loaders) |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Smoke Test | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Invalid graph parameter | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Missing Graph Definition | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Missing Resource | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Missing Target | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Malformed Target | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Invalid Start | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Invalid link type | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Error cases › Missing ref | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Canonical Link | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Two Levels Deep | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Parallel Links | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Search Based Link | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/resourcegraph.test.ts | Resource $graph › Nested Search Links | skipped | platform | not in plan 1: operation $graph, decide in plan 4 |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Success %s | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Lookup by URL | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Allows GET request | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Lookup by source ValueSet | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Filter on target system | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › No match | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › No map specified | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Code without system | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Ambiguous coding provided | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › No source coding | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Not found by %s | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Unmapped code handling | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Handles empty CodeableConcept | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Handles implicit system | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › No mapping groups specified | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Complex SNOMED to ICD mapping | ported | terminology |  |
| server/src/fhir/operations/conceptmaptranslate.test.ts | ConceptMap $translate › Renders mapping comment | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Imports concepts and properties separately | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Imports concepts and associated relationships | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Returns error on unknown code system | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Returns error on unknown code for property | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Returns error on unknown property | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Returns error on non-SuperAdmin user | skipped | terminology | needs a Super Admin |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Allows access by Project admin | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Prevents writes by Project admin to linked Project systems | ported | terminology | differs on purpose: a built-in is 403 by url too |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Allows Super Admin to import into base CodeSystem by ID | skipped | terminology | needs a Super Admin |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Prevents writes by Project admin to base CodeSystem by ID | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Imports into own Project CodeSystem by ID | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Requires update permission on own Project CodeSystem | skipped | terminology | access policy |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Requires update permission on own Project CodeSystem by URL | skipped | terminology | access policy |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Imports into own Project CodeSystem by ID without extended mode | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Imports concepts and synonym designations | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Attaches imported properties to primary coding instead of synonym | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Rejects excessively large batches | ported | terminology |  |
| server/src/fhir/operations/codesystemimport.test.ts | CodeSystem $import › Accepts batch of max size | ported | terminology |  |
| server/src/fhir/operations/conceptmapimport.test.ts | importConceptMap() › Imports basic mappings from resource | skipped | terminology | in-process function, no HTTP request (importConceptMap) |
| server/src/fhir/operations/conceptmapimport.test.ts | importConceptMap() › Imports mapping metadata | skipped | terminology | in-process function, no HTTP request (importConceptMap) |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Imports concept mappings and attributes | ported | terminology |  |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Imports by ID without extended mode | ported | terminology |  |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Requires admin privileges | skipped | terminology | needs a non-admin project member |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Prevents writes by Project admin to linked Project ConceptMap | skipped | terminology | linked projects or project scoping |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Allows selecting ConceptMap by URL | ported | terminology |  |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Requires ConceptMap to be specified | ported | terminology |  |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Cannot overspecify ConceptMap | ported | terminology |  |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Requires source code to be specified | ported | terminology |  |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Ignores unspecified source code in ConceptMap resource | skipped | terminology | in-process function, no HTTP request (reads Medplum mapping tables) |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Handles ConceptMap with no valid mappings | skipped | terminology | in-process function, no HTTP request (reads Medplum mapping tables) |
| server/src/fhir/operations/conceptmapimport.test.ts | ConceptMap/$import › Import does not clobber or duplicate inline mappings | ported | terminology |  |
| server/src/fhir/operations/expunge.test.ts | Expunge › Forbidden | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Expunge single resource | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Expunge $project project as $name $outcome | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Project admin can expunge patient everything within own project | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Project admin cannot expunge patient everything in another project | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Expunger.expunge() expunges all resource types | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Expunger with another project id as a non-Project compartment leaves that project alone | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Project expunge leaves Binaries of other projects named in attachments | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Compartment expunge only expunges attachment Binaries in the same project | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/expunge.test.ts | Expunge › Expunger expunges AuditEvent and leaves a history tombstone | skipped | platform | not in plan 1: operation $expunge, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › Success | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › Simple categories | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › ClinicalImpressions | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › Conditions | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › Observations | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › Observation containing observation | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › DiagnosticReport containing observation | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › CarePlan containing ServiceRequest | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientsummary.test.ts | Patient Summary Operation › PatientSummaryBuilder › Encounter containing conditions | skipped | platform | not in plan 1: operation $summary, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Returns 400 when resource parameter is missing | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Returns 400 when resource is not a Patient | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Returns 400 when Patient has no matchable fields | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Returns 400 when Patient only has gender | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Returns empty bundle when no patients match | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Matches patient by identifier | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Returns a possible discovery match on name + birthdate alone | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Matches via First + DOB + Phone (criteria 11) | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Matches via First + DOB + Email (criteria 12) | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Respects onlyCertainMatches flag | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › Respects count parameter | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › CMS mode (onlyCertainMatches=true) › releases a unique match via rule 11 (First + DOB + Phone) | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › CMS mode (onlyCertainMatches=true) › suppresses an ambiguous match (two qualifying candidates) | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › CMS mode (onlyCertainMatches=true) › no match when only a single non-discriminating field agrees | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › CMS mode (onlyCertainMatches=true) › does not release name + birthdate alone without an approved CMS combination | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › CMS mode (onlyCertainMatches=true) › finds and releases a candidate whose DOB is one day off (rule 01, DOB*) | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/patientmatch.test.ts | Patient $match Operation › CMS mode (onlyCertainMatches=true) › requires an exact first name when another candidate shares the DOB (twin guardrail) | skipped | platform | not in plan 1: operation $match, decide in plan 4 |
| server/src/fhir/operations/structuredefinitionexpandprofile.test.ts | StructureDefinition $expand-profile › Success with nested profiles | skipped | platform | not in plan 1: operation $expand-profile, decide in plan 4 |
| server/src/fhir/operations/structuredefinitionexpandprofile.test.ts | StructureDefinition $expand-profile › Success with missing nested profiles | skipped | platform | not in plan 1: operation $expand-profile, decide in plan 4 |
| server/src/fhir/operations/structuredefinitionexpandprofile.test.ts | StructureDefinition $expand-profile › Profile not found | skipped | platform | not in plan 1: operation $expand-profile, decide in plan 4 |
| server/src/fhir/operations/structuredefinitionexpandprofile.test.ts | StructureDefinition $expand-profile › Profile URL not specified | skipped | platform | not in plan 1: operation $expand-profile, decide in plan 4 |
| server/src/fhir/operations/structuredefinitionexpandprofile.test.ts | StructureDefinition $expand-profile › Circuit breaker for deeply nested profiles | skipped | platform | not in plan 1: operation $expand-profile, decide in plan 4 |
| server/src/fhir/operations/structuredefinitionexpandprofile.test.ts | StructureDefinition $expand-profile › Circuit breaker for too deeply nested profiles | skipped | platform | not in plan 1: operation $expand-profile, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › Kickoff queues the export without running it | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › Success | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › Export output Binary is bound to async job security context | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › System Export Accepted with GET | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › Patient Export Accepted with GET | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › Rejects unsupported _typeFilter %s before starting a job | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › _typeFilter | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › parseExportParameters: %s | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › parseExportParameters rejects non-string _type | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › exportResourceType iterating through paginated search results | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › closeWriter removes only specified resource type from tracking | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › closeWriter called for each resource type during export | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › exportResourceType does not track exported resources for dedupe | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › writeResource dedupes by default | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/export.test.ts | Export › Backpressure waits do not leak stream listeners | skipped | platform | not in plan 1: operation $export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › Export Group | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › Export Group Accepted with POST | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › Since filter | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › Type filter | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › Rejects _typeFilter | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › status accepted with error | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › groupExportResources without members | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › groupExportResources members without reference | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › groupExportResources includes referenced resources | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › groupExportResources searches large groups in chunks | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › Export with read-only access policy (no write scope) | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/groupexport.test.ts | Group Export › Export carries access-policy compartment as account | skipped | platform | not in plan 1: operation Group/$export, decide in plan 4 |
| server/src/fhir/operations/csv.test.ts | CSV Export › Export Patient | skipped | platform | not in plan 1: operation $csv, decide in plan 4 |
| server/src/fhir/operations/csv.test.ts | CSV Export › Export ServiceRequest | skipped | platform | not in plan 1: operation $csv, decide in plan 4 |
| server/src/fhir/operations/csv.test.ts | CSV Export › Handle malformed data | skipped | platform | not in plan 1: operation $csv, decide in plan 4 |
| server/src/fhir/operations/csv.test.ts | CSV Export › Invalid resource type | skipped | platform | not in plan 1: operation $csv, decide in plan 4 |
| server/src/fhir/operations/csv.test.ts | CSV Export › Invalid query string param | skipped | platform | not in plan 1: operation $csv, decide in plan 4 |
| server/src/fhir/operations/csv.test.ts | CSV Export › Escape formula string | skipped | platform | not in plan 1: operation $csv, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Success | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Success at type level with passed in resources | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Handles multiple template elements in same array | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › QuestionnaireResponse must be specified | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Questionnaire must be specified | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Context extensions must contain valid FHIRPath expressions | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Named expression is stored as context variable | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Extraction cannot begin on incorrect element | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Requires template resource | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Honors resourceId field | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › Keeps default value for primitive field | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/extract.test.ts | QuestionnaireResponse/$extract › X-FHIR-Query results stored in context | skipped | platform | not in plan 1: operation $extract, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Happy path | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Happy path - Encounter | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Unsupported content type | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Incorrect parameters type | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Missing subject | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › General task | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › ActivityDefinition ServiceRequest | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › ActivityDefinition dynamicValue populates ServiceRequest fields | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › ActivityDefinition dynamicValue with hardcoded organization and category | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › ActivityDefinition dynamicValue writes choice-of-type element | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › ActivityDefinition dynamicValue writes choice-of-type CodeableConcept | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › ActivityDefinition dynamicValue rejects unsupported expression language | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › ActivityDefinition dynamicValue requester and performer | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › applyDynamicValues leaves variable values unchanged | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Dynamic and static assigned owner and performerType | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Populates instantiates link when PlanDefinition has url | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Canonical with several versions › Prefers the active version over a more recently updated retired one | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Canonical with several versions › Prefers the most recently updated active version | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Canonical with several versions › Without an active version, uses the most recently updated one | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/plandefinitionapply.test.ts | PlanDefinition apply › Canonical with several versions › Prefers ActivityDefinition over a Questionnaire with the same url | skipped | platform | not in plan 1: operation PlanDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/chargeitemdefinitionapply.test.ts | ChargeItemDefinition Apply › Happy path - Apply ChargeItemDefinition | skipped | platform | not in plan 1: operation ChargeItemDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/chargeitemdefinitionapply.test.ts | ChargeItemDefinition Apply › Apply ChargeItemDefinition with service-code based surcharge | skipped | platform | not in plan 1: operation ChargeItemDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/chargeitemdefinitionapply.test.ts | ChargeItemDefinition Apply › Apply ChargeItemDefinition with multiple discount types | skipped | platform | not in plan 1: operation ChargeItemDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/chargeitemdefinitionapply.test.ts | ChargeItemDefinition Apply › Apply ChargeItemDefinition with base price applicability | skipped | platform | not in plan 1: operation ChargeItemDefinition/$apply, decide in plan 4 |
| server/src/fhir/operations/evaluatemeasure.test.ts | Measure evaluate-measure › Happy path | skipped | platform | not in plan 1: operation Measure/$evaluate-measure, decide in plan 4 |
| server/src/fhir/operations/evaluatemeasure.test.ts | Measure evaluate-measure › Unsupported content type | skipped | platform | not in plan 1: operation Measure/$evaluate-measure, decide in plan 4 |
| server/src/fhir/operations/evaluatemeasure.test.ts | Measure evaluate-measure › Unsupported parameters type | skipped | platform | not in plan 1: operation Measure/$evaluate-measure, decide in plan 4 |
| server/src/fhir/operations/evaluatemeasure.test.ts | Measure evaluate-measure › Missing period | skipped | platform | not in plan 1: operation Measure/$evaluate-measure, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › finds appointments that are available on all referenced schedules | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › works with a single schedule | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › no overlapping availability returns empty bundle | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › merges "free" slots on each schedule into that schedule's availability | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › busy slot on second schedule removes that interval from results | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › with slotCapacity > 1, a slot stays available until capacity is reached | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › multi-schedule intersection is gated by the smaller slotCapacity | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › with slotCapacity > 1, $find offers a time whose buffers clear an overlapping booking | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › with slotCapacity > 1, bufferBefore is still exclusive | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › with slotCapacity > 1, bufferAfter is still exclusive | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › multi-schedule intersection applies buffers from the overbookable schedule | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › a capacity-1 booking is not overbooked by a capacity-2 $find | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › each schedule can have its own timezone set in scheduling parameters | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when `service-type-reference` parameter is omitted | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when `service-type-reference` parameter cannot be resolved | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when the requested HealthcareService is inactive | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › finds appointments when the requested HealthcareService is explicitly active | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when `schedule` parameter is omitted | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when a schedule reference cannot be resolved | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when Schedule.serviceType does not include a reference to the requested HealthcareService | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › finds times on a Schedule marked as offering all service types | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors on a schedule with multiple actors | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when service type is not present on all schedules | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when `duration` scheduling parameter differs across schedules | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when `alignmentTimezone` scheduling parameter differs across schedules | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › each schedule applies its own bufferBefore/bufferAfter independently | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when one schedule is inactive | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › errors when one schedule has a planning horizon that excludes the requested range | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › clips search range to intersection of planning horizons across schedules | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › _count is respected for multi-schedule results | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › Appointments contain nested Slot resources for each schedule | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › alignmentTimezone anchors the slot grid to local midnight | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › uses default search page size of 20 results | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › can override search page size with `_count` | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › validates `_count` is in an acceptable range | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › it works when HealthcareService.type has no codes | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › when HealthcareService.type has multiple codes › proposes appointments carrying every code with the service reference | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › when HealthcareService.type has multiple codes › a service-scoped busy Slot blocks time when it matches any of the codes | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › when HealthcareService.type has multiple codes › a service-scoped free Slot adds availability when it matches any of the codes | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › when the caller cannot read Schedule.actor › finds the same times as a caller who can, when the Schedule names a timezone | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › when the caller cannot read Schedule.actor › errors when no timezone is named higher up | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › ignore-appointment › unblocks the time held by the appointment being reassigned | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › ignore-appointment › ignores buffer slots held by the appointment | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › ignore-appointment › does not unblock a different appointment at the same time | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › ignore-appointment › is a no-op for an appointment holding no slots | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › ignore-appointment › rejects a reference to another resource type | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.test.ts | Appointment/$find › ignore-appointment › rejects a reference to a nonexistent appointment | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.recurring.test.ts | Appointment/$find with occurrence-count › finds times that are free at the same time every week | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.recurring.test.ts | Appointment/$find with occurrence-count › keeps each occurrence at the same local time across DST transitions | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.recurring.test.ts | Appointment/$find with occurrence-count › drops a series whose later occurrences fall off an alignment grid kept in UTC | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.recurring.test.ts | Appointment/$find with occurrence-count › finds no series that runs past the planning horizon | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.recurring.test.ts | Appointment/$find with occurrence-count › checks a later occurrence's buffer, which can't be overbooked | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.recurring.test.ts | Appointment/$find with occurrence-count › names the later week whose Slots fill a search page | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/find.recurring.test.ts | Appointment/$find with occurrence-count › validates recurring searches | skipped | platform | not in plan 1: operation Appointment/$find, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › When referencing a nonexistent schedule | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › creates a "booked" appointment with "busy" slots | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › replaces a client-supplied booked-by-operation extension | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with mismatched slot starts | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with mismatched slot ends | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › fails when the HealthcareService is inactive | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › fails when the Schedule is inactive | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › succeeds when the HealthcareService is explicitly active | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › fails when there is an overlapping busy slot booked | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with slotCapacity > 1, $book succeeds while capacity remains | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with slotCapacity > 1, $book fails once capacity is full | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with slotCapacity > 1, concurrent $book requests cannot exceed capacity | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › a capacity-1 booking cannot be overbooked by a capacity-2 service | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › a forged slotCapacity stamp on the request is ignored (set authoritatively) | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › a zero-length contained Slot does not split the availability window | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › fails without a HealthcareService reference embedded in serviceType | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › it fails when trying to book outside of availability windows | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with practitioners in different timezones | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › succeeds against an explicit "free" slot outside of regular availability | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › succeeds over adjacent explicit "free" slots | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › booking a slot with a different duration than scheduling parameters fails | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › booking a slot against parameters with alignment attributes | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with bufferBefore | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › with bufferAfter | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › patient references embedded in Appointment.participant are preserved | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › errors when the appointment parameter already has the `slot` attribute | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › rejects when the proposed slot start is not aligned to the scheduling grid | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › when HealthcareService.type has multiple codes › books an appointment whose serviceType carries every code | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › when HealthcareService.type has multiple codes › fails when a busy Slot scoped to any of the codes overlaps | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › Loading schedulingParameters from HealthcareService › succeeds when scheduling parameters are only on an HealthcareService | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › Loading schedulingParameters from HealthcareService › fails when booking outside HealthcareService availability | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › Loading schedulingParameters from HealthcareService › Schedule-specific parameters override HealthcareService parameters | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › errors when appointment is after Schedule.planningHorizon.end | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › errors when appointment is before Schedule.planningHorizon.start | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | Appointment/$book › slotCapacity does not apply to bufferBefore | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | scheduling flow integration test › a proposed appointment from Appointment/$find can be used as input to $book | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | scheduling flow integration test › a $find proposal for a HealthcareService with multiple type codes can be booked | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | scheduling flow integration test › every $find proposal can be booked when overbooking and buffers are configured | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | scheduling flow integration test › booking a slot as a patient with a minimal access policy | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.test.ts | scheduling flow integration test › booking a slot as a patient who cannot read Schedule.actor | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.recurring.test.ts | Appointment/$book and $hold with a recurrenceTemplate › $operation creates every occurrence, keeping its local time across DST | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.recurring.test.ts | Appointment/$book and $hold with a recurrenceTemplate › $operation creates a series as $find proposes it | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.recurring.test.ts | Appointment/$book and $hold with a recurrenceTemplate › books a series sent at a timezone offset | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.recurring.test.ts | Appointment/$book and $hold with a recurrenceTemplate › refuses a series with $refuses | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 (title appears twice in Medplum) |
| server/src/fhir/operations/book.recurring.test.ts | Appointment/$book and $hold with a recurrenceTemplate › $operation creates none of the series when one is unavailable | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/book.recurring.test.ts | Appointment/$book and $hold with a recurrenceTemplate › $confirm books one held occurrence, leaving the rest of the series held | skipped | platform | not in plan 1: operation Appointment/$book, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › succeeds with 201 Created | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › creates a "pending" Appointment and "busy-tentative" Slot | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with multiple schedules creates one busy-tentative slot per schedule | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when appointment has no service reference | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when appointment serviceType is missing entirely | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when appointment has no contained Slot resources | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when appointment already has references in `slot` | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when contained has no Slot resources | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when embedded "busy" slots have mismatched start times | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects with mismatched busy slot end times | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when referenced schedule does not exist | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when slot duration does not match scheduling parameters | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when the slot is outside availability windows | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with slotCapacity > 1, $hold succeeds while capacity remains | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with slotCapacity > 1, $hold buffer time is still exclusive | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when a busy slot already exists at the requested time | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when a busy-tentative slot already exists at the requested time (double hold) | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when there are no embedded "busy" slots for a schedule | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › rejects when there are multiple embedded "busy" slots for the same schedule | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with a patient participant preserved in the created appointment | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with bufferBefore › succeeds when a correctly-sized bufferBefore slot is included | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with bufferBefore › rejects when bufferBefore is not available | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with bufferBefore › rejects when bufferBefore slot is missing | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with bufferBefore › rejects when bufferBefore slot has wrong duration | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with bufferAfter › succeeds when a correctly-sized bufferAfter slot is included | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with bufferAfter › rejects when bufferAfter slot is missing | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › with bufferAfter › rejects when bufferAfter slot has wrong duration | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › fails when the HealthcareService is inactive | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › fails when the schedule has more than one actor | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › fails when the schedule actor has no timezone | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | Appointment/$hold › errors when appointment is outside schedule planning horizon | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/hold.test.ts | scheduling flow integration test › a Slot from Appointment/$find can be used as input to Appointment/$hold | skipped | platform | not in plan 1: operation Appointment/$hold, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Succeeds for a booked appointment | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Succeeds for a pending appointment | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Returns cancelled appointment | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Sets cancelation reason from a plain JSON body | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Sets cancelation reason from a Parameters body | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Leaves cancelation reason unset when omitted | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Deletes the referenced slot | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Deletes multiple slots | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Succeeds for appointment with no slots | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Succeeds for an appointment belonging to an inactive HealthcareService | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Succeeds for an appointment on a Schedule that has since been deactivated | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Returns 400 for non-cancelable status: %s | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Returns 404 when appointment does not exist | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/cancel.test.ts | Appointment/$cancel › Returns 400 when a referenced slot does not exist | skipped | platform | not in plan 1: operation Appointment/$cancel, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › reassigning a subset of schedules without changing the scheduled time | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › removing an actor | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rescheduling an appointment with the same schedules to a new time | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › stamps the move as made by $reschedule, replacing an earlier manual move marker | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › keeps the original slots when the new time is unavailable | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › a pending appointment keeps holding its time tentatively | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › carries buffer slots over to the new time | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › marks an occurrence of a recurring series moved to a new time as changed | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects an appointment that is not pending or booked | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rescheduling as a patient with a minimal access policy | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › the start time of a proposed appointment from Appointment/$find can be used for $reschedule | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › reassigning to schedules that share an actor does not duplicate participants | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › moves the primary provider mark to the first provider among the new schedules | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects an invalid start time | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects a start that is not aligned to the scheduling grid | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › leaves the service type on file, and the codes booked alongside it, untouched | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects an appointment that records no service type at all | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects an appointment on file for more than one service type | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › deduplicates a schedule named more than once | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects a schedule that does not offer the requested service type | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › moves an appointment onto a schedule marked as offering all service types | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects rescheduling onto an inactive schedule | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › moves an appointment off a schedule that has since been deactivated | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects an invalid reference for a schedule | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/reschedule.test.ts | Appointment/:id/$reschedule › rejects when the service on file does not resolve | skipped | platform | not in plan 1: operation Appointment/$reschedule, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Succeeds for a pending appointment | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Succeeds for a proposed appointment | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns a Bundle containing the booked Appointment | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Updates busy-tentative slots to busy | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Updates multiple busy-tentative slots | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Does not modify slots that are already busy | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Succeeds for appointment with no slots | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns 400 for non-confirmable status: %s | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns 400 when the HealthcareService is inactive | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Reports the path of the serviceType concept holding the inactive service reference | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Succeeds when the HealthcareService is explicitly active | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Succeeds when the HealthcareService omits the active field | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns 400 when the HealthcareService has been deleted | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns 400 when the HealthcareService is hidden by an access policy | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns 400 when a slot is on an inactive Schedule | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns 404 when appointment does not exist | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/confirm.test.ts | Appointment/:id/$confirm › Returns 400 when a referenced slot does not exist | skipped | platform | not in plan 1: operation Appointment/$confirm, decide in plan 4 |
| server/src/fhir/operations/claimexport.test.ts | CMS 1500 PDF › Post Request - Fully answered CMS1500 pdf | skipped | platform | not in plan 1: operation Claim/$export, decide in plan 4 |
| server/src/fhir/operations/claimexport.test.ts | CMS 1500 PDF › Get Request - Fully answered CMS1500 pdf | skipped | platform | not in plan 1: operation Claim/$export, decide in plan 4 |
| server/src/fhir/operations/claimexport.test.ts | CMS 1500 PDF › Bad request - claim not found | skipped | platform | not in plan 1: operation Claim/$export, decide in plan 4 (title appears twice in Medplum) |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Returns 400 when CLAIM_SUBMIT_OPERATION is not configured | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Returns 400 when PRIOR_AUTH_SUBMIT_OPERATION is not configured for preauthorization | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Returns 400 when the configured operation has no matching OperationDefinition | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Dispatches to the operation named by the CLAIM_SUBMIT_OPERATION project setting | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Dispatches a raw Claim body to the operation named by the CLAIM_SUBMIT_OPERATION project setting | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Dispatches preauthorization claims to the PRIOR_AUTH_SUBMIT_OPERATION project setting | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Dispatches Bundles containing preauthorization claims to the PRIOR_AUTH_SUBMIT_OPERATION project setting | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Returns 400 when a Bundle does not contain a Claim | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Reads the Claim from the URL on the instance route | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/claimsubmit.test.ts | Claim $submit › Returns 400 when no Claim payload is provided | skipped | platform | not in plan 1: operation Claim/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Returns 400 when ELIGIBILITY_SUBMIT_OPERATION is not configured | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Returns 400 when the configured operation has no matching OperationDefinition | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Dispatches to the operation named by the ELIGIBILITY_SUBMIT_OPERATION project setting | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Dispatches a raw CoverageEligibilityRequest body to the configured operation | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Dispatches Bundles containing a CoverageEligibilityRequest to the configured operation | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Returns 400 when a Bundle does not contain a CoverageEligibilityRequest | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Reads the CoverageEligibilityRequest from the URL on the instance route | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/coverageeligibilityrequestsubmit.test.ts | CoverageEligibilityRequest $submit › Returns 400 when no CoverageEligibilityRequest payload is provided | skipped | platform | not in plan 1: operation CoverageEligibilityRequest/$submit, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Generate and verify SMART Health Card | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Detects invalid SMART Health Cards | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Verifies external SMART Health Card signatures without trusting issuer | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Generate manifest and resolve SMART Health Link | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Rejects invalid SMART Health Links | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Generate direct SMART Health Link and resolve payload | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Resolves external direct SMART Health Link payloads | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Returns warnings for expired external SMART Health Link payloads | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Accepts external SMART Health Link payloads with %s content type | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Rejects invalid external SMART Health Link payload responses | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Rejects invalid direct SMART Health Links | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Returns not found when direct SMART Health Link Binary is unavailable | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Does not dereference SMART Health Link Binary from another project | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/smarthealth.test.ts | SMART Health operations › Omits manifest files backed by Binary resources from another project | skipped | platform | not in plan 1: operation $health-card-issue, decide in plan 4 |
| server/src/fhir/operations/ccdaexport.test.ts | C-CDA Export › Success | skipped | platform | not in plan 1: operation $ccda-export, decide in plan 4 |
| server/src/fhir/operations/refresh-reference-display.test.ts | $refresh-reference-display › Updates all reference display strings in resource | skipped | platform | not in plan 1: operation $refresh-reference-display, decide in plan 4 |
| server/src/fhir/operations/refresh-reference-display.test.ts | $refresh-reference-display › Does not change strings for resources user cannot access | skipped | platform | not in plan 1: operation $refresh-reference-display, decide in plan 4 |
