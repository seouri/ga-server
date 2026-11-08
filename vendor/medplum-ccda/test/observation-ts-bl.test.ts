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
