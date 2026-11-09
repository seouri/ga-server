import type { Composition, DocumentReference } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertCcdaToFhir } from '../ccda-to-fhir.ts';
import { convertXmlToCcda } from '../xml.ts';
import { resourcesOf } from './convert-sections.ts';

test('a document or section title with markup becomes plain text (Composition and DocumentReference titles are strings)', () => {
  const bundle = convertCcdaToFhir(
    convertXmlToCcda(`<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient><name><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <title>Health <content styleCode="Bold">Summary</content></title>
  <component><structuredBody><component><section><templateId root="2.16.840.1.113883.10.20.22.2.45"/>
    <code code="69730-0" codeSystem="2.16.840.1.113883.6.1"/><title>Patient <content styleCode="Bold">Instructions</content></title>
    <text><paragraph ID="instr1">Drink plenty of fluids.</paragraph></text>
    <entry><act classCode="ACT" moodCode="INT"><templateId root="2.16.840.1.113883.10.20.22.4.20"/>
      <id root="2.16.840.1.113883.19.5" extension="INSTR-1"/><code code="409073007" codeSystem="2.16.840.1.113883.6.96"/>
      <text><reference value="#instr1"/></text><statusCode code="completed"/></act></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`)
  );
  const [composition] = resourcesOf<Composition>(bundle, 'Composition');
  const [note] = resourcesOf<DocumentReference>(bundle, 'DocumentReference');
  expect(composition.title).toBe('Health Summary');
  expect(composition.section?.[0].title).toBe('Patient Instructions');
  expect(note.content[0].attachment.title).toBe('Patient Instructions');
});

test('a title with markup keeps its words in document order, entities decoded', () => {
  const titles = (title: string) => {
    const bundle = convertCcdaToFhir(
      convertXmlToCcda(`<ClinicalDocument xmlns="urn:hl7-org:v3"><title>${title}</title>
  <component><structuredBody><component><section><code code="69730-0" codeSystem="2.16.840.1.113883.6.1"/><title lang="en">${title}</title><text>x</text></section></component></structuredBody></component>
</ClinicalDocument>`)
    );
    const [composition] = resourcesOf<Composition>(bundle, 'Composition');
    return [composition.title, composition.section?.[0].title];
  };
  expect(titles('Patient <content styleCode="Bold">Instructions</content> for Visit')).toEqual(['Patient Instructions for Visit', 'Patient Instructions for Visit']);
  expect(titles('Lab <sup>2</sup> x')).toEqual(['Lab 2 x', 'Lab 2 x']);
  expect(titles('Notes &amp; <content>Plan</content>')).toEqual(['Notes & Plan', 'Notes & Plan']);
  expect(titles('Plain &lt;title&gt;')).toEqual(['Plain <title>', 'Plain <title>']);
});
