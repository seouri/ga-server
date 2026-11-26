import type { Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const NS = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const results = (...observations: string[]) => resourcesOf<Observation>(convertSections(`<component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title>
    ${observations.map((o, i) => `<entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5" extension="LAB-${i}"/>
      <code code="1920-8" codeSystem="2.16.840.1.113883.6.1" displayName="AST"/>
      <statusCode code="completed"/><effectiveTime value="20240210"/>${o}
    </observation></entry>`).join('')}</section></component>`), 'Observation');
const range = (text: string, value: string) => `<value xsi:type="PQ" value="5" unit="mg/dL" ${NS}/>
  <referenceRange><observationRange><text>${text}</text>${value}<interpretationCode code="N" codeSystem="2.16.840.1.113883.5.83"/></observationRange></referenceRange>`;

test('a reference range bound without a UCUM unit (nullFlavor OTH) is read from its translation', () => {
  const [obs] = results(range('38 - 234 IU/L', `<value xsi:type="IVL_PQ" ${NS}>
    <low nullFlavor="OTH"><translation nullFlavor="OTH" value="38"><originalText>IU/L</originalText></translation></low>
    <high nullFlavor="OTH"><translation nullFlavor="OTH" value="234"><originalText>IU/L</originalText></translation></high></value>`));
  expect(obs.referenceRange).toEqual([{ low: { value: 38, unit: 'IU/L' }, high: { value: 234, unit: 'IU/L' }, text: '38 - 234 IU/L' }]);
});

test('an open bound (NINF, PINF) is no bound, with or without a unit', () => {
  const [a, b, c] = results(
    range('&lt;=0.50 mg/dL', `<value xsi:type="IVL_PQ" ${NS}><low nullFlavor="NINF" unit="mg/dL" inclusive="false"/><high value="0.50" unit="mg/dL" inclusive="true"/></value>`),
    range('&gt;60.0', `<value xsi:type="IVL_PQ" ${NS}><low nullFlavor="OTH" inclusive="false"><translation nullFlavor="OTH" value="60.0"><originalText>mL/min/1.73m*2</originalText></translation></low><high nullFlavor="PINF"/></value>`),
    range('1.005 - 1.030', `<value xsi:type="IVL_REAL" ${NS}><low value="1.005"/><high value="1.030"/></value>`));
  expect(a.referenceRange).toEqual([{ high: { value: 0.5, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' }, text: '<=0.50 mg/dL' }]);
  expect(b.referenceRange).toEqual([{ low: { value: 60, unit: 'mL/min/1.73m*2' }, text: '>60.0' }]);
  expect(c.referenceRange).toEqual([{ low: { value: 1.005 }, high: { value: 1.03 }, text: '1.005 - 1.030' }]);
});

test('a text range keeps its text; a range with nothing readable is left out', () => {
  const [a, b] = results(
    range('Negative', `<value xsi:type="ST" ${NS}>Negative</value>`),
    `<value xsi:type="PQ" value="5" unit="mg/dL" ${NS}/><referenceRange><observationRange><value xsi:type="IVL_PQ" ${NS}><low nullFlavor="NINF" unit="mg/dL"/><high nullFlavor="PINF" unit="mg/dL"/></value></observationRange></referenceRange>`);
  expect(a.referenceRange).toEqual([{ text: 'Negative' }]);
  expect(b.referenceRange).toBeUndefined();
  expect(b.valueQuantity?.value).toBe(5);
});

test('an interval value is a quantity with a comparator, or a range', () => {
  const [below, above, both, none] = results(
    `<value xsi:type="IVL_PQ" ${NS}><low nullFlavor="NINF" unit="mg/dL" inclusive="false"/><high value="0.2" unit="mg/dL" inclusive="false"/></value>`,
    `<value xsi:type="IVL_REAL" ${NS}><low value="90.0" inclusive="false"/><high nullFlavor="PINF" inclusive="false"/></value>`,
    `<value xsi:type="IVL_REAL" ${NS}><low value="1"/><high value="2"/></value>`,
    `<value xsi:type="IVL_REAL" ${NS}><low nullFlavor="NINF"/><high nullFlavor="PINF"/></value>`);
  expect(below.valueQuantity).toEqual({ value: 0.2, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL', comparator: '<' });
  expect(above.valueQuantity).toEqual({ value: 90, comparator: '>' });
  expect(both.valueRange).toEqual({ low: { value: 1 }, high: { value: 2 } });
  expect(none.valueQuantity).toBeUndefined();
  expect(none.dataAbsentReason?.coding?.[0]?.code).toBe('unknown');
});

test('a base64 RTF value is text when the caller gives an RTF reader, unread otherwise', () => {
  const rtf = btoa('{\\rtf1\\ansi Final diagnosis:\u00a0normal\u001c mucosa}'); // a no-break space and a control character become spaces
  const xml = `<component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title>
    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5" extension="PATH-1"/>
      <code code="22637-3" codeSystem="2.16.840.1.113883.6.1" displayName="Final Diagnosis"/>
      <statusCode code="completed"/><effectiveTime value="20240210"/>
      <value xsi:type="ED" mediaType="text/rtf" representation="B64" ${NS}>${rtf}</value>
    </observation></entry></section></component>`;
  const reader = (s: string) => s.replace(/^\{\\rtf1\\ansi /, '').replace(/\}$/, '');
  const [read] = resourcesOf<Observation>(convertSections(xml, { rtfToText: reader }), 'Observation');
  expect(read.valueString).toBe('Final diagnosis: normal  mucosa');
  const [unread] = resourcesOf<Observation>(convertSections(xml), 'Observation');
  expect(unread.valueString).toBeUndefined();
});
