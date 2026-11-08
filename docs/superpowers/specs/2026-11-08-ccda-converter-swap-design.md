# C-CDA converter swap: Design

Second of the one-click-deploy projects (after GA's own FHIR store). Legend: **[user]** decided by the owner, **[call]** designer's call (open to override), **[spike]** measured in the throwaway spike.

Spike write-up: `docs/superpowers/spikes/2026-11-08-ccda-converter.md` (owner's 8 Epic C-CDA documents, counts only).

## Intent

GA converts C-CDA documents (Epic "Health Summary" exports, and any C-CDA a person imports) to FHIR with Microsoft's FHIR Converter: a .NET container of about 400-500 MB, called over HTTP by `convertCcda` in `src/ccda.ts`. It is too heavy for the small always-on deploy GA is heading for, and it already runs only on demand (compose profile `ccda`). Medplum's `@medplum/ccda` (Apache-2.0, TypeScript, in process, 14-60 ms per document) can replace it **[spike]**.

The owner's measure of success: **everything in their files ends up in GA, including what is skipped today [user]**. The swap is a code change, not a data change: after it, the record must match what the Microsoft path gives or hold more; never less, never duplicates **[user]**.

## Goals

- **In process:** C-CDA conversion runs inside GA (CLI `ga import`, the MCP `ga_import`/gateway `import_file` paths) with `@medplum/ccda`; the Microsoft converter container and the `ccda` compose profile are removed at the end.
- **Same or more:** for each of the owner's 8 documents, every entry the Microsoft path turned into a GA record has an equal-or-richer counterpart from the new path, and entries the Microsoft path skipped are imported too **[user]**.
- **Nothing silently skipped:** every C-CDA section and entry either becomes a GA record or is named in the import report as not imported, with the reason ("fail loudly", as the store) **[user/call]**. A document with anything unaccounted for is flagged.
- **Fix defects where they belong:** in `@medplum/ccda`, as upstream pull requests; GA carries each fix as a temporary patch until Medplum releases it, then drops the patch and moves to the release **[user]**.

## Non-goals

- The SQLite store switch, Medplum removal, the Deploy page (later projects).
- Converting other formats (HL7v2, EHI, Apple Health keep their own importers).
- FHIR-to-C-CDA export (the library has it; GA does not need it).

## Anti-goals

- Duplicates from the swap or from testing it **[user]**.
- Any record lost compared with today **[user]**.
- Tests, the rehearsal or dry runs writing to the owner's real record (standing rule; see the 2026-11-08 leak finding in the store gate write-up: tests must use a test Patient, and the importer now refuses a record pointing at another patient).
- PHI in the repo: comparisons and reports are counts, element paths and section names only; the owner's documents stay outside the repo.

## Decisions

### What gets imported

- **Everything the Microsoft path imports today**, by type: Observation (labs, vitals, social history), Condition (problem list and visit diagnoses), Immunization, DiagnosticReport, MedicationStatement/MedicationRequest/Medication, AllergyIntolerance, Encounter, Procedure, Practitioner, Organization, Location, Device, Composition, Patient (collapsed into the GA Patient as today).
- **Plus what is skipped today [user]:** Instructions, History of Present Illness, Reason for Referral, Reason for Visit, Functional Status, Progress Notes and every other section's content; Payers (insurance) as Coverage. Sections without a natural FHIR resource keep their content as text on the right record (for example the Composition section narrative, or a DocumentReference/ClinicalImpression the builder picks), never dropped **[call: builder picks the resource per section, documented in a table]**.
- **New record kinds the library produces** (Goal, CareTeam, PractitionerRole) are kept. RelatedPerson (contacts) is kept but never shared, like other contact records **[call]**.
- **Sharing rules unchanged:** Coverage and contact records stay in the never-shared list; the Composition stays never shared (its narrative includes insurance).

### Defects: upstream first, temporary patch in GA [user]

Known defects on the owner's documents **[spike]** and where each is fixed:

| Defect | Fix |
|---|---|
| Throws on every Epic document (section dispatch reads only the first templateId) | Upstream; GA patch meanwhile |
| Visit diagnoses (Epic encounter diagnosis act 22.4.80) dropped: 106 of 138 Conditions | Upstream; GA patch meanwhile |
| Vaccine CVX system URI GA doesn't recognise (0 of 148 count for `vaccine_gaps`) | Upstream to the standard `http://hl7.org/fhir/sid/cvx`; GA patch meanwhile |
| Allergy category hard-coded `food` | Upstream (an open external PR covers it: medplum#11308); GA patch meanwhile |
| Medication entries lose `substanceAdministration/id` | Upstream; GA patch meanwhile |
| `REAL` and `ED` values dropped (about 25 values) | Upstream (open external PRs medplum#11241, #11242); GA patch meanwhile |
| Sections skipped (Instructions, HPI, Payers, Reason for Referral) and no DiagnosticReport/Location/Device | Upstream where the library should own it; otherwise GA |

- **Upstream process:** Medplum closes outside pull requests that are not linked to an issue a maintainer invited. So: open an issue per defect (with a synthetic, PHI-free reproduction), wait for the invite, then open the PR. Reuse existing open PRs rather than duplicating them. **Nothing is opened publicly without the owner's go-ahead per issue/PR [user]**; it goes out under the owner's GitHub account.
- **The patch:** GA applies its fixes to the installed library reproducibly at every install (fresh clone, `npm ci`, Docker build), with no new npm dependency **[call: mechanism left to the builder, e.g. a vendored patched copy or a patch file applied by an npm script; recorded with its reason]**. Each fix is one reviewable unit that maps to one upstream PR, so dropping it after a release is mechanical. Bump `@medplum/core` to the version `@medplum/ccda` needs so no nested copy is installed.
- **Truly GA concerns stay in GA:** the "nothing lost" accounting, GA's `repair` step (problem list vs visit diagnosis, statuses), identity, and the replacement step below.

### Proving it before anything changes [user]

A comparison command (CLI, read-only) converts each document both ways (the Microsoft container started on demand for this) and compares entry by entry, keyed by the source entry ids in the XML:

- every Microsoft-path record has a new-path record for the same source entry with equal or more information (a field present in the old one is present in the new one with the same meaning; differences are listed and each needs a reason);
- entries the new path adds are listed as gains;
- every section and entry is accounted for (imported, or named with a reason).

Output: counts, element paths, section names, template ids. The swap proceeds only when the report on the owner's 8 documents has no loss and the owner has read it.

**"Never less" means every loss is fixed [user].** A difference may only be explained, not fixed, when the old record holds no information (for example the Microsoft path's 43 empty lab placeholders). Every other loss the spike found is in scope and fixed, upstream first like the defects above: lab interpretation (30), immunization route (89), encounter location (12), medication names from the narrative, "taking" (MedicationStatement) not downgraded to "ordered" (MedicationRequest), the 5 Microsoft-only medication orders, and the 17 social-history and 3 lab results only the Microsoft path produces. Expected effort: about two to three weeks, not the spike's one.

### Replacing the existing C-CDA records [user]

After the comparison passes, the replace is **rehearsed on a copy of the owner's record [user]**: copied (read-only from the live store) into a throwaway store outside the repo, the whole replace run there, the comparison run against the result, the copy deleted; reports hold counts only (the store project's dry run is the pattern). Then one owner-started command (CLI only, like `ga migrate-store`), with a backup first:

1. Remove what the old C-CDA imports wrote. A record whose only source is C-CDA is deleted. A record also held from another source (EHI, portal sync, PDF, Apple) keeps its other sources: only its C-CDA identifier and C-CDA-only contribution come off **[user: "all good"]**. A protected record (`person-edited`, `source-conflict`, agent-written) is never deleted: it keeps its body and only its C-CDA identifier is replaced by the new one **[call; the owner's record has none today, 36 C-CDA records carry `possible-duplicate`, which the re-import recomputes]**. If any C-CDA record's source document is not among GA's stored documents, the command refuses to run **[call; the owner has 8 stored C-CDA documents and 8 source files]**.
2. Re-import all stored C-CDA documents with the new code (the original files stay where they are; GA already keeps each one as a stored document).
3. Re-imported records keep their original arrival time, so `whats_new` and the iMessage alerts do not report years of old results as new **[user]**. Records only the new path produces (gains) take their document's original import time, for the same reason **[call]**.
4. Anything that pointed at a replaced record is repointed to its new copy: `record_followup`/`postpone` reminders (`Basic`), concept mappings, possible-duplicate pointers, shares' scoping. The command refuses to finish while anything still points at a deleted record **[user]**; a record something points at that has no new counterpart is kept rather than deleted, so the command can always finish **[call]**.
5. Run the comparison again against the real record; then remove the Microsoft converter (compose service, profile, `converterUrl` config, `CONVERTER_DOWN` message, docs).

The command is idempotent and resumable (a crash midway can be rerun), has a dry run that changes nothing and reports counts, and works on both stores (Medplum default; SQLite store for tests).

### Identity after the swap

New-path records get stable keys from source entry ids (as today's `ccdaKey`), so re-importing the same document is a no-op and a newer Epic summary repeating old history updates instead of duplicating. Keys must not depend on converter-produced content that can change between library versions **[call]**: content may only separate genuinely id-less or id-colliding entries, and the builder documents the rule.

## Constraints

- Node 26 strip-only TypeScript, vitest; no new npm dependencies beyond `@medplum/ccda` (and the matching `@medplum/core` bump).
- The store separability principle is untouched: the converter lives in GA, not in `src/store`.
- Medplum stays the default store; everything works on both stores.
- Memory: conversion in process must fit the gateway (peak per document about 122 MB, all 8 in one process 172 MB **[spike]**); convert one document at a time.
- Tests use the synthetic fixture (`tests/fixtures/ccda-synthetic.xml`), extended with PHI-free Epic-style cases for each defect; never the owner's documents.
- Docs: README, docs/operations.md, AGENTS.md (C-CDA section), docs/usage.md where they mention the converter.

## Left to the builder

The patch mechanism; which FHIR resource holds each currently skipped section; the comparison's exact matching rules and report format; how C-CDA-only contributions are removed from merged records; the order of upstream issues; whether the comparison command and the replace command are one command with modes or two.
