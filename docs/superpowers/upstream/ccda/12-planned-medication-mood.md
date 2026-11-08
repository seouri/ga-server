# 12. Planned medications: moodCode sets intent (existing fix on a fork)

Nothing new to file. The issue is open: **medplum#10847** ("C-CDA to FHIR ignores moodCode on planned medications, so Plan of Treatment entries import as intent \"order\""). Its author has a fix ready on a fork: commit [`6f245b1`](https://github.com/jacekprzybyl/medplum/commit/6f245b1c1bdeaf4b3f5c46defcb0921dcc4d593e) on `jacekprzybyl/medplum` branch `fix/ccda-planned-medication-mood`, with no PR opened yet. GA carries that commit's change as row 12 of `vendor/medplum-ccda/PATCHES.md`. Drop the row when a Medplum release contains it.

What the commit changes:

- In the Plan of Treatment section, `moodCode` sets `MedicationRequest.intent`: `PRP` → `proposal`, `INT` → `plan`, `PRMS` → `plan`, `RQO` → `order` (`PLANNED_MEDICATION_MOOD_MAPPER`). A missing or unknown moodCode keeps `order`.
- The Medications section keeps `order`.
- A single `effectiveTime/@value` becomes `dispenseRequest.validityPeriod.start` instead of `{}`.

How GA applied it:

- **By hand.** Row 1 (medplum#10671) changed the routing in `processSubstanceAdministration` to loop over every section templateId, so the commit's switch hunk does not apply as-is. The same cases are routed: all four Medications section roots → `'order'`, Plan of Treatment → the mapped mood.
- **Test.** `test/planned-medication.test.ts` is ported to vitest. The ONC-sample case is dropped because GA does not vendor `testdata/170.315_b1_toc_amb_ccd_r21_sample1_v13.xml`.

If the fork commit changes before it becomes a PR, re-apply its final diff and rerun `npx vitest run vendor`. Drafts 13 and 14 build on its `intent` parameter.
