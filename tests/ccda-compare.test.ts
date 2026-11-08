import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertCcdaLocal, repair } from '../src/ccda.ts';
import { ccdaCompare, compareCcda, matchEntries } from '../src/ccda-compare.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const SYNTHETIC = readFileSync(join(FIXTURES, 'ccda-synthetic.xml'), 'utf8');
const EPIC = readFileSync(join(FIXTURES, 'ccda-epic-style.xml'), 'utf8');

// Hand-built Microsoft converter output (its shapes: CDA entry id in identifier[0], urn:oid systems, Medication by reference,
// DiagnosticReport per organizer), run through GA's repair as convertCcdaMs does.
const subject = { reference: 'Patient/ms-p' };
const lab = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] };
const MS_SYNTHETIC = (): Resource[] => repair([
  { resourceType: 'Patient', id: 'ms-p', identifier: [{ system: 'urn:oid:2.25.2222', value: 'FAKE-MRN-0001' }], name: [{ family: 'Synthetic', given: ['Test'] }], gender: 'female', birthDate: '1970-01-01' },
  { resourceType: 'Composition', id: 'ms-c', identifier: { system: 'urn:oid:2.25.1111', value: 'synthetic-doc-1' }, status: 'final', type: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.1', code: '34133-9' }] }, date: '2024-03-15', title: 'Synthetic Health Summary', author: [{ reference: 'Practitioner/ms-a' }] },
  { resourceType: 'Practitioner', id: 'ms-a', identifier: [{ system: 'urn:oid:2.25.3333', value: 'fake-author' }] },
  { resourceType: 'MedicationStatement', id: 'ms-ms', identifier: [{ system: 'urn:oid:2.25.5001', value: 'syn-med-1' }], status: 'active', medicationReference: { reference: 'Medication/ms-m' }, effectivePeriod: { start: '2023-01-01' }, subject },
  { resourceType: 'Medication', id: 'ms-m', code: { coding: [{ system: 'http://hl7.org/fhir/sid/ndc', code: '0000-0000' }] } },
  { resourceType: 'Condition', id: 'ms-c1', identifier: [{ system: 'urn:oid:2.25.6002', value: 'syn-problem-1' }], code: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.96', code: '55822004', display: 'Hyperlipidemia' }] }, onsetDateTime: '2022-06-01', subject },
  { resourceType: 'DiagnosticReport', id: 'ms-dr', identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.798268', value: '9000001' }], status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '57698-3' }] }, effectivePeriod: { start: '2024-03-01' }, result: [{ reference: 'Observation/ms-ldl' }], subject },
  { resourceType: 'Observation', id: 'ms-ldl', identifier: [{ system: 'urn:oid:2.25.7002', value: 'syn-ldl-1' }], status: 'final', category: [lab], code: { coding: [{ system: 'http://loinc.org', code: '13457-7', display: 'LDL' }] }, valueQuantity: { value: 111, unit: 'mg/dL' }, effectiveDateTime: '2024-03-01', interpretation: [{ coding: [{ system: 'urn:oid:2.16.840.1.113883.5.83', code: 'H' }] }], subject },
  { resourceType: 'Observation', id: 'ms-sbp', identifier: [{ system: 'urn:oid:2.25.8002', value: 'syn-sbp-1' }], status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 123, unit: 'mm[Hg]' }, effectiveDateTime: '2024-03-01', subject },
  // A Microsoft lab placeholder: no value, no code beyond text.
  { resourceType: 'Observation', id: 'ms-empty', status: 'final', category: [lab], code: { text: 'Lipid panel' }, subject },
], SYNTHETIC);

test('a field present in the old record and missing in the new is a loss with its element path', () => {
  const local = convertCcdaLocal(SYNTHETIC);
  const r = compareCcda(SYNTHETIC, MS_SYNTHETIC(), local.resources, local.notImported);
  expect(r.losses).toContainEqual({ type: 'Observation', path: 'interpretation.coding', count: 1 });
  // Same meaning in another spelling is no loss: LOINC/SNOMED by OID or URI, value 111 mg/dL, effective date.
  expect(r.losses.filter((l) => l.type === 'Observation').map((l) => l.path)).not.toContain('value[x].value');
  expect(r.losses.filter((l) => l.type === 'Condition')).toEqual([]);
  // Taking (MedicationStatement) matched by drug to the id-less MedicationRequest: the type change and the NDC are losses.
  expect(r.losses).toContainEqual({ type: 'MedicationStatement', path: 'resourceType', count: 1 });
  expect(r.losses).toContainEqual({ type: 'MedicationStatement', path: 'medication[x].coding', count: 1 });
  // Never values: no identifier, name, code or quantity reaches the report.
  expect(JSON.stringify(r)).not.toMatch(/FAKE-MRN|syn-|atorvastatin|Hyperlipidemia|mg\/dL|0000-0000|55822004/);
});

test('an empty old placeholder (no value, no code beyond text) is explained, not a loss', () => {
  const local = convertCcdaLocal(SYNTHETIC);
  const withValue: Resource = { resourceType: 'Observation', id: 'ms-sh', status: 'final', code: { text: 'Alcohol use' }, valueString: 'never', subject } as Resource;
  const r = compareCcda(SYNTHETIC, [...MS_SYNTHETIC(), withValue], local.resources, local.notImported);
  const records = r.losses.filter((l) => l.type === 'Observation' && l.path === '(record)');
  expect(records).toEqual([
    { type: 'Observation', path: '(record)', count: 1, explained: 'no value and no code beyond text' },
    { type: 'Observation', path: '(record)', count: 1 }, // a Microsoft-only record with a value stays a loss
  ]);
});

test('an entry only the new path produces is a gain', () => {
  const local = convertCcdaLocal(SYNTHETIC);
  const r = compareCcda(SYNTHETIC, MS_SYNTHETIC(), local.resources, local.notImported);
  // The vital signs organizer (the Microsoft fixture has none), the smoking status, the second problem; the patient, author and
  // organisation are matched, and the panel matches the Microsoft DiagnosticReport.
  expect(r.gains).toEqual({ Observation: 2, Condition: 1, Organization: 1 });
  expect(r.unaccounted).toEqual([]);
});

test('an entry neither imported nor named is unaccounted', () => {
  const local = convertCcdaLocal(SYNTHETIC);
  const neu = local.resources.filter((r) => !(r.resourceType === 'Observation' && JSON.stringify(r).includes('syn-smoking-1')));
  expect(compareCcda(SYNTHETIC, MS_SYNTHETIC(), neu, local.notImported).unaccounted).toEqual([
    { section: 'Social History', templateId: '2.16.840.1.113883.10.20.22.2.17', entries: 1, reason: 'not imported and not named' },
  ]);
});

test('matchEntries pairs by source entry id first, then id-less by class and code, one to one', () => {
  const ob = (id: string | undefined, code: string): Resource => ({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code }] }, ...(id && { identifier: [{ system: 'urn:oid:1.2', value: id }] }) }) as Resource;
  const [a, b, c] = [ob('a', '1'), ob(undefined, '2'), ob(undefined, '2')];
  const [na, nb, nOther] = [ob('a', '9'), ob(undefined, '2'), ob('z', '2')];
  const m = matchEntries([a, b, c], [nOther, na, nb]);
  expect(m.get(a)).toBe(na); // by id, even with another code
  expect(m.get(b)).toBe(nb); // id-less: same class and code, a record with its own id is never taken
  expect(m.get(c)).toBeUndefined(); // one to one
});

// Epic-style: the spike's known losses, each at its element path.
const MS_EPIC = (): Resource[] => repair([
  { resourceType: 'Encounter', id: 'e1', identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: 'EX-ENC-1' }], status: 'finished', class: { system: 'urn:oid:1.2.840.114350.1.72.1.7.7.10.696784.13260', code: '5' }, location: [{ location: { reference: 'Location/l1' } }], subject } as Resource,
  { resourceType: 'Location', id: 'l1', identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.686980', value: 'EX-DEPT-1' }], name: 'Clinic' },
  { resourceType: 'Condition', id: 'vdx', identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.768076.2', value: 'EX-VISITDX-1' }], code: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.90', code: 'J06.9' }] }, subject },
  { resourceType: 'Immunization', id: 'i1', identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.768179', value: 'EX-IMM-1' }], status: 'completed', vaccineCode: { coding: [{ system: 'urn:oid:2.16.840.1.113883.12.292', code: '140' }] }, route: { coding: [{ system: 'urn:oid:2.16.840.1.113883.3.26.1.1', code: 'C28161' }] }, patient: subject } as Resource,
], EPIC);

test('the Epic-style fixture against the Microsoft path shows the spike losses by path, all accounted', () => {
  const local = convertCcdaLocal(EPIC);
  const r = compareCcda(EPIC, MS_EPIC(), local.resources, local.notImported);
  expect(r.losses).toEqual(expect.arrayContaining([
    { type: 'Encounter', path: 'location.location.reference', count: 1 },
    { type: 'Condition', path: '(record)', count: 1 }, // visit diagnosis (Task 5)
    { type: 'Immunization', path: 'route.coding', count: 1 },
    { type: 'Immunization', path: 'vaccineCode.coding', count: 1 }, // http://nucc.org/cvx is not GA's CVX (Task 8)
    { type: 'Location', path: '(record)', count: 1 },
  ]));
  expect(r.unaccounted).toEqual([]);
});

test('compare never writes', async () => {
  const docs = [
    { resourceType: 'DocumentReference', id: 'd1', content: [{ attachment: { contentType: 'application/xml', url: 'Binary/b1' } }] },
    { resourceType: 'DocumentReference', id: 'd2', content: [{ attachment: { contentType: 'application/xml', url: 'Binary/b2' } }] },
  ];
  const files: Record<string, string> = { 'Binary/b1': SYNTHETIC, 'Binary/b2': '<?xml version="1.0"?><SubmitObjectsRequest/>' };
  const reads = {
    async *searchResourcePages(type: string, q: Record<string, string>) {
      expect([type, q.identifier, q.subject]).toEqual(['DocumentReference', 'urn:ga-server:id:file|', 'Patient/p1']);
      yield docs;
    },
    download: async (url: string) => new Blob([files[url]]),
  };
  // Every other client method (create, update, delete, patch, upload, ...) throws.
  const client = new Proxy(reads, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : () => { throw new Error(`write attempted: ${String(k)}`); }),
  }) as unknown as MedplumClient;
  const report = await ccdaCompare(client, 'p1', 'http://converter/', async (xml) => (xml === SYNTHETIC ? MS_SYNTHETIC() : []));
  expect(report).toMatchObject({ documents: 1, failed: 0, gains: { Observation: 2 }, unaccounted: [] });
  expect(report.losses).toContainEqual({ type: 'Observation', path: 'interpretation.coding', count: 1 });
});
