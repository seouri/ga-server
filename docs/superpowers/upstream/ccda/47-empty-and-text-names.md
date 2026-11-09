# 47. Empty and text-only person names

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

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

## Amendment: text kept with the other name parts

The text is kept with the name's other parts: `<name use="L">Pat Doe</name>` gives `{ use: "official", text: "Pat Doe" }`,
`<name><prefix>Dr.</prefix>Pat Doe<suffix>MD</suffix></name>` gives prefix, suffix and text, and loose text beside a family or
given name is kept as text.

## Amendment: loose name text keeps its spaces

fast-xml-parser trims and concatenates mixed-content text pieces, so `Dr. <given>John</given> Smith` reads as "Dr.Smith". The fix
marks the loose text pieces of a name with parts before parsing and joins them with single spaces: text "Dr. Smith".

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 47, 49, 50 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 6abc9b4, e4315aa, 57bf61d (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed (the README has the approval process).
