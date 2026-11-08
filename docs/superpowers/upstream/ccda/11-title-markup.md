# 11. Titles with markup → plain text

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

## PR: fix(ccda): flatten document and section titles to text

- New `nodeToPlainText(node)` returns all the node's text with whitespace collapsed. It puts the node's own `#text` first, then its elements' text, using the existing `indexNarrativeText` walk with a scratch map. It is used for `Composition.title`, `Composition.section.title` and the note `attachment.title`.
- Limitation: the parsed node does not keep the order of mixed content, and the parser trims each text piece. That means `A <content>B</content> C` reads as `AC B`. All the text is kept, but the order can be lost. Fixing this needs the parser's `preserveOrder`, which is out of scope.
- Test: `title-markup.test.ts`.
