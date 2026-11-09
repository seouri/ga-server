# 27. CVX code system URI

No existing issue or PR. Independent of the other drafts. Nothing filed.

## Issue: @medplum/ccda: vaccine codes come out under http://nucc.org/cvx instead of http://hl7.org/fhir/sid/cvx

`SYSTEM_MAPPER` has two rows for the CVX OID `2.16.840.1.113883.12.292`: `http://nucc.org/cvx` first and `http://hl7.org/fhir/sid/cvx` as an "alternate FHIR system". C-CDA → FHIR takes the first match, so every Immunization's `vaccineCode` uses `http://nucc.org/cvx`. The FHIR terminology registry (and US Core's Immunization profile) names CVX `http://hl7.org/fhir/sid/cvx`; consumers that look vaccines up by that system (schedules, registries, US Core validation) miss them all.

Reproduction (synthetic):

```xml
<substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="false">
  <templateId root="2.16.840.1.113883.10.20.22.4.52" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="IMM-1"/>
  <statusCode code="completed"/><effectiveTime value="20231015"/>
  <consumable><manufacturedProduct classCode="MANU"><templateId root="2.16.840.1.113883.10.20.22.4.54"/>
    <manufacturedMaterial><code code="140" codeSystem="2.16.840.1.113883.12.292" displayName="Influenza, seasonal, injectable, preservative free"/></manufacturedMaterial>
  </manufacturedProduct></consumable>
</substanceAdministration>
```

Expected: `"vaccineCode": { "coding": [{ "system": "http://hl7.org/fhir/sid/cvx", "code": "140", ... }] }`. Actual: `"system": "http://nucc.org/cvx"`.

## PR: fix(ccda): map the CVX OID to http://hl7.org/fhir/sid/cvx

- `systems.ts`: the `FHIR_CVX_URL` row comes first in `SYSTEM_MAPPER`; the `CVX_URL` row moves to the alternates, so a FHIR resource coded `http://nucc.org/cvx` still converts back to the CVX OID.
- Test `immunization.test.ts`: a CVX vaccine code is in `http://hl7.org/fhir/sid/cvx`.

## Filing metadata

- PATCHES rows: 27 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): df39876 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
