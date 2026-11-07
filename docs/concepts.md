# One test, one name: the concept layer

Back to the [README](../README.md).

## Why

The same test arrives under different names. A hospital calls LDL "LOW DENSITY LIPOPROTEIN CHOL" and gives it a standard code. A lab PDF says "LDL cholesterol" with no code. Another hospital spells it its own way. Asking by name misses some of these, and guessing by pattern matches the wrong things: urine glucose isn't blood glucose, and a TSH antibody test isn't TSH.

GA gives every record a standard code, so a question about LDL finds every LDL result from every source and nothing else. This covers lab tests, clinic vital signs, vaccines, medications, problems and procedures.

| Records | Standard codes |
|---|---|
| Lab tests, vital signs | LOINC |
| Vaccines | CVX |
| Medications | RxNorm |
| Problems | SNOMED CT or ICD-10-CM |
| Procedures | SNOMED CT, CPT or HCPCS |

GA never changes or removes what the source wrote. It adds the standard code beside it and marks where the code came from.

## Where a code comes from

GA tries these in order, at every import:

1. **The source's own code.** Most hospital results already carry one.
2. **Fixed tables in GA:** the standard codes for vital signs (blood pressure, weight, heart rate and the rest) and the CDC's vaccine codes.
3. **What GA learned from that source.** When a hospital codes "LOW DENSITY LIPOPROTEIN CHOL" itself, GA remembers it, so that hospital's uncoded copies of the same test get the same code. Each source has its own list (a FHIR ConceptMap): one hospital's names never decide another's.
4. **Your agent.** Whatever is left, mostly from PDFs, your agent maps with `map_concept`, right after it imports the file. GA checks the code exists (LOINC and RxNorm with the National Library of Medicine, sending only the code) and records who mapped it and when.
5. **Unmapped.** No code yet: the term waits in the review list.

## Sure or suggested

Your agent maps a term on its own when the name, unit and specimen all match the code. When they don't quite (a close but not identical test, say), the code is applied as **suggested**. Tools then label results matched only that way "possibly LDL (suggested mapping)", and your agent should tell you it's unsure.

Some tests have more than one standard code. LDL can be calculated or measured directly, and eGFR has race-free and older race-based versions. GA keeps them in one group and says which method each result used, so trends stay whole and honest.

## Reviewing

Ask your agent ("what did you map?", "what still has no code?"), or from the repo folder:

```sh
node src/cli.ts concepts                     # terms with no standard code
node src/cli.ts concepts --suggested         # terms with only a suggested code
node src/cli.ts concepts --agent --since 2026-11-01   # what agents mapped
```

To correct a mapping, ask your agent to map the term again: the new mapping replaces the old one and is re-applied to every matching record. A term that has no standard code can be mapped as "unmatched", which takes it off the review list.

## Upkeep

```sh
node src/cli.ts concepts apply               # code stored records and re-apply every map
```

Run it after upgrading GA. It is safe to run again: a second run changes nothing. Installs whose maps predate typed keys (`Condition|…`) run `node src/cli.ts concepts apply --migrate-keys` once first.

The learned maps live in the FHIR server, so they are in the nightly backup and come back with a restore. Records you edited by hand are left alone.

## For agents

The rules agents follow are in [AGENTS.md](../AGENTS.md) ("Concept layer"). The design is in [docs/superpowers/specs/2026-11-07-concept-layer-design.md](superpowers/specs/2026-11-07-concept-layer-design.md).
