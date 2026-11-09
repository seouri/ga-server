# 16. REAL observation values (existing PR)

Nothing new to file. GA carries the open external PR **medplum#11241** ("fix(ccda): map REAL observation values", fixes #11201) unchanged, applied from its head commit aba193d5. Drop row 16 of `vendor/medplum-ccda/PATCHES.md` when a Medplum release contains it.

What it changes: a Result Observation whose value is `xsi:type="REAL"` (INR, pH, specific gravity, ratios) got no `value[x]` and a console warning. It now gets `valueQuantity` from the existing `mapQuantity`: the number, plus unit, UCUM system and code only when the element carries a `unit`. A `REAL` with no number gives no value and no warning.

Reproduction (synthetic, the PR's own):

```xml
<observation classCode="OBS" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
  <id root="2.16.840.1.113883.19.5" extension="LAB-1-1"/>
  <code code="6301-6" codeSystem="2.16.840.1.113883.6.1" displayName="INR in Platelet poor plasma by Coagulation assay"/>
  <statusCode code="completed"/>
  <effectiveTime value="20260101"/>
  <value xsi:type="REAL" value="1.1"/>
</observation>
```

Expected: `"valueQuantity": { "value": 1.1 }`.

How GA applied it: `git apply -p4 --directory=vendor/medplum-ccda` of the PR diff (ccda-to-fhir.ts, types.ts: offset only). The PR's test is `test/observation-value.test.ts`, ported to vitest (explicit `vitest` import, `.ts` imports). GA's accounting (`src/ccda.ts` `VALUE_TYPES`) now counts `REAL` as converted.

If the PR changes in review, re-apply its final diff and rerun `npx vitest run vendor`.

## Filing metadata

- PATCHES rows: 16 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): f554466 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: PR medplum#11241 (fixes #11201)
- Depends on / builds on: nothing
- Status: external PR, nothing to file. Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
