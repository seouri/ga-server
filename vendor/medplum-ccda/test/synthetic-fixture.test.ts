import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { convertCcdaToFhir, convertXmlToCcda } from '../index.ts';

test('vendored library converts the synthetic fixture like the npm package', () => {
  const xml = readFileSync(resolve(import.meta.dirname, '../../../tests/fixtures/ccda-synthetic.xml'), 'utf8');
  const bundle = convertCcdaToFhir(convertXmlToCcda(xml));
  const counts: Record<string, number> = {};
  for (const e of bundle.entry ?? []) counts[e.resource?.resourceType ?? '?'] = (counts[e.resource?.resourceType ?? '?'] ?? 0) + 1;
  expect(counts.Observation).toBe(4); // GA: the result panel is a DiagnosticReport (PATCHES row 20)
  expect(counts.Condition).toBe(2);
  expect(counts.MedicationStatement).toBe(1);
  expect(counts.DiagnosticReport).toBe(1);
});
