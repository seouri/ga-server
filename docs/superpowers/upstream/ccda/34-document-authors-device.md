# 34. Every document author; an authoring device is a Device

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Independent of the other drafts (draft 33's merge pass also merges the device's organization with the custodian when they share an id). Nothing filed.

## Issue: @medplum/ccda: only the first document author is kept, and a device author becomes an empty Practitioner

`createComposition` maps `this.ccda.author?.[0]` only. C-CDA allows several authors, and EHR summaries commonly list the clinician and the authoring software (`assignedAuthoringDevice`). Every later author is dropped. When the device is the first (or only) author, `mapAuthorToReference` builds a `Practitioner` from `assignedPerson` (absent), i.e. a Practitioner with no name.

Reproduction (synthetic), in the ClinicalDocument header:

```xml
<author><time value="20240612"/><assignedAuthor><id root="2.16.840.1.113883.4.6" extension="1111111111"/>
  <assignedPerson><name><given>Example</given><family>Clinician</family></name></assignedPerson></assignedAuthor></author>
<author><time value="20240612"/><assignedAuthor><id nullFlavor="NA"/>
  <assignedAuthoringDevice><manufacturerModelName>Example EHR</manufacturerModelName><softwareName>Example EHR Version 10</softwareName></assignedAuthoringDevice>
  <representedOrganization><id root="2.16.840.1.113883.19.5" extension="ORG-1"/><name>Example Health System</name></representedOrganization>
</assignedAuthor></author>
```

Expected: `Composition.author` = [Practitioner, Device]; the Device has `deviceName: [{ name: "Example EHR", type: "model-name" }]`, `version: [{ value: "Example EHR Version 10" }]`, `owner` → Organization ORG-1. Actual: only the Practitioner.

## PR: fix(ccda): map every document author, devices as Device

- `ccda-to-fhir.ts`: `mapDocumentAuthorToReference(author)` for each header author: a person as before, an authoring device as a Device owned by its represented organization.
- Test `document-authors.test.ts`.
- Not changed: entry-level authors (recorder, asserter, requester) take no Device in FHIR R4; a device there still goes through `mapAuthorToReference`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 34 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 40adb9a (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 33
- Status: issue-first. Nothing filed (the README has the approval process).
