# 31. Encounter class from an ActCode only

No existing issue or PR. Independent of the other drafts (draft 10 touches the same function's diagnoses, not `class`). Nothing filed.

## Issue: @medplum/ccda: Encounter.class carries the encounter code under the v3 ActCode system

`processEncounter` writes `class: { system: v3-ActCode, code: encounter.code/@code ?? 'AMB', display: ... }`. The Encounter Activity's code is usually CPT (Epic: `99213` "Office visit", codeSystem `2.16.840.1.113883.6.12`), so the result claims the ActCode system has a code `99213`. The same code is already (correctly) in `Encounter.type`. With no code the encounter is asserted ambulatory, which the document does not say.

Reproduction (synthetic):

```xml
<encounter classCode="ENC" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
  <id root="2.16.840.1.113883.19.5" extension="ENC-1"/>
  <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office visit"/>
  <effectiveTime><low value="20240210093000-0500"/></effectiveTime>
</encounter>
```

Expected: `type[0].coding[0]` = CPT 99213 (as now); `class` = an ActCode only if the code or a `<translation>` is in `2.16.840.1.113883.5.4` (e.g. `<translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/>` → `{ system: v3-ActCode, code: "AMB" }`), else `{ "extension": [{ "url": "http://hl7.org/fhir/StructureDefinition/data-absent-reason", "valueCode": "unknown" }] }` (class is 1..1 in R4). Actual: `{ system: v3-ActCode, code: "99213" }`.

## PR: fix(ccda): take Encounter.class only from a v3 ActCode

- `ccda-to-fhir.ts`: `mapEncounterClass(encounter.code)`: the code or its first translation in ActCode; otherwise a data-absent Coding.
- Test `encounter.test.ts`: CPT only → type CPT, class data-absent; no code → data-absent; an ActCode code or translation → that class.
- Behaviour change to call out: documents with no encounter code no longer get `AMB`. If maintainers prefer keeping `AMB` as the default, the CPT part stands alone.
