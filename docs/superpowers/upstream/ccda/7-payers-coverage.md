# 7. Payers → Coverage

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: C-CDA to FHIR skips the Payers section

The Payers section (`2.16.840.1.113883.10.20.22.2.18`) is routed to `return undefined` ("part of USCDI v3 ... not yet implemented"). A Coverage Activity (`22.4.60`) holds one Policy Activity (`22.4.61`) per insurance policy; FHIR R4 represents each as a `Coverage`. Also, `act.participant` is not in the parser's `ARRAY_PATHS`, so a policy's single participant parses as an object although `CcdaAct.participant` is typed as an array.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.18" extension="2015-08-01"/>
  <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Insurance</title><text>x</text>
  <entry>
    <act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.60" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5.6" extension="COVERAGE-1"/>
      <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <entryRelationship typeCode="COMP">
        <sequenceNumber value="1"/>
        <act classCode="ACT" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.61" extension="2015-08-01"/>
          <id root="2.16.840.1.113883.19.5.7" extension="POLICY-1"/>
          <code code="PPO" codeSystem="2.16.840.1.113883.5.4" displayName="Preferred provider organization policy"/>
          <statusCode code="completed"/>
          <performer typeCode="PRF">
            <templateId root="2.16.840.1.113883.10.20.22.4.87"/>
            <assignedEntity>
              <id root="2.16.840.1.113883.6.300" extension="99999"/>
              <code code="PAYOR" codeSystem="2.16.840.1.113883.5.110"/>
              <representedOrganization><name>Example Insurance Co.</name></representedOrganization>
            </assignedEntity>
          </performer>
          <participant typeCode="COV">
            <templateId root="2.16.840.1.113883.10.20.22.4.89"/>
            <time><low value="20230101"/><high value="20241231"/></time>
            <participantRole classCode="PAT">
              <id root="2.16.840.1.113883.19.5.8" extension="MEMBER-1"/>
              <code code="SELF" codeSystem="2.16.840.1.113883.5.111" displayName="Self"/>
            </participantRole>
          </participant>
          <participant typeCode="HLD">
            <templateId root="2.16.840.1.113883.10.20.22.4.90"/>
            <participantRole><id root="2.16.840.1.113883.19.5.9" extension="SUBSCRIBER-1"/></participantRole>
          </participant>
        </act>
      </entryRelationship>
    </act>
  </entry>
</section>
```

Expected FHIR:

```json
{
  "resourceType": "Coverage",
  "identifier": [
    { "system": "urn:oid:2.16.840.1.113883.19.5.7", "value": "POLICY-1" },
    { "system": "urn:oid:2.16.840.1.113883.19.5.8", "value": "MEMBER-1" }
  ],
  "status": "active",
  "type": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "PPO", "display": "Preferred provider organization policy" }], "text": "Preferred provider organization policy" },
  "beneficiary": { "reference": "Patient/..." },
  "subscriberId": "SUBSCRIBER-1",
  "relationship": { "coding": [{ "code": "SELF", "display": "Self" }], "text": "Self" },
  "period": { "start": "2023-01-01", "end": "2024-12-31" },
  "payor": [{ "identifier": { "value": "99999" }, "display": "Example Insurance Co." }],
  "order": 1
}
```

(Systems as the library's OID table maps them.)

## PR: feat(ccda): convert the Payers section to Coverage

- `processCoverageAct` returns one Coverage per Policy Activity; `processAct` may return an array, which `processEntry` spreads into the section.
- `processPolicyActivity`: fields as above. `status` is `active` because C-CDA carries no coverage status (a Policy Activity's statusCode is fixed to `completed`). With no payer performer, `payor` (1..* in FHIR) carries a data-absent-reason `unknown` extension instead of an invented organization. Guarantor performers (`22.4.88`, `GUAR`) are not payors.
- `act.participant` added to `ARRAY_PATHS`; `CcdaParticipant.time` typed.
- Not mapped (follow-up): the policy holder's own name and address (would need a RelatedPerson for `policyHolder`/`subscriber`) and the guarantor (FHIR `Account.guarantor`).
- Test: `payers-section.test.ts` (two policies: full primary, minimal secondary).

## Amendment (PATCHES row 43): the payer is an Organization

Each payer performer becomes an `Organization` (identifier from the assigned entity's id; name, address and telecom from its
representedOrganization, else the assigned entity's own) and `Coverage.payor` references it with the name as display, instead of
a bare `{ identifier, display }` that dropped the payer's address and telephone. Test `payers-section.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 7, 43 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): fba4572, 257e865 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed (the README has the approval process).
