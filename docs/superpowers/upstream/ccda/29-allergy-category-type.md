# 29. Allergy category and type from the observation value

> Nothing to post: this is existing external work. The whole draft is GA-internal and never posted.

Existing PR medplum#11308 (fixes #11298), head 16b30642. Nothing new to file: GA applies it by hand.

## What GA applied

The PR's diff unchanged in substance: `ALLERGY_INTOLERANCE_TYPE_CODES` and `mapCcdaAllergyCategoryAndType` in `systems.ts`, and in the AllergyIntolerance builder `...mapCcdaAllergyCategoryAndType(observation.value)` in place of `type: 'allergy'`, `category: ['food']` and the `414285001` check. Its test `allergy-category-type.test.ts` ported to vitest (the document built by GA's `convertSections` helper); on the unpatched code it fails 14 of 15 cases, as the PR says.

## Why by hand

GA's draft 9 (one AllergyIntolerance per SUBJ observation of a concern act) moved the allergy body from `processAllergyIntoleranceAct` into `processAllergyIntoleranceObservation(act, observation, index)`, so the PR's hunk context (`id: this.mapId(act.id)`) no longer matches. If draft 9 lands first, the PR needs the same three-line move; if #11308 lands first, draft 9 rebases over it.

## Synthetic reproduction (from the PR)

```xml
<observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.7" extension="2014-06-09"/>
  <id root="00000000-0000-4000-8000-0000000000a2"/>
  <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/>
  <statusCode code="completed"/>
  <value xsi:type="CD" code="416098002" codeSystem="2.16.840.1.113883.6.96"/>
  <participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">
    <code code="4053" codeSystem="2.16.840.1.113883.6.88" displayName="Erythromycin"/>
  </playingEntity></participantRole></participant>
</observation>
```

Expected: `"category": ["medication"], "type": "allergy"`. Before: `"category": ["food"], "type": "allergy"`.

## Filing metadata (GA-internal)

- PATCHES rows: 29 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): b74e576, 43f871c (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: PR medplum#11308 (fixes #11298)
- Depends on / builds on: drafts 9
- Status: external PR; 43f871c is GA's accounting only. Nothing filed (the README has the approval process).
