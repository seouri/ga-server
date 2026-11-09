# 54. Condition verification status code system

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Same function as draft 53 (`processConditionObservation`).

## Issue: @medplum/ccda: a problem's verificationStatus uses a code system that does not exist

Every Condition made from a problem or encounter diagnosis gets

```json
"verificationStatus": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/condition-verification", "code": "confirmed" }] }
```

There is no `condition-verification` code system. FHIR R4 binds `Condition.verificationStatus` to `http://terminology.hl7.org/CodeSystem/condition-ver-status`, which the library already uses for an encounter's indication (RSON) Condition (`CONDITION_VER_STATUS_CODE_SYSTEM`). Any problem in a Problems section reproduces it.

Expected: `"system": "http://terminology.hl7.org/CodeSystem/condition-ver-status"`. Actual: `".../condition-verification"`.

## PR: fix(ccda): Condition verificationStatus in condition-ver-status

- `ccda-to-fhir.ts`: `processConditionObservation` uses `CONDITION_VER_STATUS_CODE_SYSTEM`. `CONDITION_VERIFICATION_CODE_SYSTEM` is left exported (public API), now unused.
- Test `problem-status.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 54 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): the commit that adds this draft (`git log --oneline -- docs/superpowers/upstream/ccda/54-condition-verification-system.md`)
- Moved from GA's post-conversion `repair` (src/ccda.ts), which now runs only on the Microsoft path.
