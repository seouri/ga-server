import type { Observation } from '@medplum/fhirtypes';
import { afterEach, expect, test, vi } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

afterEach(() => vi.restoreAllMocks());

const result = (valueXml: string) => resourcesOf<Observation>(convertSections(`<component><section>
  <templateId root="2.16.840.1.113883.10.20.22.2.3.1" extension="2015-08-01"/>
  <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
    <id root="2.16.840.1.113883.19.5" extension="LAB-1"/>
    <code code="8665-2" codeSystem="2.16.840.1.113883.6.1" displayName="Last menstrual period start date"/>
    <statusCode code="completed"/><effectiveTime value="20240210"/>${valueXml}
  </observation></entry></section></component>`), 'Observation')[0];

test('a TS value is valueDateTime and a BL value valueBoolean, with no warning', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(result('<value xsi:type="TS" value="20240101"/>').valueDateTime).toBe('2024-01-01');
  expect(result('<value xsi:type="BL" value="true"/>').valueBoolean).toBe(true);
  expect(result('<value xsi:type="BL" value="false"/>').valueBoolean).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

test('a TS or BL without a value gives none', () => {
  expect(result('<value xsi:type="TS" nullFlavor="UNK"/>').valueDateTime).toBeUndefined();
  expect(result('<value xsi:type="BL" nullFlavor="UNK"/>').valueBoolean).toBeUndefined();
});

test('a BL value in another case parses; a TS or BL value that does not parse gives no value (never a mangled dateTime)', () => {
  expect(result('<value xsi:type="BL" value="TRUE"/>').valueBoolean).toBe(true);
  expect(result('<value xsi:type="BL" value="False"/>').valueBoolean).toBe(false);
  for (const bad of ['<value xsi:type="BL" value="maybe"/>', '<value xsi:type="TS" value="garbage"/>', '<value xsi:type="TS" value="20241345"/>']) {
    const o = result(bad);
    expect([o.valueBoolean, o.valueDateTime, o.dataAbsentReason]).toEqual([undefined, undefined, undefined]);
  }
});

test('a TS or BL value with a nullFlavor is data-absent', () => {
  const absent = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason', code: 'unknown' }] };
  expect(result('<value xsi:type="TS" nullFlavor="UNK"/>').dataAbsentReason).toEqual(absent);
  expect(result('<value xsi:type="BL" nullFlavor="NI"/>').dataAbsentReason).toEqual(absent);
});

test('a value of any type with a nullFlavor is data-absent, never an empty value', () => {
  const absent = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason', code: 'unknown' }] };
  for (const type of ['PQ', 'REAL', 'CD', 'CE', 'CO', 'ST', 'INT', 'ED']) {
    const o = result(`<value xsi:type="${type}" nullFlavor="UNK"/>`);
    expect(o.dataAbsentReason).toEqual(absent);
    expect([o.valueQuantity, o.valueCodeableConcept, o.valueString, o.valueInteger]).toEqual([undefined, undefined, undefined, undefined]);
  }
  expect(result('<value xsi:type="PQ" nullFlavor="UNK" unit="mg/dL"/>').valueQuantity).toBeUndefined();
  // A value with content keeps it.
  expect(result('<value xsi:type="PQ" value="5" unit="mg/dL"/>')).toMatchObject({ valueQuantity: { value: 5 } });
  expect(result('<value xsi:type="CD" nullFlavor="OTH"><originalText>Other</originalText></value>').dataAbsentReason).toBeUndefined();
  // A number that does not parse: no value (never NaN) and no data-absent reason (the caller names it).
  for (const type of ['PQ', 'REAL', 'INT']) expect(result(`<value xsi:type="${type}" value="abc" unit="mg/dL"/>`)).not.toHaveProperty('valueQuantity.value');
  expect(result('<value xsi:type="INT" value="abc"/>').valueInteger).toBeUndefined();
});
