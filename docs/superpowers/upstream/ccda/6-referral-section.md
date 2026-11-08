# 6. Reason for Referral → ServiceRequest

No existing issue or PR. Uses medplum#11242 for the narrative text. Nothing filed.

## Issue: @medplum/ccda: C-CDA to FHIR skips Reason for Referral entries

The IHE Reason for Referral section (`1.3.6.1.4.1.19376.1.5.3.1.3.1`) is routed to `return undefined` ("part of USCDI v3 ... not yet implemented"), so a Patient Referral Act (`2.16.840.1.113883.10.20.22.4.140`) is lost. US Core represents a referral as a `ServiceRequest`.

Reproduction (synthetic):

```xml
<section>
  <templateId root="1.3.6.1.4.1.19376.1.5.3.1.3.1"/>
  <code code="42349-1" codeSystem="2.16.840.1.113883.6.1" displayName="Reason for referral"/>
  <title>Reason for Referral</title>
  <text><paragraph ID="ref1">Referral to example ENT clinic.</paragraph></text>
  <entry>
    <act classCode="PCPR" moodCode="INT">
      <templateId root="2.16.840.1.113883.10.20.22.4.140"/>
      <id root="2.16.840.1.113883.19.5" extension="REF-1"/>
      <code code="44383000" codeSystem="2.16.840.1.113883.6.96" displayName="Patient referral for consultation"/>
      <text><reference value="#ref1"/></text>
      <statusCode code="active"/>
      <effectiveTime value="20240210"/>
    </act>
  </entry>
</section>
```

Expected FHIR:

```json
{
  "resourceType": "ServiceRequest",
  "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "REF-1" }],
  "status": "active",
  "intent": "plan",
  "category": [{ "coding": [{ "system": "http://snomed.info/sct", "code": "3457005", "display": "Patient referral" }] }],
  "code": { "coding": [{ "system": "http://snomed.info/sct", "code": "44383000", "display": "Patient referral for consultation" }], "text": "Patient referral for consultation" },
  "subject": { "reference": "Patient/..." },
  "occurrenceDateTime": "2024-02-10",
  "note": [{ "text": "Referral to example ENT clinic." }]
}
```

## PR: feat(ccda): convert Reason for Referral entries to ServiceRequest

- `processReferralAct`: status from statusCode (active, completed, aborted/cancelled → revoked, suspended → on-hold, else unknown); intent from moodCode (INT → plan, PRP → proposal, RQO/ARQ → order, else order); fixed referral category; code; occurrence from effectiveTime; authoredOn and requester from the first author; performers as PractitionerRoles; the act text (inline or by narrative reference) as a note; ids as identifiers.
- Also routes the V2 section root.
- Test: `referral-section.test.ts`.
