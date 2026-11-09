# 11. Titles with markup → plain text

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. The DocumentReference part applies only with draft 5 (note sections). Nothing filed.

## Issue: @medplum/ccda: a document or section title with markup becomes an object, so the FHIR is invalid

CDA allows markup in `<title>`, for example `<title>Patient <content styleCode="Bold">Instructions</content></title>`. The XML parser turns that into an object such as `{ "#text": "Patient", "content": { "#text": "Instructions", ... } }`. Today the converter copies it straight into `Composition.title` and `Composition.section.title`, and with draft 5 into `DocumentReference.content.attachment.title`. Those are FHIR `string` fields, so a server that validates refuses the resource.

Reproduction (synthetic):

```xml
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient><name><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <title>Health <content styleCode="Bold">Summary</content></title>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.45"/>
    <code code="69730-0" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Patient <content styleCode="Bold">Instructions</content></title>
    <text><paragraph ID="instr1">Drink plenty of fluids.</paragraph></text>
    <entry>
      <act classCode="ACT" moodCode="INT">
        <templateId root="2.16.840.1.113883.10.20.22.4.20"/>
        <id root="2.16.840.1.113883.19.5" extension="INSTR-1"/>
        <code code="409073007" codeSystem="2.16.840.1.113883.6.96"/>
        <text><reference value="#instr1"/></text>
        <statusCode code="completed"/>
      </act>
    </entry>
  </section></component></structuredBody></component>
</ClinicalDocument>
```

Expected FHIR (fields this fix changes):

```json
{ "resourceType": "Composition", "title": "Health Summary", "section": [{ "title": "Patient Instructions" }] }
```

```json
{ "resourceType": "DocumentReference", "content": [{ "attachment": { "contentType": "text/plain", "title": "Patient Instructions" } }] }
```

## PR: fix(ccda): read titles as plain text, in order

- `convertXmlToCcda` makes `<title>` a parser stop node (`stopNodes: ['*.title']`). The parser then returns the title's raw inner XML in document order. A title with attributes still has them under `@_`, with the text under `#text`.
- A new exported `nodeToPlainText(node)` removes tags, decodes the XML entities (a stop node is not entity-decoded) and collapses whitespace. It is used for `Composition.title`, `Composition.section.title` and the note's `attachment.title`.
  - `Patient <content>Instructions</content> for Visit` becomes `Patient Instructions for Visit`.
  - `Lab <sup>2</sup> x` becomes `Lab 2 x`.
  - `Notes &amp; Plan` becomes `Notes & Plan`.
- The parsed object form loses the order of mixed content and fuses the trimmed text pieces, so it cannot be used for this. No other code reads `title`: section routing uses templateIds.
- Test: `title-markup.test.ts`.

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 11 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 87a09a4, 75dee73 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: nothing
- Status: issue-first. Nothing filed (the README has the approval process).
