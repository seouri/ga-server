# 32. Encounter location

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Independent of the other drafts (draft 31 changes the same Encounter's `class`). Nothing filed.

## Issue: @medplum/ccda: an encounter's location is dropped

`processEncounter` reads performers and RSON diagnoses but no `participant`. The Encounter Activity's Service Delivery Location (`participant typeCode="LOC"`, template `2.16.840.1.113883.10.20.22.4.32`) says where the visit happened; FHIR has `Encounter.location.location` → `Location`.

Reproduction (synthetic), inside an Encounter Activity:

```xml
<participant typeCode="LOC">
  <participantRole classCode="SDLOC">
    <templateId root="2.16.840.1.113883.10.20.22.4.32"/>
    <id root="2.16.840.1.113883.19.5.9" extension="DEPT-1"/>
    <code code="1160-1" codeSystem="2.16.840.1.113883.6.259" displayName="Urgent Care Center"/>
    <addr><streetAddressLine>2 Example Plaza</streetAddressLine><city>Testville</city><state>ZZ</state><postalCode>00000</postalCode></addr>
    <telecom use="WP" value="tel:+1-555-555-0100"/>
    <playingEntity classCode="PLC"><name>Example Clinic</name></playingEntity>
  </participantRole>
</participant>
```

Expected: a `Location` (identifier `urn:oid:2.16.840.1.113883.19.5.9|DEPT-1`, name "Example Clinic", type HSLOC 1160-1, address, telecom) and `Encounter.location = [{ location: { reference: "Location/<id>", display: "Example Clinic" } }]`. Actual: neither.

## PR: feat(ccda): convert an encounter's service delivery location

- `ccda-to-fhir.ts`: `mapLocationToReference(participantRole)` builds the Location (address: the first `addr`, since `Location.address` is 0..1) and the Encounter points at it, one entry per LOC participant.
- Test `encounter.test.ts`.
- Follow-up (draft 33): the same location in several encounters should be one Location.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 32 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 22338ab (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed (the README has the approval process).
