# 28. Immunization route

No existing issue or PR. Independent of the other drafts (the test file is shared with draft 27). Nothing filed.

## Issue: @medplum/ccda: an immunization's route is dropped

`processImmunizationSubstanceAdministration` never reads `substanceAdministration/routeCode`, although the Immunization Activity template carries it (SHOULD) and FHIR has `Immunization.route`. The Medication Activity path already maps the same element to `dosage.route`.

Reproduction (synthetic): the immunization from draft 27 with

```xml
<routeCode code="C28161" codeSystem="2.16.840.1.113883.3.26.1.1" displayName="Intramuscular"/>
```

after `effectiveTime`. Expected: `"route": { "coding": [{ "system": "http://ncithesaurus-stage.nci.nih.gov", "code": "C28161", "display": "Intramuscular" }], "text": "Intramuscular" }` (the system as `SYSTEM_MAPPER` maps the NCI Thesaurus OID). Actual: no `route`.

## PR: fix(ccda): map an immunization's routeCode to Immunization.route

- `ccda-to-fhir.ts`: `route: this.mapCode(substanceAdmin.routeCode)` in the Immunization.
- Test `immunization.test.ts`: the route is kept; no routeCode gives no route.
