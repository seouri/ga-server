# 36. Immunization not given (negationInd)

No existing issue or PR. Same function as drafts 27-28 (test file shared). Nothing filed.

## Issue: @medplum/ccda: a vaccine not given converts as completed

`processImmunizationSubstanceAdministration` ignores `negationInd`. The Immunization Activity template uses `negationInd="true"` for a vaccine that was not given (often with an Immunization Refusal Reason, `2.16.840.1.113883.10.20.22.4.53`, under `entryRelationship typeCode="RSON"`), while its `statusCode` stays `completed` (the act of recording is complete). The result is `status: completed`: the patient appears vaccinated.

Reproduction (synthetic):

```xml
<substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="true">
  <templateId root="2.16.840.1.113883.10.20.22.4.52" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="IMM-2"/>
  <statusCode code="completed"/><effectiveTime value="20231015"/>
  <consumable><manufacturedProduct classCode="MANU"><templateId root="2.16.840.1.113883.10.20.22.4.54"/>
    <manufacturedMaterial><code code="140" codeSystem="2.16.840.1.113883.12.292"/></manufacturedMaterial>
  </manufacturedProduct></consumable>
  <entryRelationship typeCode="RSON"><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.53"/>
    <code code="PATOBJ" codeSystem="2.16.840.1.113883.5.8" displayName="patient objection"/><statusCode code="completed"/>
  </observation></entryRelationship>
</substanceAdministration>
```

Expected: `"status": "not-done"`, `"statusReason": { "coding": [{ "code": "PATOBJ", "display": "patient objection", ... }] }`. Actual: `"status": "completed"`, no reason.

## PR: fix(ccda): a negated immunization is not-done with its refusal reason

- `ccda-to-fhir.ts`: when `negationInd="true"`, `status = 'not-done'` and `statusReason` = the refusal reason observation's code.
- Test `immunization.test.ts`.
