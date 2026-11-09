# 51. Medication not taken (negationInd)

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Same function as drafts 13-15 (test file shared); builds on 14 (a Medications entry is a MedicationStatement).

## Issue: @medplum/ccda: a negated Medication Activity converts as an active medication

A Medication Activity (`2.16.840.1.113883.10.20.22.4.16`) with `negationInd="true"` states the patient is not taking the drug. Some EHRs write their "no medications" list entry this way (moodCode `INT`, statusCode `active`, a no-medication concept as the drug code). The converter ignores `negationInd`, so the result reads as a medication the patient takes.

Reproduction (synthetic):

```xml
<substanceAdministration classCode="SBADM" moodCode="INT" negationInd="true">
  <templateId root="2.16.840.1.113883.10.20.22.4.16" extension="2014-06-09"/>
  <id root="2.16.840.1.113883.19.5" extension="MED-1"/>
  <statusCode code="active"/>
  <effectiveTime xsi:type="IVL_TS"><low value="20230115"/></effectiveTime>
  <consumable><manufacturedProduct classCode="MANU"><templateId root="2.16.840.1.113883.10.20.22.4.23"/>
    <manufacturedMaterial><code code="314076" codeSystem="2.16.840.1.113883.6.88"/></manufacturedMaterial>
  </manufacturedProduct></consumable>
</substanceAdministration>
```

Expected (as a MedicationStatement, draft 14): `"status": "not-taken"`. Actual: `"status": "active"`.

## PR: fix(ccda): a negated medication list entry is not-taken

- `ccda-to-fhir.ts`: when `negationInd="true"`, the MedicationStatement's `status` is `not-taken` (statusCode otherwise).
- Test `medication-activity.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 51 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 84a347c
- If upstream keeps the IG's mood route (MedicationRequest, draft 14), the same negation belongs on `MedicationRequest.doNotPerform`.
