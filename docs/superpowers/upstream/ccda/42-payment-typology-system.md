# 42. Source of Payment Typology keeps its system

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: a Source of Payment Typology code loses its system

`systems.ts` maps the Source of Payment Typology OID `2.16.840.1.113883.3.221.5` to `fhirValue: ''`. `mapCode` skips an empty system, so a Policy Activity coded in it (the usual coding for a payer type) becomes `Coverage.type.coding: [{ code: "6" }]`, a code with no system.

Reproduction (synthetic), a Policy Activity in the Payers section:

```xml
<code code="6" codeSystem="2.16.840.1.113883.3.221.5" codeSystemName="SOP"/>
```

Expected: `{ system: "https://nahdo.org/sopt", code: "6" }` (the URI HL7 terminology and US Core's Coverage.type binding use). Actual: `{ code: "6" }`.

## PR: fix(ccda): Source of Payment Typology URI

- `systems.ts`: `fhirValue: 'https://nahdo.org/sopt'`.
- Test `systems.test.ts` (both directions).

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 42 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 9192f09 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 7
- Status: issue-first. Nothing filed (the README has the approval process).
