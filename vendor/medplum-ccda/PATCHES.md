# Patches against @medplum/ccda 5.2.15

Source: https://github.com/medplum/medplum/tree/v5.2.15/packages/ccda (Apache-2.0, see LICENSE).

| # | File | Change | Why |
|---|------|--------|-----|
| 0 | all `*.ts` | mechanical: strip-only TypeScript: relative imports get `.ts`; `index.ts` no longer re-exports `./fhir-to-ccda/convert` | Node runs .ts directly; `fhir-to-ccda/` is not vendored |

Upstream already used `import type` for type-only imports; no other syntax needed rewriting.

## Omitted

- `src/fhir-to-ccda/` (GA only converts C-CDA to FHIR).
- Tests dropped: `roundtrip` and `g9` (both call `convertFhirToCcda`), `b1` (needs upstream `testdata/` sample set of 6 large government files).
- `test/` ported to vitest: explicit `import ... from 'vitest'`, `.ts` imports, `import.meta.dirname` for `__dirname`. `test/synthetic-fixture.test.ts` is GA's own. `testdata/` keeps only the 4 files `nullflavor` reads.

## Build config

- `tsconfig.json` includes `vendor`; it type-checks under GA's strict settings unchanged. `@medplum/core` stays 5.2.14 (no 5.2.15 export needed).
