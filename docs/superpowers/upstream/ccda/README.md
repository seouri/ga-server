# Upstream drafts for the vendored C-CDA fixes

GA vendors `@medplum/ccda` 5.2.15 in `vendor/medplum-ccda/` and fixes it there (`vendor/medplum-ccda/PATCHES.md`). Each draft below is an issue plus a PR description for one fix. **Nothing is filed or sent anywhere.**

## What is posted

Only a draft's `Issue` and `PR` sections (and its amendment sections, which belong to the PR) are posted. Everything under `GA-internal (do not post)` (filing metadata, how GA applied it, notes above the Issue) stays here. Approval (the owner approves each item first) is a step of this README, not of the drafts.

Reproduction XML shows section or entry fragments only. Wrap them in a minimal ClinicalDocument (a `recordTarget` with a patient, and `component/structuredBody` around the section) when posting; `vendor/medplum-ccda/test/convert-sections.ts` is the wrapper the vendored tests use.

## Filing process

1. The owner approves one item (a row of the table below) at a time. Nothing is filed without that.
2. Open the issue from the draft (title, problem, synthetic reproduction, expected FHIR). Medplum accepts outside PRs only when they link an issue a maintainer has invited (the "vouched" / `open-to-community` label), so the PR is never first.
3. Wait for the invite label on the issue. Do not open the PR before.
4. Open the PR from the draft's PR section, linking the issue, with the test named there. The vendored commit(s) are the reference diff: port them to the upstream file layout (GA's copy only differs by `.ts` import extensions and a few rows of earlier patches).
5. When a Medplum release contains the fix, drop its `PATCHES.md` row and vendored change.

Row 0 (mechanical: strip-only TypeScript) is **GA only, not for upstream**: it exists so Node runs the files directly. Rows 35, 43, 45, 48, 49 and 50 amend another row and have no draft of their own: they sit inside the draft they point at (35 in 26, 43 in 7, 45 and 48 in 40, 49 and 50 in 47). Row 14 may stay a GA patch: upstream may prefer the C-CDA on FHIR mood to intent mapping over a MedicationStatement.

Each draft ends with a `Filing metadata` block (rows, commits, external work, dependencies). Drafts contain synthetic data only (checked: no real names, addresses, identifiers, Epic organization OIDs or free text from a document).

## Index, in suggested filing order

### Wave 1: routing and parsing crashes (small, high value, invited issue exists)

| Draft | Title | PATCHES rows | Vendored commits | External work | Depends on | Status |
|---|---|---|---|---|---|---|
| [1-section-template-order.md](1-section-template-order.md) | Route section entries by any templateId | 1 | 5090775 | issue medplum#10671 | - | issue-first (invited issue exists) |
| [2-observation-without-template.md](2-observation-without-template.md) | An observation without a templateId refuses the whole document | 2 | 274250c | - | 1 (same cause; may fold into its PR) | issue-first |

### Wave 2: observation values, results and immunization fixes (independent)

| Draft | Title | PATCHES rows | Vendored commits | External work | Depends on | Status |
|---|---|---|---|---|---|---|
| [18-observation-interpretation.md](18-observation-interpretation.md) | Result interpretation codes → Observation.interpretation | 18 | e8dd672 | - | - | issue-first |
| [20-result-organizer-report.md](20-result-organizer-report.md) | Result Organizer → DiagnosticReport | 20 | ff9a701 | - | 17 | issue-first |
| [21-observation-category.md](21-observation-category.md) | Observation category from the section when the observation's own template has none | 21 | 7a72b3c, 50834ba | - | - | issue-first |
| [22-coded-ordinal-value.md](22-coded-ordinal-value.md) | CO (Coded Ordinal) observation values are codes | 22 | 57c35ad | - | - | issue-first |
| [23-planned-observation-request.md](23-planned-observation-request.md) | Planned observations in Plan of Treatment → ServiceRequest, not Goal | 23 | 9c7f7fa, f56b651 | - | 6, 17 | issue-first |
| [24-goal-empty-target.md](24-goal-empty-target.md) | A Goal gets no empty target or category | 24 | 02ce415 | - | - | issue-first |
| [25-observation-without-code.md](25-observation-without-code.md) | An observation with a value but no code is kept | 25 | cd148ca | - | - | issue-first |
| [26-timestamp-boolean-values.md](26-timestamp-boolean-values.md) | TS and BL observation values | 26, 35 | 4a40fb4, 44802b2 | - | 16 (neighbouring case) | issue-first |
| [27-cvx-system.md](27-cvx-system.md) | CVX code system URI | 27 | df39876 | - | - | issue-first |
| [28-immunization-route.md](28-immunization-route.md) | Immunization route | 28 | 4000e5d | - | - | issue-first |
| [36-immunization-not-given.md](36-immunization-not-given.md) | Immunization not given (negationInd) | 36 | 902bde7 | - | - | issue-first |
| [52-allergy-negation.md](52-allergy-negation.md) | No known allergies, and a negated allergy | 52 | see draft | - | 29 (same function) | issue-first |
| [37-null-flavor-values.md](37-null-flavor-values.md) | A nullFlavor observation value is data-absent | 37 | d1898d7 | - | 26 | issue-first |

### Wave 3: document and encounter structure, categories, names

| Draft | Title | PATCHES rows | Vendored commits | External work | Depends on | Status |
|---|---|---|---|---|---|---|
| [4-care-team-members.md](4-care-team-members.md) | Care team: every member and every performer | 4 | 0dc3444 | - | - | issue-first |
| [9-concern-observations.md](9-concern-observations.md) | Concern acts with several observations → one record each | 9 | fb3e513 (docs 02d5e09, 9dcb59c) | - | 29 touches the same allergy body | issue-first |
| [10-encounter-diagnoses.md](10-encounter-diagnoses.md) | Encounter Diagnosis acts → Conditions linked to their Encounter | 10 | ab6ee22 | - | 9 | issue-first |
| [30-document-subject.md](30-document-subject.md) | Composition and CareTeam subject; section mode | 30 | a043cda | - | - | issue-first |
| [31-encounter-class.md](31-encounter-class.md) | Encounter class from an ActCode only | 31 | 155d3ca | - | - | issue-first |
| [32-encounter-location.md](32-encounter-location.md) | Encounter location | 32 | 22338ab | - | - | issue-first |
| [38-patient-language-race-text.md](38-patient-language-race-text.md) | Patient language and the US Core race/ethnicity text | 38 | d9cee49 | - | - | issue-first |
| [47-empty-and-text-names.md](47-empty-and-text-names.md) | Empty and text-only person names | 47, 49, 50 | 6abc9b4, e4315aa, 57bf61d | - | - | issue-first |
| [53-problem-status.md](53-problem-status.md) | Problem clinical status from the status observation and the end date | 53 | see draft | - | 9, 10 (same function) | issue-first |
| [54-condition-verification-system.md](54-condition-verification-system.md) | Condition verification status code system | 54 | see draft | - | 53 (same function) | issue-first |
| [55-indication-category.md](55-indication-category.md) | An encounter's indication Condition has a category | 55 | see draft | - | - | issue-first |

### Wave 4: narrative text sections (need medplum#11242 merged)

| Draft | Title | PATCHES rows | Vendored commits | External work | Depends on | Status |
|---|---|---|---|---|---|---|
| [5-note-sections.md](5-note-sections.md) | Notes, Instructions and History of Present Illness entries → DocumentReference | 5 | b1ad72e | - | 3 (PR medplum#11242) | issue-first |
| [6-referral-section.md](6-referral-section.md) | Reason for Referral → ServiceRequest | 6 | 2e7b889 | - | 3 (PR medplum#11242) | issue-first |
| [8-care-plan-text.md](8-care-plan-text.md) | Plan of Treatment act text by reference → CarePlan.description | 8 | 50f8b78 | - | 3 (PR medplum#11242) | issue-first |
| [11-title-markup.md](11-title-markup.md) | Titles with markup → plain text | 11 | 87a09a4, 75dee73 | - | - | issue-first |

### Wave 5: medications (12 first, then 13, 14, 15)

| Draft | Title | PATCHES rows | Vendored commits | External work | Depends on | Status |
|---|---|---|---|---|---|---|
| [13-medication-identifiers.md](13-medication-identifiers.md) | Medication records keep the substanceAdministration id | 13 | 0f0e77e | - | - | issue-first |
| [14-medication-statement.md](14-medication-statement.md) | A Medication Activity in the Medications section becomes a MedicationStatement | 14 | ff145f5, b31e280 (docs f879df3) | - | 12, 13 | issue-first; may stay a GA patch (upstream may prefer the IG mood route) |
| [15-medication-supplies.md](15-medication-supplies.md) | A medication's supply orders and dispenses become MedicationRequest and MedicationDispense | 15 | 1677fd3, 4512d3a, 1e31c57 | - | 12, 13, 14 | issue-first |
| [51-medication-not-taken.md](51-medication-not-taken.md) | A negated medication list entry is not-taken | 51 | 84a347c | - | 14 | issue-first |

### Wave 6: shared resources and what builds on them (33, then 34, 39, 40, 41, 44; 7 and 42 payers; 46)

| Draft | Title | PATCHES rows | Vendored commits | External work | Depends on | Status |
|---|---|---|---|---|---|---|
| [7-payers-coverage.md](7-payers-coverage.md) | Payers → Coverage | 7, 43 | fba4572, 257e865 | - | - | issue-first |
| [33-shared-resources.md](33-shared-resources.md) | One Practitioner, Organization and Location per identifier | 33 | 596c79e, 1d7ec27 | - | 32 | issue-first |
| [34-document-authors-device.md](34-document-authors-device.md) | Every document author; an authoring device is a Device | 34 | 40adb9a | - | 33 | issue-first |
| [39-document-attester.md](39-document-attester.md) | The document's authenticators are Composition attesters | 39 | 4094ef1 | - | 33 | issue-first |
| [40-encompassing-encounter.md](40-encompassing-encounter.md) | The encompassing encounter is the Composition encounter | 40, 45, 48 | 117b10c, ec5ca6a, 52466f0 | - | 31, 32, 33 | issue-first |
| [41-result-organizer-performer.md](41-result-organizer-performer.md) | A Result Organizer's performer is the DiagnosticReport performer | 41 | 10c24ca | - | 20, 33 | issue-first |
| [42-payment-typology-system.md](42-payment-typology-system.md) | Source of Payment Typology keeps its system | 42 | 9192f09 | - | 7 | issue-first |
| [44-assigned-entity-specialty.md](44-assigned-entity-specialty.md) | An assigned entity's code is the PractitionerRole specialty | 44 | 82c08e9 | - | 33 | issue-first |
| [46-result-organizer-components.md](46-result-organizer-components.md) | A Result Organizer's procedures, specimens and encounter | 46 | 2db9cc0 | - | 20 | issue-first |

### Already filed by others: nothing to file (carry until released)

| Draft | Title | PATCHES rows | Vendored commits | External work | Depends on | Status |
|---|---|---|---|---|---|---|
| [3-narrative-references.md](3-narrative-references.md) | Narrative references and ED values (existing PR) | 3 | 599e15d | PR medplum#11242 (fixes #11202, #10659) | - | external PR, nothing to file |
| [12-planned-medication-mood.md](12-planned-medication-mood.md) | Planned medications: moodCode sets intent (existing fix on a fork) | 12 | 79457b3 | issue medplum#10847 (fix on a fork, no PR) | - | external, nothing to file |
| [16-real-values.md](16-real-values.md) | REAL observation values (existing PR) | 16 | f554466 | PR medplum#11241 (fixes #11201) | - | external PR, nothing to file |
| [17-interval-effective-time.md](17-interval-effective-time.md) | Interval effectiveTime on observations and organizers (existing PR) | 17 | 668e567 | PR medplum#11244 (fixes #11203) | - | external PR, nothing to file |
| [19-family-history.md](19-family-history.md) | Family History organizers → FamilyMemberHistory (existing PR, applied with one GA change) | 19 | aa1d08f, 1578cdf | PR medplum#11243 (fixes #11200) | 1, 4 (applied by hand onto their routing) | external PR; GA additions (1578cdf) could be proposed in its review |
| [29-allergy-category-type.md](29-allergy-category-type.md) | Allergy category and type from the observation value | 29 | b74e576, 43f871c | PR medplum#11308 (fixes #11298) | 9 | external PR; 43f871c is GA's accounting only |
