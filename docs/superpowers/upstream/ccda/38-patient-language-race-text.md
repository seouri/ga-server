# 38. Patient language and the US Core race/ethnicity text

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: Patient loses languageCommunication; race and ethnicity extensions lack `text`

`createPatient` reads `raceCode` and `ethnicGroupCode` but never `languageCommunication`, so the patient's language and whether it is preferred are dropped. The race and ethnicity extensions it writes hold only `ombCategory`; US Core requires the `text` sub-extension (1..1) on both.

Reproduction (synthetic), inside `recordTarget/patientRole/patient`:

```xml
<raceCode code="2106-3" codeSystem="2.16.840.1.113883.6.238" displayName="White"/>
<languageCommunication><languageCode code="es"/><preferenceInd value="true"/></languageCommunication>
```

Expected: `communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: "es", display: "Spanish" }] }, preferred: true }]`, and the race extension also holding `{ url: "text", valueString: "White" }`. Actual: no `communication`; no `text`.

## PR: fix(ccda): Patient.communication and race/ethnicity text

- `ccda-to-fhir.ts`: `mapLanguageCommunication` (display from `Intl.DisplayNames`, omitted for a tag it cannot name); `mapCategoryText` (original text, else display names joined).
- `types.ts`: `CcdaLanguageCommunication.preferenceInd`.
- Test `patient-demographics.test.ts`.

## Filing metadata

- PATCHES rows: 38 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): d9cee49 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
