# Medplum 5.2.14 record tests in scope

One row per Medplum test (a `test.each` counts once, by its title template). Columns: file (path below `packages/`), title (describe path joined with " › "), status, feature, note.

- status: `ported` (a parity test titled `<title> [<file>]` exists), `skipped` (note says why), `plan-2` (terminology), `plan-3` (GraphQL).
- feature: `existing`, `summary`, `type`, `include`, `chain`, `modifier`, `composite`, `filter`, `meta`, `terminology`, `graphql`, `platform`.
- A note `not yet ported (Task N)` names the task that ports the row; the last task fails any row still carrying it.
- `tests/parity-inventory.test.ts` checks this file against the parity tests.

| file | title | status | feature | note |
| --- | --- | --- | --- | --- |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search total | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search count=0 | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search offset max | skipped | existing | not yet ported (Task 3a) |
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
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search _summary | skipped | summary | not yet ported (Task 4) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search _elements | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search next link | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search previous link | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for Communications by Encounter | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for Communications by ServiceRequest | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for QuestionnaireResponse by Questionnaire | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search for token in array | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.id | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.meta.lastUpdated | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.identifier | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.name | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.given | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.address | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.postalCode | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.telecom | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.email | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search sort by Patient.birthDate | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter and sort on same search parameter | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search birthDate after delete | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Search identifier after delete | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › String filter | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › String filter with escaped commas | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by _id | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by _id with %s=%s | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by _compartment presence | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by chained _id | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by chained _id presence | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse filter by chained _id | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse filter by _compartment:_id | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Forward filter by _compartment.name | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained filter with _compartment as middle link | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Empty _id | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Non UUID _id | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Non UUID _compartment | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference string _compartment | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Handle_lastUpdated value %s, isValid? %s | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Handle non-string value | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Handle string with null bytes | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by Coding | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by CodeableConcept | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter by Quantity.value | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › ServiceRequest.orderDetail search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Comma separated value | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token not equals | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token not equals matches missing value | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token array not equals | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Null token array not equals | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Missing | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Missing with logical (identifier) references | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Starts after | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Boolean search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Boolean not equals matches missing value | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Not equals with comma separated values | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _id equals with comma separated values | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Error on invalid search parameter | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Patient search without resource type | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Subject search without resource type | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search on array columns using reference tables | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search on single columns using reference tables | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search sort order | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search with negated filter | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search on canonical reference | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Rejects too long chained search | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › disableChainedSearch › Rejects chained search through disabled type: %s | skipped | platform | disableChainedSearch (Medplum config) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › disableChainedSearch › Allows chained search not using disabled reference table: %s | skipped | platform | disableChainedSearch (Medplum config) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › disableChainedSearch › Chained search works again after reindex | skipped | platform | disableChainedSearch (Medplum config) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Invalid chained search parameters: %s | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search with modifier | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search deduplication | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token search deduplication | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include references success | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include canonical success | skipped | include | not yet ported (Task 4) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include PlanDefinition mixed types | skipped | include | not yet ported (Task 4) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include references invalid search param | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse include Provenance | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse include canonical | skipped | include | not yet ported (Task 4) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reverse include on denied type | skipped | platform | access policy |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Chained search through denied type | skipped | platform | access policy |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include:iterate | skipped | include | not yet ported (Task 4) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include with target type | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _revinclude with target type | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _revinclude:iterate | skipped | include | not yet ported (Task 4) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include depth limit | skipped | include | not yet ported (Task 4) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include on empty search results | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _include on page boundary | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Include with invalid reference | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › DiagnosticReport category with system | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Encounter.period date search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Encounter.period dateTime search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Condition.code system search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Condition.code :not next URL | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference identifier search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Task patient identifier search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by dedicated token column search parameter, identifier | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by a shared token column search param, _security | skipped | meta | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by _source | skipped | meta | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Resource meta search params › Search by _tag | skipped | meta | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Token :text search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › birthdate covers all hours: %d (%s) | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › birthdate with multiple values | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter search | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter eq | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter with UUID value | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter birthdate eq | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter ne | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter re | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter with reverse chained search | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter sw | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › _filter with chained search | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › reverse chain with prefix modifier | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Lookup table exact match with comma disjunction | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Duplicate rows from token lookup | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter Task by due-date › with %s %s | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Filter Task by due-date › multiple resources | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Get estimated count with filter on human name | skipped | platform | getCount / estimate-count internals |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Organization by name | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Ambiguous search columns | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Practitioner by email is case insensitive | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Practitioner by identifier is case sensitive | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Patient by name with stop word | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Sort by ID | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Numeric parameter | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Disjunction with lookup tables | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Sort by unknown search parameter | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Date range search | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Multiple resource types with _type | skipped | type | not yet ported (Task 5) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Multiple resource types with _type uses offset pagination across combined results | skipped | type | not yet ported (Task 5) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Binary search not allowed | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreCareTeamRole | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreConditionAssertedDate | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreEncounterDischargeDisposition | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCoreGoalDescription | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › US Core Search Parameters › USCorePatient race, ethnicity, genderIdentity | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search patterns | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search with inline resource | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Basic reference | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Reference values with special characters | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Array reference column | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Invalid reference field | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Reference with sort | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › narrowed fields | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Multiple types | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Error on cursor and offset | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Cursor pagination | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Cursor pagination dedupes across page boundaries | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › Cursor pagination with multiple resource types from _type | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › searchByReference › V1 cursor is not parsed as V2 | skipped | platform | Repository.searchByReference, a Medplum method with no HTTP route |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param: bare uuid matches (DeviceRequest.encounter) | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param: bare uuid matches (PractitionerRole.practitioner) | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param on array column: bare uuid matches (Encounter.location) | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Back-compat: bare uuid on multi-target subject column still defaults to Patient | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Non-uuid bare value is not rewritten (avoids corrupting unrelated values) | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Quantity search › Basic | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Quantity search › With units | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Quantity search › Approximately | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Invalid canonical chained search link | skipped | chain | not yet ported (Task 6) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › Date array columns match search value %s | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › discourage sequential scans › config.fhirSearchDiscourageSeqScan | skipped | platform | SQL planner internals (discourage sequential scans) |
| server/src/fhir/search.test.ts | project-scoped Repository w/ %j › discourage sequential scans › config.fhirSearchMinLimit | skipped | platform | SQL planner internals (discourage sequential scans) |
| server/src/fhir/search.test.ts | systemRepo › Filter by _project | skipped | platform | systemRepo _project |
| server/src/fhir/search.test.ts | systemRepo › Sort by _project; desc=%s | skipped | platform | systemRepo _project |
| server/src/fhir/search.test.ts | systemRepo › Filter by _lastUpdated | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | systemRepo › Sort by _lastUpdated | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | systemRepo › Should calculate count with join | skipped | platform | getCount / SQL shape |
| server/src/fhir/search.test.ts | systemRepo › maxResourceVersion | skipped | platform | maxResourceVersion (Medplum internal) |
| server/src/fhir/search.test.ts | systemRepo › Search for deleted resources | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | systemRepo › Reverse chained search with _filter | skipped | filter | not yet ported (Task 8) |
| server/src/fhir/search.test.ts | systemRepo › invalid operators and modifiers › Reject invalid operator or modifier for %s | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search.test.ts | parseChainedParameter › reverse chained search with prefix operators | skipped | platform | parseChainedParameter unit test |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by Appointment.end | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by Slot.end | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by DiagnosticReport.study | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by Flag.category | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search by AsyncJob.type and AsyncJob.status | skipped | platform | Medplum-only resource type / project |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for Practitioner by qualification-code | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for PractitionerRole by network | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for Login by project | skipped | platform | Medplum-only resource type / project |
| server/src/fhir/search-params.test.ts | Medplum Custom Search Parameters › Search for CoverageEligibilityRequest by coverage | skipped | existing | not yet ported (Task 3a) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch success | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › FHIRPath Patch in batch | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction success | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction rollback | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Create batch wrong content type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional create in transaction | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional update in transaction | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction bundle with ifMatch version checking | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction bundle with ifMatch fails on version mismatch | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch FHIRPath PATCH with stale ifMatch fails and does not modify resource | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch DELETE with ifMatch | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch FHIRPath PATCH with current ifMatch succeeds and persists | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction PATCH with stale ifMatch rolls back the whole transaction | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional update (create-as-update) in transaction | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Resolved intra-Bundle reference cycle with referential integrity validation | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Failed referential integrity check in transaction Bundle | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Conditional reference resolution | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Process batch create ifNoneExist invalid resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Batch create as update with client-assigned ID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Repeated batch of related upserts | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch does not retry on failure | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch resumes after graceful shutdown | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch makes partial results available when cancelled | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Transaction bundle account propagation | skipped | platform | project/account compartments |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Nested transaction in batch | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › _include regression test | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Rate limited during batch execution | skipped | platform | rate limits |
| server/src/fhir/batch.test.ts | Batch and Transaction processing › Async batch sleeps over rate limit | skipped | platform | async batch job |
| server/src/fhir/batch.test.ts | Transaction bundle SERIALIZABLE retry › does not silently drop writes on serialization failure | skipped | platform | Medplum database isolation internals |
| server/src/fhir/repo.test.ts | FHIR Repo › getRepoForLogin | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Enterprise access is limited to super admins | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › setMode routes reads to reader until writer promotion › on creates | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › setMode routes reads to reader until writer promotion › on updates | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › getSearchProjectIds | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Read resource with undefined id | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Read resource with blank id | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Read resource with invalid id | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Read Binary requires access to securityContext | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Write Binary rejects Binary securityContext | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Read invalid resource with `checkCacheOnly` set | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Read AuditEvent after update | skipped | platform | Medplum AuditEvent logging |
| server/src/fhir/repo.test.ts | FHIR Repo › Does not cache reads from the reader | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Only caches on read when cacheResourcesOnWrite is disabled | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Repo read malformed reference | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Read references with various reference shapes | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Logs mixed cache access for readReferences across split resource types | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Logs mixed SQL access for multi-type search across split resource types | skipped | platform | Medplum cache and reader/writer routing |
| server/src/fhir/repo.test.ts | FHIR Repo › Includes numResults in search AuditEvent entity detail | skipped | platform | Medplum AuditEvent logging |
| server/src/fhir/repo.test.ts | FHIR Repo › Logs mixed transaction access across repo and system repo | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Read history › options: %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Read history › with config.maxSearchOffset | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient remove meta.profile | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › meta.project preserved after attempting to remove it | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient no changes | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update patient multiple names | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient with custom ID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient with no author | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as system ignores submitted meta.author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Super Admin update ignores submitted meta.author | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient ignores submitted meta.deleted | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update Patient ignores submitted meta.deleted | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as ClientApplication with no author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as Practitioner with no author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create Patient as Practitioner on behalf of author | skipped | platform | login/author (GA store has no users) |
| server/src/fhir/repo.test.ts | FHIR Repo › Skip background jobs when configured | skipped | platform | background jobs |
| server/src/fhir/repo.test.ts | FHIR Repo › Create resource with lastUpdated | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Create ResearchDefinition with long description (%s) | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with lastUpdated | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with missing id | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with matching versionId | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Update resource with different versionId | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with matching versionId | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with different versionId | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Delete resource with ifMatch | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with implicit array creation | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with FHIRPath Patch body | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with empty FHIRPath Patch body | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Patch resource with invalid FHIRPath Patch body | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Compartment permissions | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Read history after delete | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › readVersion returns an unshared resource | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Restore deleted resource | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Delete Binary | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex resource as non-admin | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex resource not found | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex mixed resource types not allowed | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Reindex resource errors logged | skipped | platform | reindex job |
| server/src/fhir/repo.test.ts | FHIR Repo › Remove property | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Delete Questionnaire.subjectType | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Empty objects | skipped | existing | not yet ported (Task 3b) |
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
| server/src/fhir/repo.test.ts | FHIR Repo › Malformed client assigned ID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional update | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Double DELETE | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution failure | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution multiple matches | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference resolution requires a project | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Conditional reference replaced before validation | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Prevents setting Project compartments | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Super admin can edit User.meta.project | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Super admin can edit Subscription.meta.project | skipped | platform | access policy |
| server/src/fhir/repo.test.ts | FHIR Repo › Handles resources with many entries stored in lookup table | skipped | platform | SQL storage internals |
| server/src/fhir/repo.test.ts | FHIR Repo › __version column | skipped | platform | SQL storage internals |
| server/src/fhir/repo.test.ts | FHIR Repo › Legacy UUID support -- non-conformant IDs that match UUID form are accepted | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/repo.test.ts | FHIR Repo › Project.exportedResourceType | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › Project.exportedResourceType allows resources in primary project | skipped | platform | project/_project |
| server/src/fhir/repo.test.ts | FHIR Repo › constructor and clone add the synthetic R4 project only once to shared context | skipped | platform | project/_project |
| server/src/fhir/binary.test.ts | Binary › Create and read binary | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Read binary not found | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Read binary without stored content | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Update and read binary | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Binary CORS | skipped | platform | CORS (Medplum server middleware) |
| server/src/fhir/binary.test.ts | Binary › Unsupported content encoding | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Deflate | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › GZIP | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Update with GZIP | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Upload binary in batch | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Update JSON | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Invalid Binary JSON | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Handle non-binary JSON | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/binary.test.ts | Binary › Error for disallowed file type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Default statement | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Include resource types | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Exclude resource types | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Read-only endpoint | skipped | platform | Medplum CapabilityStatement build options |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Per resource type interactions | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/metadata.test.ts | CapabilityStatement › Search parameters are still generated for included resource types | skipped | existing | not yet ported (Task 3b) |
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
| server/src/fhir/references.test.ts | Reference checks › Check references on write | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/references.test.ts | Reference checks › References to resources in linked Project | skipped | platform | project/_project |
| server/src/fhir/references.test.ts | Reference checks › Project reference validation | skipped | platform | project/_project |
| server/src/fhir/references.test.ts | Reference checks › ProjectMembership reference validation | skipped | platform | project/_project |
| server/src/fhir/references.test.ts | Reference checks › Check references with non-literal reference | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/references.test.ts | Reference checks › Check references with reference placeholder | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/references.test.ts | Reference checks › Resources with identical references | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Identifier | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › %s with empty value does not throw errors | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Multiple identifiers | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Update identifier | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Implicit exact | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Explicit exact | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › prefix on Patient-identifier | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-identifier | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-telecom | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-email | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › :contains › infix on Patient-phone | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Not equals | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Search comma separated identifier exact | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Search on system | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Non-array identifier | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Leading whitespace | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › CodeableConcept text | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Identifier value with pipe | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Missing/present › %s :%s %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › With systemRepo › Condition.code :%s search | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Non-strict mode › Handle malformed system | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Non-strict mode › Handle malformed value | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › Sort by identifier | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › Sort by identifier with multiple values | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by system %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by value %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by system and value %s\|%s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code by missing system and value %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code and category by code=%s category=%s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :contains beginning of value %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :contains middle of value %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :text %s | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/tokens.test.ts | Token-based searches › Condition.code token queries › code :text search for special chars › :text search for %s should match? %s | skipped | existing | not yet ported (Task 3b) (title appears twice in Medplum) |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Formerly "legacy" column implementation search params use `token-column` strategy | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Search by system only works when using token columns | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Search by value always works | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Search by system and value only works when using token columns | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › MedicationRequest.code legacy behavior › Sort by code always works | skipped | platform | Medplum token column vs legacy implementation |
| server/src/fhir/tokens.test.ts | Token-based searches › buildTokens › empty resource | skipped | platform | buildTokens unit test (Medplum token columns) |
| server/src/fhir/searchunique.test.ts | searchUnique › Multiple matches are logged once per window and the first match is returned | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Get CapabilityStatement anonymously | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Get CapabilityStatement authenticated | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Get versions anonymously | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Get SMART-on-FHIR configuration | skipped | platform | auth / SMART config (GA store has one bearer token) |
| server/src/fhir/routes.test.ts | FHIR Routes › Invalid JSON | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource success with %s FHIR JSON response format | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource invalid resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource incorrect resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Create resource invalid content type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource _pretty | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource invalid UUID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource invalid resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource not found | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource minimal | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource history | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource history invalid UUID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource history invalid resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version invalid UUID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version invalid version UUID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version invalid resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Read resource version not found | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource not modified | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource not modified with empty strings | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource invalid | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource wrong content-type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource missing ID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource not found | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource with precondition | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Update resource with failed precondition | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource with failed precondition | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource invalid UUID | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Delete resource invalid resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource not found | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource wrong content type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource invalid resource type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource invalid result | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Patch resource success | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › FHIRPath Patch resource success | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search by POST | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search by POST with multiple includes | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › On %s › Search multiple resource types with _type | skipped | type | not yet ported (Task 5) |
| server/src/fhir/routes.test.ts | FHIR Routes › chainedSearchOnReader only routes chained searches to reader | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › readonlyBatchOnReader only routes read-only batches to reader | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › readonlyBatchOnReader does not break a nested read-only batch inside a transaction | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › Search invalid resource | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Search invalid search parameter | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate create success | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate create failure | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate unwraps the resource parameter of a Parameters body | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate rejects a Parameters body without a resource parameter | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Validate wrong content type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/routes.test.ts | FHIR Routes › Reindex resource access denied | skipped | platform | reindex job |
| server/src/fhir/routes.test.ts | FHIR Routes › Resend subscriptions access denied | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › Resend as project admin | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › ProjectMembership with null access policy | skipped | platform | access policy / project / reader routing |
| server/src/fhir/routes.test.ts | FHIR Routes › Set accounts on create | skipped | platform | access policy / project / reader routing |
| server/src/fhir/structure.test.ts | FHIR structure › Can search Organization on _profile | skipped | meta | not yet ported (Task 8) |
| server/src/fhir/structure.test.ts | FHIR structure › Can search MedicinalProductManufactured on _profile | skipped | meta | not yet ported (Task 8) |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Success | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Inline DocumentReference attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Project setting enables inline DocumentReference attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Cursor pagination with _type | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything Operation › Skips inlining attachments when the attachment cannot fit or be read | skipped | existing | not yet ported (Task 3b) |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Identifies inlineable Binary attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Reads current and versioned Binary attachments | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Reads string and Buffer stream chunks into a Buffer | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | Patient Everything inline attachments helpers › Returns undefined and destroys the stream when the max byte count is exceeded | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/patienteverything.test.ts | searchPatientCompartment › Successfully paginates through resource types | skipped | platform | inline attachments setting / Medplum helper |
| server/src/fhir/operations/expand.test.ts | Expand › No ValueSet URL | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › ValueSet not found | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › No logical definition | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › No filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Multiple filters | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Invalid filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Filter token limit | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Success | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Success with count and offset | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › No duplicates | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Marital status | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Handle punctuation | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Handle empty string after punctuation | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › No null `display` field | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › User uploaded ValueSet | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › CodeSystem resolution | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › ValueSet that uses expansion instead of compose | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Returns error for recursive definition | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Subsumption | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Returns error when CodeSystem not found | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Prefers current Project version of common CodeSystem | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Prefers CodeSystem from linked Projects in link order | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Does not leak extended metadata when multiple ValueSets share a URL | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Expands ValueSet with explicit concepts from fragment CodeSystem | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Returns error when property filter is invalid for CodeSystem | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Includes ancestor code in is-a filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Text filter with is-a | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Excludes ancestor code in descendent-of filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Hierarchy filters › Text filter with descendent-of | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › %s ValueSet shape has correct filter behavior › $name | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › $name | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › Sort order is deterministic when rows tie on relevance | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Code prefix filter › Pagination is stable across offset windows | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Cost-based parent-filter strategy › countCandidatesBounded returns min(actual, limit) | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Cost-based parent-filter strategy › descendant and ancestor strategies return identical members | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Recursive subsumption | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Recursive subsumption with filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Filter out abstract codes | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter with multiple values | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter with exists=true | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Property filter with exists=false | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Reference to other ValueSet | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Display text override | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Minimum filter size for hierarchical expansion | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Expand with empty filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Expand with trailing quote | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Exact code match | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Exact code match with abstract filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Include pre-expanded ValueSet | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Resolve synonyms | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Condenses multiple synonyms in expansion | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › addExpansionItems() allows items out of order | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Searches translated designations | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Only returns one (default) matching translation | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Honors ValueSet designation overrides | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Base resources are not shadowed for Super Admin | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Display language › $name | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Display language › Ancestor and descendant strategies agree under displayLanguage | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/expand.test.ts | Expand › Display language › Paging counts codes, not translation rows | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Success | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Renders description for relationship and simple properties | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Coding parameter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Not found | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › No full coding specified | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Checks project | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Lookup using specific CodeSystem version | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Prefers complete CodeSystem over example even when example is newer | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Excludes retired CodeSystem from selection | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › GET endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › GET instance endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Error on instance system URL mismatch | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Instance endpoint with coding | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Error on instance coding system mismatch | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Correctly renders imported properties of different types | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemlookup.test.ts | CodeSystem lookup › Outputs translated designations | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Explicitly included code succeeds | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Filter included code succeeds: %j | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Filter excluded code fails | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Returns negative result on display mismatch | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Returns negative result when no coding matches | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Returns error when no coding specified | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates coding via property filter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates coding via property filter with multiple values | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates code when only example CodeSystem is present | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Does not validate display without authoritative CodeSystem | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › GET endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › GET instance endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Instance endpoint with coding | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates code against an include with multiple filters | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Validates system-less coding matched by a later include | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/valuesetvalidatecode.test.ts | ValueSet validate-code › Falls back to validating system URL when CodeSystem unavailable | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Success | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Coding parameter | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Not found | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › No full coding specified | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Checks project | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Falls back to validating system URL | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Lookup using specific CodeSystem version | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › GET endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › GET instance endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Fail on instance system URL mismatch | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Instance endpoint with coding | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Fail on instance coding system mismatch | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › Returns specified displayLanguage | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/codesystemvalidatecode.test.ts | CodeSystem validate-code › validateCodings | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Subsumes | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Subsumed by | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Equivalent | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Not subsumed | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › Returns error on incomplete input | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › GET endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| server/src/fhir/operations/subsumes.test.ts | CodeSystem subsumes › GET instance endpoint | plan-2 | terminology | deferred to plan 2 (terminology) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Batch success | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Batch invalid bundle | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Read resource by ID | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Read resource by ID not found | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update incorrect resource type | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update incorrect ID | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update incorrect precondition | skipped | existing | not yet ported (Task 3c) (title appears twice in Medplum) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Update with correct precondition | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Delete with precondition | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Search by post | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Search multiple types | skipped | type | not yet ported (Task 5) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional update | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional update with unparsed query string | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Patch resource | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional PATCH | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Conditional delete | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Create resource with query param account | skipped | platform | project/account compartments |
| fhir-router/src/fhirrouter.test.ts | FHIR Router › Custom system-level operation returns not found | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch with missing bundle type | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch with invalid bundle type | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch with missing entries | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch success | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch create success | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch create missing resource | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch create missing resourceType | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch create ignore http fullUrl | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch create does not rewrite identifier | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch create ifNoneExist success | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch create ifNoneExist multiple matches | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Use ifNoneExist result in other reference | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch update | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch update missing resource | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch patch | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch patch Parameters | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch FHIRPath patch | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch FHIRPath patch rewrites local references | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Batch FHIRPath PATCH with matching If-Match succeeds | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Batch FHIRPath PATCH with stale If-Match fails with 412 | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Batch PUT with stale If-Match fails with 412 | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › If-Match preconditions › Transaction PATCH with stale If-Match fails the whole transaction | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › JSONPath error messages | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › JSONPatch error messages | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch patch invalid url | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch patch missing resource | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch patch wrong patch type | skipped | existing | not yet ported (Task 3c) (title appears twice in Medplum) |
| fhir-router/src/batch.test.ts | Batch › Process batch delete | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch delete invalid URL | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch missing request | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch missing request.method | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch unsupported request.method | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch missing request.url | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch not found | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process batch read history | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Conditional interactions | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Dispatches batch telemetry once across transaction retries | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Process Transactions › Embedded urn:uuid | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process Transactions › Encoded urn:uuid | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Process Transactions › Transaction update after create | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Valid null | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Concurrent conditional create in transactions | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Local reference resolution for update | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › No self-assigned ID in upsert | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Full run matches one-shot processBatch behavior | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Placeholder references survive serialize -> fromState -> resume | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Resume does not reprocess already-completed entries | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › processNextEntry before preprocess throws | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Re-entrant processing › Malformed entries are captured as preprocess results | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Transaction resource type tracking › Gathers resource types from transaction entries | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Transaction resource type tracking › De-duplicates repeated resource types | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/batch.test.ts | Batch › Transaction resource type tracking › Skips system-level entries with no resource type | skipped | platform | Medplum batch internals (re-entrant state, telemetry) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › Search entries are tagged with mode "match" | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include resolves a literal reference | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include does not throw on a dangling reference | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include with a target type filters by that type | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include deduplicates resources referenced more than once | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include does not re-include a resource already in the match set | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _revinclude resolves reverse references | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _revinclude with a target type filters the base resources | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include:iterate follows a chain of references | skipped | include | not yet ported (Task 4) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include without :iterate does not recurse | skipped | include | not yet ported (Task 4) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _include resolves canonical references by exact URL | skipped | include | not yet ported (Task 4) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › _revinclude resolves canonical references | skipped | include | not yet ported (Task 4) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › Invalid include parameter throws badRequest | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/search-include.test.ts | MemoryRepository _include/_revinclude › Empty match set skips include processing | skipped | existing | not yet ported (Task 3c) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Missing query | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Syntax error | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Introspection forbidden | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Introspection allowed | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Allows value introspection | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read by ID | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read by ID not found | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search with _id | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search with _count | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Search with based-on | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Sort by _lastUpdated asc | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Sort by _lastUpdated desc | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read resource by reference | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Read resource by reference not found | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup with _reference | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup on contained resource with invalid id | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup without _reference | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup with Connection API and count | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reverse lookup with Connection API count only (no edges) | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Max depth | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Max depth override | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › StructureDefinition query | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › _offset list field argument | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › _count list field argument | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › fhirpath list field argument | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › List field argument by name | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Extension list field argument | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › List field argument null values | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Connection API | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Connection API without count field | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Connection API without edges field | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Create Patient Record | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Create wrong resourceType error | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Updating Patient Record | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Invalid Update Mutation | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Update wrong resourceType error | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Update wrong ID error | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Delete Patient Record | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Reference missing reference property | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Fragment inclusion | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Cursor pagination | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Patch Patient Record | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Invalid Patch Mutation | plan-3 | graphql | deferred to plan 3 (GraphQL) |
| fhir-router/src/graphql/graphql.test.ts | GraphQL › Invalid Patch Operations | plan-3 | graphql | deferred to plan 3 (GraphQL) |
