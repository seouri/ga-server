# 1. Route section entries by any templateId

Builds on the existing issue **medplum#10671** ("C-CDA to FHIR routes section entries by templateId[0] only, so medications are silently dropped when the entries-optional Medications template is listed first"), which proposes exactly this fix and asks for the `open-to-community` label. No PR exists yet. Nothing here is filed; it goes out under the owner's account after their go-ahead.

## Issue

No new issue: comment on #10671 with the reproduction below if the maintainers ask for one, then open the PR once it is labelled.

## Reproduction (synthetic, PHI-free)

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.1"/>
  <templateId root="2.16.840.1.113883.10.20.22.2.1" extension="2014-06-09"/>
  <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
  <templateId root="2.16.840.1.113883.10.20.22.2.1.1" extension="2014-06-09"/>
  <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Medications</title>
  <text>x</text>
  <entry typeCode="DRIV">
    <substanceAdministration classCode="SBADM" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.16" extension="2014-06-09"/>
      <id root="2.16.840.1.113883.19.5" extension="MED-1"/>
      <statusCode code="active"/>
      <consumable><manufacturedProduct classCode="MANU">
        <templateId root="2.16.840.1.113883.10.20.22.4.23" extension="2014-06-09"/>
        <manufacturedMaterial><code code="310793" codeSystem="2.16.840.1.113883.6.88" displayName="Examplamide 10 MG Oral Tablet"/></manufacturedMaterial>
      </manufacturedProduct></consumable>
    </substanceAdministration>
  </entry>
</section>
```

- Actual: throws `Unhandled substance administration templateId: 2.16.840.1.113883.10.20.22.2.1`; with `ignoreUnsupportedSections: true` no medication.
- Expected: one `MedicationRequest` (RxNorm 310793), as when `...2.1.1` is listed first. Same for an entries-optional-only Medications section, and for a Problems section whose routed template is not first.

Expected FHIR (the medication, abridged):

```json
{
  "resourceType": "MedicationRequest",
  "status": "active",
  "intent": "order",
  "medicationCodeableConcept": {
    "coding": [{ "system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "310793", "display": "Examplamide 10 MG Oral Tablet" }],
    "text": "Examplamide 10 MG Oral Tablet"
  },
  "subject": { "reference": "Patient/..." }
}
```

## PR: fix(ccda): route section entries by any of the section's templateIds (fixes #10671)

- `getTemplateIds(node)` returns a node's templateId roots in document order. `processAct` and `processSubstanceAdministration` try each root against their switch; `processOrganizer` and `processObservation` test membership. The unhandled-template error still names the first root.
- Medications entries-optional (`...2.1`) and the V2 roots join the medication case; their entries are the same Medication Activity.
- `OID_PROBLEMS_SECTION_V2_ENTRIES_REQUIRED` had a space (`...2.5.1 .2`) and could never match.
- A section with no templateId no longer throws a TypeError (`section.templateId[0]`): it is unsupported like any unknown section.
- Tests: `section-template-order.test.ts` (Epic order, entries-optional only, Problems not first and V2, no templateId). Existing fixtures list the routed template first, so their output is unchanged.

## Filing metadata

- PATCHES rows: 1 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 5090775 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: issue medplum#10671
- Depends on / builds on: nothing
- Status: issue-first (invited issue exists). Nothing filed; the owner approves each item first. Medplum accepts outside PRs only for an issue a maintainer has invited ("vouched"), so the issue goes first.
