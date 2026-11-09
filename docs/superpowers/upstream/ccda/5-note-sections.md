# 5. Notes, Instructions and History of Present Illness entries → DocumentReference

No existing issue or PR. Depends on medplum#11242 (narrative reference index). Nothing filed.

## Issue: @medplum/ccda: C-CDA to FHIR skips Note Activity, Instructions and History of Present Illness entries

- The Notes section (`2.16.840.1.113883.10.20.22.2.65`) is routed to `return undefined` ("part of USCDI v3 ... not yet implemented").
- A Note Activity (`2.16.840.1.113883.10.20.22.4.202`) may appear in any section (C-CDA 2.1 companion guide, USCDI v1 Clinical Notes); outside the Notes section it is an unsupported act.
- Instructions (`2.16.840.1.113883.10.20.22.2.45`) and IHE History of Present Illness (`1.3.6.1.4.1.19376.1.5.3.1.3.4`) entries are unsupported: with `ignoreUnsupportedSections` they are dropped, without it the document throws.

Epic CCDs carry the visit's HPI, patient instructions and progress notes this way. US Core maps clinical notes to `DocumentReference`.

Reproduction (synthetic):

```xml
<section>
  <templateId root="1.3.6.1.4.1.19376.1.5.3.1.3.4"/>
  <code code="10164-2" codeSystem="2.16.840.1.113883.6.1" displayName="History of present illness"/>
  <title>History of Present Illness</title>
  <text><paragraph ID="h1">Three days of nasal congestion.</paragraph></text>
  <entry>
    <act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.202" extension="2016-11-01"/>
      <id root="2.16.840.1.113883.19.5" extension="HPI-1"/>
      <code code="34109-9" codeSystem="2.16.840.1.113883.6.1" displayName="Note">
        <translation code="11506-3" codeSystem="2.16.840.1.113883.6.1" displayName="Progress note"/>
      </code>
      <text><reference value="#h1"/></text>
      <statusCode code="completed"/>
      <effectiveTime value="20240210"/>
    </act>
  </entry>
</section>
```

Expected FHIR:

```json
{
  "resourceType": "DocumentReference",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "HPI-1" }],
  "status": "current",
  "type": { "coding": [{ "system": "http://loinc.org", "code": "34109-9", "display": "Note" }, { "system": "http://loinc.org", "code": "11506-3", "display": "Progress note" }], "text": "Note" },
  "category": [{ "coding": [{ "system": "http://loinc.org", "code": "10164-2", "display": "History of present illness" }], "text": "History of present illness" }],
  "subject": { "reference": "Patient/..." },
  "content": [{ "attachment": { "contentType": "text/plain", "data": "<base64 of 'Three days of nasal congestion.'>", "title": "History of Present Illness" } }],
  "context": { "period": { "start": "2024-02-10" } },
  "extension": [{ "url": "https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference", "valueString": "#h1" }]
}
```

The same for an Instruction act (`22.4.20`) in an Instructions section and a Note Activity in the Notes section or any other section.

## PR: feat(ccda): convert Note Activity, Instructions and History of Present Illness entries to DocumentReference

- `processAct` sends a Note Activity to `processNoteAct` whatever the section, and every act in the Notes, Instructions (and V2) and HPI sections. New OID constant `OID_HISTORY_OF_PRESENT_ILLNESS_SECTION`.
- `processNoteAct`: text from the act's own text or the narrative it references (`resolveNarrativeReference`, #11242), base64 in a `text/plain` attachment titled with the section title; `type` from the act code (translations kept), `category` from the section code, `context.period` from effectiveTime (`DocumentReference.date` is an instant, which a CDA date often is not), authors as Practitioners, ids as identifiers.
- Test: `note-sections.test.ts`.

## Filing metadata

- PATCHES rows: 5 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): b1ad72e (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 3 (PR medplum#11242)
- Status: issue-first. Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
