# Spike: @medplum/ccda in place of the Microsoft FHIR Converter

Throwaway spike, branch `spike-ccda`. Not for merge.

## Question

Can `@medplum/ccda` 5.2.15 (Apache-2.0, pure TypeScript, runs in process) replace the Microsoft FHIR Converter (.NET container, called over HTTP by `convertCcda` in `src/ccda.ts`) for C-CDA import, so GA can run in one small container?

## Method

- Inputs: GA's synthetic fixture `tests/fixtures/ccda-synthetic.xml`, plus the owner's 8 Epic C-CDA documents (US Realm Header 2015-08-01/2023-05-01, Epic CCD flavour, 170-780 KB each). The originals were downloaded read-only from their stored Binaries. All copies, outputs and diffs stayed in the session scratchpad, outside the repo. This document has counts only.
- Boundary: `convertCcda` returns `repair(raw, xml)`. Everything after `repair` (`collapsePatients` → `topoSort` → `stableIdentifier` → writes) works on generic FHIR. So each document was run four ways: MS raw, MS + `repair`, Medplum raw, Medplum + `repair`. Both `repair` outputs then went through `collapsePatients`, `topoSort` (exported on this branch only) and `stableIdentifier`. Nothing was written to Medplum.
- Medplum call: `convertCcdaToFhir(convertXmlToCcda(xml), { ignoreUnsupportedSections: true })` after a small pre-pass, `promote()`, described under the first gap below.
- Matching (field coverage): same class, same day and an overlapping code (any coding code, text or display). Medications and allergies are matched on the drug or the document only, because the two converters pick different dates. Coverage tables combine all 9 documents. The type-count table lists the synthetic fixture separately.
- Scripts (no data): `spike/fetch.ts`, `spike/convert.ts`, `spike/counts.ts`, `spike/coverage.ts`, `spike/pipeline.ts`, `spike/dropped.ts`, `spike/rss.ts`, `spike/sections.ts`.

## Headline

Out of the box, `@medplum/ccda` **throws on all 8 Epic documents** (`Unhandled substance administration templateId: 2.16.840.1.113883.10.20.22.2.1`). The synthetic fixture converts cleanly. With a 10-line pre-pass and `ignoreUnsupportedSections`, all 8 convert in 14-60 ms each. Labs, vitals, immunizations, the problem list and the patient then come out about as well as MS, and some fields come out better.

Four gaps remain:

- **106 of 138 Conditions are missing.** These are all the encounter diagnoses.
- **Vaccine CVX codes are not recognised.** GA does not know Medplum's CVX system URI, so 0 of 148 immunizations count for `vaccine_gaps`, against 125 with MS.
- **Allergy category is always `food`.**
- **Medications have no identifiers.**

Also, every record's stable key differs from the MS-era key except Immunization. Each new Epic summary repeats history that GA already holds from the MS-era import. After a switch, Observations would mostly merge, or be tagged `possible-duplicate`, through the same-code, same-day check. Conditions, Encounters, medications, allergies and Compositions would be written a second time without a tag.

## Results

### Resource counts by type (8 owner documents)

| Type | MS raw | MS + repair | Medplum raw | Medplum + repair |
|---|---|---|---|---|
| Observation | 420 | 420 | 608 | 608 |
| Condition | 138 | 138 | 32 | 32 |
| Immunization | 148 | 148 | 148 | 148 |
| DiagnosticReport | 43 | 43 | 0 | 0 |
| MedicationStatement | 9 | 9 | 0 | 0 |
| MedicationRequest | 5 | 5 | 9 | 9 |
| Medication | 9 | 9 | 0 | 0 |
| AllergyIntolerance | 8 | 8 | 8 | 8 |
| Encounter | 18 | 18 | 19 | 19 |
| Procedure | 0 | 0 | 2 | 2 |
| Goal | 0 | 0 | 42 | 42 |
| CareTeam | 0 | 0 | 8 | 8 |
| RelatedPerson | 0 | 0 | 8 | 8 |
| Practitioner | 23 | 23 | 420 | 420 |
| PractitionerRole | 0 | 0 | 133 | 133 |
| Organization | 14 | 14 | 141 | 141 |
| Location | 13 | 13 | 0 | 0 |
| Device | 8 | 8 | 0 | 0 |
| Coverage | 6 | 6 | 0 | 0 |
| DocumentReference | 8 | 0 (dropped) | 0 | 0 |
| Composition / Patient | 8 / 8 | 8 / 8 | 8 / 8 | 8 / 8 |

Synthetic fixture, MS → Medplum: Observation 3 → 5 (2 organizer panels), Condition 2 → 2, MedicationStatement + Medication → 1 MedicationRequest, DiagnosticReport 1 → 0. All matched fields agree, including LOINC, value, unit, date, category, problem status and RxNorm.

### Matching summary (after `repair`, 9 documents)

| Class | MS | Medplum | Matched | Only MS | Only Medplum |
|---|---|---|---|---|---|
| Observation | 423 | 613 | 360 | 63 | 253 |
| Condition | 140 | 34 | 34 | 106 | 0 |
| Medication (Statement/Request) | 15 | 10 | 10 | 5 | 0 |
| Immunization | 148 | 148 | 141 | 7 | 7 |
| AllergyIntolerance | 8 | 8 | 8 | 0 | 0 |
| Encounter | 18 | 19 | 12 | 6 | 7 |
| Patient / Composition | 9 / 9 | 9 / 9 | 9 / 9 | 0 | 0 |

Unmatched Observations, by category:

- **Only MS:**
  - 43 laboratory with no code and no value. These are MS artifacts, not data.
  - 3 laboratory with a value.
  - 17 social-history.
- **Only Medplum:**
  - 107 survey with a value, plus 3 survey with no value.
  - 107 panels (`hasMember`): 44 lab, 47 survey, 16 vital-signs.
  - 25 social-history.
  - 8 with no category.
  - 3 laboratory with a value.

So no lab results are lost outright.

### Field coverage on matched records

The columns count records where both converters have the field: equal or different. The last two columns count records where only one converter has it.

**Observation (360 matched)**

| Field | Both, equal | Both, different | Only MS | Only Medplum |
|---|---|---|---|---|
| code system+code set | 316 | 44 (Medplum adds SNOMED/CPT/Epic local codings) | 0 | 0 |
| LOINC code | 337 | 0 | 0 | 0 |
| code.display | 84 | 21 | 14 | 0 |
| code.text | 0 | 0 | 0 | 351 |
| value[x] | 278 | 2 | 14 | 8 |
| unit | 187 | 0 | 0 | 0 |
| UCUM system on quantity | 0 | 0 | 0 | 187 |
| effective date | 352 | 0 | 0 | 0 |
| referenceRange | 126 | 0 | 0 | 4 |
| interpretation | 0 | 0 | **30** | 0 |
| category | 360 | 0 | 0 | 0 |
| status | 360 | 0 | 0 | 0 |

- **Dropped values.** In one conversion of the 8 documents, Medplum dropped 14 `REAL` and 11 `ED` values ("Unhandled observation value type"). After conversion, 23 non-panel lab Observations have no value, against 11 meaningful ones in MS.
- **Interpretation.** Interpretation is never mapped. All 30 affected results have a numeric value and a reference range, so `labs.ts` still flags out-of-range results from the range.
- **Panel dates.** 43 of the 44 lab panel Observations have no effective date. MS made DiagnosticReports with a period instead.

**Condition (34 matched: all problem-list items)**

- **Equal on all 34:** clinicalStatus, onset and category (`problem-list-item`).
- **Codes:** both carry the ICD-10-CM code (OID system) on all 34. Medplum also carries SNOMED, ICD-9 and IMO codings on 32, and `code.text` on 32. MS has no text.
- **Only Medplum:** recordedDate (34) and verificationStatus (33).
- **Identifier:** `identifier[0]` differs on all 34. Medplum puts the concern act id first, MS the problem observation id.
- **Encounter diagnoses: 0 of 106 in Medplum.** Medplum reads only `RSON` observation relationships on an encounter. The XML has exactly 106 Encounter Diagnosis acts (template 22.4.80), all wrapped in `SUBJ` entryRelationships.
- **`repair`** still works on Medplum Conditions: it looks the source id up across all identifiers and changed all 32.

**Medications (10 matched)**

- **Equal on all 8 with RxNorm:** RxNorm code. Status is equal on 8 of 10.
- **Name:** differs on 9. GA's `repair` takes the name from the narrative. Medplum uses the code displayName, and `repair` cannot rename it: Medplum emits no Medication resource and no identifier on MedicationRequest.
- **Start date:** differs on 7. Medplum uses `authoredOn` and `dispenseRequest.validityPeriod`, MS `effectivePeriod`.
- **Dosage text:** absent in both.
- **Unmatched:** the 5 extra MS MedicationRequests have no Medplum counterpart. Where they come from in the XML was not checked.
- **Resource type:** every Medplum medication is a MedicationRequest. `current_medications` reads both types.

**Immunization (141 matched)**

- **Equal on all 141:** date and status. The CVX code is equal on 125 when either system spelling counts.
- **CVX system spelling:** MS uses `urn:oid:2.16.840.1.113883.12.292`, which GA aliases. Medplum uses `http://nucc.org/cvx`, which GA does not. Through `doseOf`, MS gives 125 trusted CVX codes and Medplum gives 0.
- **Only Medplum:** lot number (105), performer (98), manufacturer and text.
- **Only MS:** route (89).

**AllergyIntolerance (8, all without an allergen code)**

- **Equal:** clinicalStatus.
- **Only Medplum:** type `allergy` and category **`food`** on all 8. The category is hard-coded in the library, so a "no known allergies" entry would read as a food allergy.

**Encounter (12 matched)**

- **Equal:** period start and end.
- **Different:** class (Medplum v3-ActCode, MS an Epic local system) and status (Medplum `finished`/`in-progress`, MS `unknown` via `repair`).
- **Only Medplum:** type (12).
- **Only MS:** location (12).
- **Neither:** diagnosis.

**Patient (9)**

Identifiers, name, birth date, gender, address, telecom, race and ethnicity are all equal.

**Composition (9)**

- **Equal:** title, type, section count and author.
- **Only Medplum:** section narrative and `section.entry` references.
- **Different:** custodian (Medplum adds a display). GA reads the custodian from the XML anyway.

**Practitioner / Organization**

Medplum makes one resource per author or performer occurrence: 420 Practitioners for 23 distinct people. GA's stable key collapses these to 95 Practitioner, 56 Organization and 40 PractitionerRole keys, against 23, 14 and 0 for MS. That is more shared records and more writes.

### Rest of GA's pre-write pipeline

- `collapsePatients` + `topoSort`: no errors and no reference cycles on either output. The Composition entry references and `hasMember` links are fine.
- `stableIdentifier` keys shared between MS and Medplum output:

| Type | Shared keys |
|---|---|
| Immunization | 148 of 148 |
| Practitioner | 11 of 23 |
| Organization | 8 of 14 |
| Everything else (Observation, Condition, Medication*, Encounter, Allergy, Composition) | 0 |

  - **Observation:** the key includes a content hash, which differs (code.text, UCUM system, extensions).
  - **Condition:** `identifier[0]` differs.
  - **MedicationRequest:** has no identifier, so its key falls back to a content hash.
  - **Duplicates after a switch:** the same file is not re-imported, because `storeDocument` matches its hash. The risk is new documents that repeat old history.
    - Observations go through the engine's content match (same code and day): equal value and time merges, otherwise the record is tagged `possible-duplicate`.
    - Every other type gets no duplicate check from a C-CDA source (C-CDA link candidates return none). Those types would be created again, untagged.

### Section handling (Epic flavour)

- Medplum dispatches on `section.templateId[0]` only.
- Epic lists the entries-optional root first (for example Medications `...22.2.1` before `...22.2.1.1`). For substanceAdministration, Medplum accepts only the entries-required Medications OID. That causes the throw.
- `promote()` moves the `<root>.1` template first.
- With `ignoreUnsupportedSections`, act entries in these sections are skipped silently:
  - Instructions (22.2.45)
  - IHE History of Present Illness (1.3.6.1.4.1.19376.1.5.3.1.3.4)
- Payers (22.2.18) and IHE Reason for Referral are skipped by design. MS made Coverage from Payers, which GA never shares.
- Observations outside the plan-of-care section all go through the vitals path. That is why social history, functional status and reason for visit appear as `survey` and `social-history` Observations. Plan-of-care observations become Goals (42).

## What GA's fixups would need to change

1. **Pre-pass on the parsed `Ccda`:** `promote()`, plus a call with `ignoreUnsupportedSections: true`. About 10 lines; done in `spike/convert.ts`.
2. **Encounter diagnoses:** turn Epic 22.4.80 acts into the shape Medplum reads (an `RSON` observation), or emit those Conditions in GA. Then `repair` sets `encounter-diagnosis` as it does today. This is the largest item: about 50-80 lines plus tests.
3. **CVX:** add `http://nucc.org/cvx` to `ALIAS` in `concept-apply.ts` and to `CVX` in `vaccines.ts`. Better, normalise it to `http://hl7.org/fhir/sid/cvx` in `repair`. 2 lines.
4. **Allergy:** drop Medplum's hard-coded `category: ['food']` unless the source value says food. A few lines.
5. **Medications:** `repair` must handle MedicationRequest with an inline `medicationCodeableConcept`. Today it renames Medication resources and sets MedicationStatement status, both found by source id. Medplum gives no id, so GA would have to match entries by position or by code, or patch the library to keep `substanceAdministration/id`.
6. **Values:** recover `REAL` and `ED` values that Medplum drops (about 12 lab values here), either by a post-pass reading the XML by observation id or by patching the library.
7. **Panels:** decide how to treat dateless `hasMember` panel Observations. Either drop them, or map them to DiagnosticReport the way MS did.
8. **New types:** RelatedPerson (8) is a contact record. GA should drop it, since contact records are never shared and it is not in `COMPARTMENT`. Goal, CareTeam and PractitionerRole would be new kinds of record in GA.
9. **Migration for the existing install:** stable keys change for everything but immunizations. Options:
   - Delete C-CDA-sourced records and re-import. Records a person edited, and source conflicts, need care.
   - Make `ccdaKey` converter-independent: key Observations on source id + code + date + value, and Conditions on the problem observation id.
10. **Already handled by GA's generic pipeline:** `repair`'s Condition logic, `collapsePatients`, `topoSort` and dropping DocumentReference all work unchanged.

## Performance

| Doc size | MS over HTTP (ms) | Medplum in process (ms) |
|---|---|---|
| 10 KB (synthetic) | 29 | 1 |
| 170-290 KB (6 docs) | 52-98 | 14-21 |
| 524 KB | 191 | 39 |
| 784 KB | 252 | 60 |
| All 8 docs | 851 | 198 warm, 257 cold (fresh process) |

The per-document Medplum times are warm: they are the third conversion of each document in one process.

- **Medplum memory (peak RSS):**
  - Bare Node: 37 MB.
  - After loading the library: 45 MB resident. The 81 MB peak at that point includes Node loading and stripping the `.ts` script, so it is not the library's own cost.
  - Largest single document: 122 MB.
  - All 8 in one process: 172 MB.
- **MS converter container:** 514 MiB resident, image 243 MB on local disk.

## Dependency weight and licence

- Licence: Apache-2.0, the same as GA.
- Direct dependencies: `@medplum/core` 5.2.15 and `fast-xml-parser` 5.11.2. GA already pins `fast-xml-parser` 5.11.2 and `@medplum/core` 5.2.14.
- Install size: 7.7 MB. The `dist` folder is 3.4 MB (ESM and CJS), plus a nested `@medplum/core` 5.2.15 (4.3 MB). Bumping GA's core pin to 5.2.15 would remove the nested copy.
- No new transitive packages.
- Runtime: the ESM bundle is one 144 KB module whose only import is `fast-xml-parser`. The core helpers are inlined.
- Errors seen:
  - The template throw above.
  - `console.warn` for unhandled value types: it writes to stderr, so GA's MCP stdio is safe.
  - No other exceptions.

## Recommendation

**Replace with fixups, but not as a drop-in.** Two things decide it:

1. **The library is not ready for Epic documents as shipped.** Without fixups it fails on every document, and with the pre-pass it still loses encounter diagnoses and vaccine codes.
2. **A switch duplicates existing records.** Every C-CDA record except immunizations gets a new key.

The converter itself is small, fast, licence-compatible and on several fields richer than MS:

- SNOMED codes and text on problems
- encounter type and status
- lot numbers
- UCUM systems
- narrative

So it fits the one-container goal once fixups 1-9 land with a key migration.

Until then, the cheap interim is **keep MS on demand**: start the converter container only during `ga import` of a C-CDA, for example from a compose profile, so the always-on footprint is one container.

## Effort estimate

- **Fixups 1-8 with unit tests against the synthetic fixture, extended with an Epic-style medications section and encounter diagnosis:** about 3 days.
- **Key migration (converter-independent `ccdaKey`, or delete-and-reimport with protection for person-edited records), plus an integration run on a copy of the owner's data:** about 2 days.
- **Total: about 1 week.**
- **Patching the library upstream instead:** fixups 2, 5 and 6 are small changes to its 1,500-line `ccda-to-fhir.ts`, and GA's side shrinks to 1, 3, 4, 7 and 8. This depends on how fast Medplum reviews patches.
