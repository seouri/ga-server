# 47. Empty and text-only person names

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: a nullFlavor or text-only name becomes an empty HumanName

`mapCcdaNameToFhirHumanName` reads only `prefix`, `given`, `family` and `suffix`. A `<name nullFlavor="UNK"/>` (its nullFlavor stripped by `sanitizeNullFlavors`) and a name written as text only (`<name>Pat Doe, MD</name>`) both become `{}`, which FHIR validators refuse ("Invalid empty non-primitive value"), so the whole Practitioner or RelatedPerson is refused on write. The text-only name's content is lost.

Reproduction (synthetic), an assigned person:

```xml
<assignedPerson><name nullFlavor="UNK"/></assignedPerson>
<assignedPerson><name>Pat Doe, MD</name></assignedPerson>
```

Expected: no `name`; `name: [{ text: "Pat Doe, MD" }]`. Actual: `name: [{}]` both times.

## PR: fix(ccda): no empty HumanName; text-only names as text

- `ccda-to-fhir.ts`: `mapCcdaNameToFhirHumanName` returns `{ text }` for a text-only name and nothing for a name with no parts; `mapCcdaNameArrayFhirHumanNameArray` returns undefined for an empty list.
- Test `patient-demographics.test.ts`.
