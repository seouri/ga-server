# 40. The encompassing encounter is the Composition encounter

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: componentOf/encompassingEncounter is dropped

The header's `componentOf/encompassingEncounter` (the visit the document belongs to) is never read: the Composition has no `encounter`, and a document without an Encounters section loses the visit entirely.

Reproduction (synthetic), in the header:

```xml
<componentOf><encompassingEncounter><id root="2.16.840.1.113883.19.5.3" extension="V1"/>
  <code code="99213" codeSystem="2.16.840.1.113883.6.12"><translation code="AMB" codeSystem="2.16.840.1.113883.5.4"/></code>
  <effectiveTime><low value="20200102"/></effectiveTime>
  <location><healthCareFacility><id root="2.16.840.1.113883.19.5.4" extension="F1"/><location><name>Test Clinic</name></location></healthCareFacility></location>
</encompassingEncounter></componentOf>
```

Expected: `Composition.encounter` pointing at an Encounter with identifier `V1`, class `AMB`, type `99213`, the period and a Location `Test Clinic`; when an Encounters-section entry has the same id, `Composition.encounter` points at that Encounter and no second one is made. Actual: no `encounter`.

## PR: fix(ccda): Composition.encounter from componentOf

- `ccda-to-fhir.ts`: `mapEncompassingEncounter` (reuses an entry's Encounter with the same identifier; otherwise builds one with `mapEncounterClass`, the facility as a Location, responsible party and participants through `mapAssignedEntityToReference`).
- `types.ts`: `Ccda.componentOf`, `CcdaEncompassingEncounter`; `xml.ts`: `encounterParticipant` is an array.
- Test `encompassing-encounter.test.ts`.

## Amendment (PATCHES row 45): the reused Encounter gains the header's details

When an Encounters-section entry has the encompassing encounter's id, that Encounter gains the header's period (when it has
none), every header participant, and the facility as a Location unless one of its locations already has the facility's id.
Nothing the header states is dropped. Tests in `encompassing-encounter.test.ts`.

## Amendment (PATCHES row 48)

The header facility's Location is always created and merged by identifier with an entry Location of the same id (so its name
and address are kept); only a duplicate `Encounter.location` entry is skipped. Header participants the Encounter already has
(same type and person) are not repeated.
