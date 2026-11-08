# Patches against @medplum/ccda 5.2.15

Source: https://github.com/medplum/medplum/tree/v5.2.15/packages/ccda (Apache-2.0, see LICENSE).

| # | File | Change | Why | Upstream |
|---|------|--------|-----|----------|
| 0 | all `*.ts` | mechanical: strip-only TypeScript: relative imports get `.ts`; `index.ts` no longer re-exports `./fhir-to-ccda/convert` | Node runs .ts directly; `fhir-to-ccda/` is not vendored | none (GA only) |
| 1 | `ccda-to-fhir.ts`, `oids.ts` | section entries routed by any of the section's templateIds (`getTemplateIds`), not `templateId[0]`; Medications entries-optional and V2 roots routed; `OID_PROBLEMS_SECTION_V2_ENTRIES_REQUIRED` loses its stray space. Test `test/section-template-order.test.ts` | Epic lists the entries-optional root first: every Epic document threw (or, ignoring unsupported sections, lost its medications); replaces GA's `promote()` pre-pass | existing issue medplum#10671 (proposes this fix; no PR yet); draft `docs/superpowers/upstream/ccda/1-section-template-order.md` |

Upstream already used `import type` for type-only imports; no other syntax needed rewriting.

## Omitted

- `src/fhir-to-ccda/` (GA only converts C-CDA to FHIR).
- Tests dropped: `roundtrip` and `g9` (both call `convertFhirToCcda`), `b1` (needs upstream `testdata/` sample set of 6 large government files).
- `test/` ported to vitest: explicit `import ... from 'vitest'`, `.ts` imports, `import.meta.dirname` for `__dirname`. `test/synthetic-fixture.test.ts` is GA's own. `testdata/` keeps only the 4 files `nullflavor` reads.

## Build config

- `tsconfig.json` includes `vendor`; it type-checks under GA's strict settings unchanged. `@medplum/core` stays 5.2.14 (no 5.2.15 export needed).
