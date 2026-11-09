# 52. No known allergies, and a negated allergy (negationInd)

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Same function as draft 29 (`processAllergyIntoleranceObservation`).

## Issue: @medplum/ccda: "no known allergies" converts as a nameless active allergy

An Allergy - Intolerance Observation (`2.16.840.1.113883.10.20.22.4.7`) with `negationInd="true"` states an absence: with no substance participant (or a `nullFlavor` substance) it is "no known allergies"; with a substance, the patient is not allergic to it. The converter ignores `negationInd`, so the first becomes an `AllergyIntolerance` with no `code`, active and confirmed, and the second an allergy to the substance.

Reproduction (synthetic):

```xml
<observation classCode="OBS" moodCode="EVN" negationInd="true">
  <templateId root="2.16.840.1.113883.10.20.22.4.7" extension="2014-06-09"/>
  <id root="00000000-0000-4000-8000-0000000000b2"/>
  <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><statusCode code="completed"/>
  <value xsi:type="CD" code="419199007" codeSystem="2.16.840.1.113883.6.96" displayName="Allergy to substance"/>
</observation>
```

Expected: `"code": { "coding": [{ "system": "http://snomed.info/sct", "code": "716186003", "display": "No known allergy" }] }` (US Core's no-known-allergies pattern), active and confirmed. With a substance: that substance, `verificationStatus` `refuted`, `clinicalStatus` `inactive`. Actual: no `code` (or the substance), `confirmed`.

## PR: fix(ccda): a negated allergy observation is "no known allergy" or a refuted substance

- `ccda-to-fhir.ts`: when `negationInd="true"`, no substance → `code` SNOMED 716186003; a substance → `verificationStatus` `refuted`, `clinicalStatus` `inactive`.
- Test `allergy-negation.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 52 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): the commit that adds this draft (`git log --oneline -- docs/superpowers/upstream/ccda/52-allergy-negation.md`)
