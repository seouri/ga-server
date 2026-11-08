# Patches against @medplum/ccda 5.2.15

Source: https://github.com/medplum/medplum/tree/v5.2.15/packages/ccda (Apache-2.0, see LICENSE).

| # | File | Change | Why | Upstream |
|---|------|--------|-----|----------|
| 0 | all `*.ts` | mechanical: strip-only TypeScript: relative imports get `.ts`; `index.ts` no longer re-exports `./fhir-to-ccda/convert` | Node runs .ts directly; `fhir-to-ccda/` is not vendored | none (GA only) |
| 1 | `ccda-to-fhir.ts`, `oids.ts` | section entries routed by any of the section's templateIds (`getTemplateIds`), not `templateId[0]`; Medications entries-optional and V2 roots routed; `OID_PROBLEMS_SECTION_V2_ENTRIES_REQUIRED` loses its stray space. Test `test/section-template-order.test.ts` | Epic lists the entries-optional root first: every Epic document threw (or, ignoring unsupported sections, lost its medications); replaces GA's `promote()` pre-pass | existing issue medplum#10671 (proposes this fix; no PR yet); draft `docs/superpowers/upstream/ccda/1-section-template-order.md` |
| 2 | `ccda-to-fhir.ts` | an observation with no templateId (and a goal with no statusCode) converts: `processObservation` uses `getTemplateIds(observation)` (a goal matched by any of its templates), `mapGoalLifecycleStatus` reads `statusCode?.` Test `test/observation-without-template.test.ts` | `observation.templateId[0]` threw a TypeError and refused the whole document | new issue (none open); may fold into the #10671 PR, same cause; draft `docs/superpowers/upstream/ccda/2-observation-without-template.md` |
| 3 | `ccda-to-fhir.ts`, `types.ts` | external PR medplum#11242 applied unchanged (head c1e81639): narrative references (`#id`) resolve to the section narrative text in codes; text `ED` observation values become `valueString`. Test `test/narrative-reference.test.ts` (ported to vitest) | note, instruction and referral entries (rows 5-6) carry their text only by reference; ED values were dropped (Task 7's ED half lands here) | existing PR medplum#11242 (fixes #11202, #10659); draft `docs/superpowers/upstream/ccda/3-narrative-references.md` |
| 4 | `ccda-to-fhir.ts` | care team organizer: every member act (`component.act[]`) and every performer of each act becomes a `CareTeam.participant` (`processCareTeamMembers`). Test `test/care-team-members.test.ts` | only `component.act[0]` and `act.performer[0]` were read; other members were silently lost | new issue (none open); draft `docs/superpowers/upstream/ccda/4-care-team-members.md` |
| 5 | `ccda-to-fhir.ts`, `oids.ts` | a Note Activity (`22.4.202`) in any section, and every act in the Notes (`22.2.65`), Instructions (`22.2.45`, V2) and IHE History of Present Illness (`1.3.6.1.4.1.19376.1.5.3.1.3.4`, new `OID_HISTORY_OF_PRESENT_ILLNESS_SECTION`) sections, becomes a `DocumentReference`: text/plain attachment (the act text or the narrative it references, via row 3), type = act code, category = section code, context.period from effectiveTime, author, source ids. Test `test/note-sections.test.ts` | these entries were skipped (Notes: "not yet implemented"; the others unsupported); notes are what GA's `notes_search` reads | new issue (none open); draft `docs/superpowers/upstream/ccda/5-note-sections.md`; needs medplum#11242 |
| 6 | `ccda-to-fhir.ts` | acts in the IHE Reason for Referral section (and V2) become a `ServiceRequest`: status and intent from statusCode/moodCode, category SNOMED 3457005 "Patient referral", code, occurrence, requester (author), performers, narrative text as `note`, source ids. Test `test/referral-section.test.ts` | referrals were skipped ("not yet implemented") | new issue (none open); draft `docs/superpowers/upstream/ccda/6-referral-section.md`; needs medplum#11242 for the text |
| 7 | `ccda-to-fhir.ts`, `types.ts`, `xml.ts` | Payers section (and V2): each Policy Activity of a Coverage Activity becomes a `Coverage`: identifier (policy id, then covered party member id), status `active` (C-CDA has none), type (policy code), beneficiary, subscriberId (policy holder id), relationship and period (covered party), payor (payer performer org id and name; data-absent `unknown` when none), order (sequenceNumber). `processAct` may return several resources. `act.participant` parsed as an array; `CcdaParticipant.time`. Test `test/payers-section.test.ts` | payers were skipped ("not yet implemented"); the Microsoft path made Coverage. Guarantor and the policy holder's own name/address have no Coverage field: GA names them in notImported | new issue (none open); draft `docs/superpowers/upstream/ccda/7-payers-coverage.md` |

Upstream already used `import type` for type-only imports; no other syntax needed rewriting.

## Section → resource (with rows 1-7)

Every section's narrative is also on the Composition (`section.text`). Anything a section holds that no row turns into a record is named in GA's `notImported` (src/ccda.ts).

| Section (templateId root) | Entries become | Notes |
|---|---|---|
| Problems (22.2.5, .5.1, V2), Health Concerns (22.2.58) | Condition | concern act; first SUBJ observation (others named) |
| Allergies (22.2.6, .6.1, V2) | AllergyIntolerance | |
| Medications (22.2.1, .1.1, V2) | MedicationRequest | entries-optional root routed (row 1) |
| Immunizations (22.2.2, .2.1) | Immunization | |
| Results, Vital Signs, Social History, Functional Status (22.2.14), Reason for Visit (22.2.12), any other observation section | Observation (organizer: panel Observation with `hasMember`) | the library's "vitals" path |
| Encounters (22.2.22, .22.1) | Encounter (+ Condition per RSON observation) | Epic visit diagnoses (22.4.80): Task 5 |
| Procedures (22.2.7.1) | Procedure | |
| Plan of Treatment (22.2.10) | CarePlan (acts), Goal (observations), MedicationRequest (substanceAdministrations); narrative on the Composition | |
| Goals (22.2.60) | Goal | |
| Care Teams (22.2.500) | CareTeam, one participant per member performer (row 4) | |
| Instructions (22.2.45, V2) | DocumentReference (text/plain) | row 5 |
| History of Present Illness (IHE 1.3.6.1.4.1.19376.1.5.3.1.3.4) | DocumentReference (text/plain) | row 5 |
| Notes (22.2.65), e.g. Progress Notes; a Note Activity (22.4.202) in any section | DocumentReference (text/plain) | row 5 |
| Reason for Referral (IHE 1.3.6.1.4.1.19376.1.5.3.1.3.1, V2) | ServiceRequest | row 6 |
| Payers (22.2.18, V2) | Coverage, one per Policy Activity; never shared | row 7 |
| Narrative-only sections (no entries), and entries no row handles | Composition `section.text` | entries named in `notImported` |

## Omitted

- `src/fhir-to-ccda/` (GA only converts C-CDA to FHIR).
- Tests dropped: `roundtrip` and `g9` (both call `convertFhirToCcda`), `b1` (needs upstream `testdata/` sample set of 6 large government files).
- `test/` ported to vitest: explicit `import ... from 'vitest'`, `.ts` imports, `import.meta.dirname` for `__dirname`. `test/synthetic-fixture.test.ts` is GA's own. `testdata/` keeps only the 4 files `nullflavor` reads.

## Build config

- `tsconfig.json` includes `vendor`; it type-checks under GA's strict settings unchanged. `@medplum/core` stays 5.2.14 (no 5.2.15 export needed).
