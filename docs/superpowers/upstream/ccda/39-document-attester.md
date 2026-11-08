# 39. The document's authenticators are Composition attesters

No existing issue or PR. Nothing filed.

## Issue: @medplum/ccda: legalAuthenticator and authenticator are dropped

`createComposition` never reads `ClinicalDocument/legalAuthenticator` or `authenticator`, so the Composition has no `attester`: who signed the document and when is lost.

Reproduction (synthetic), in the header:

```xml
<legalAuthenticator><time value="20200102030400-0500"/><signatureCode code="S"/>
  <assignedEntity><id root="2.16.840.1.113883.19.5" extension="LA"/></assignedEntity></legalAuthenticator>
```

Expected: `attester: [{ mode: "legal", time: "2020-01-02T03:04:00-05:00", party: { reference: "PractitionerRole/..." } }]`, the role pointing at a Practitioner with identifier `LA`; an `authenticator` gives mode `professional`. Actual: no `attester`.

## PR: fix(ccda): Composition.attester from the document's authenticators

- `ccda-to-fhir.ts`: `mapAuthenticatorsToAttesters` (party through `mapAssignedEntityToReference`, as other assigned entities).
- `types.ts`: `Ccda.legalAuthenticator`, `Ccda.authenticator`, `CcdaAuthenticator`; `xml.ts`: `ClinicalDocument.authenticator` is an array.
- Test `document-attester.test.ts`.
