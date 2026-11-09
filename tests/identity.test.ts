import { expect, test } from 'vitest';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { APPLE, contentKey, LAST_SEEN, sameDay, stableIdentifier, stamp, type SourceInfo } from '../src/identity.ts';

const ccda: SourceInfo = { kind: 'ccda', file: 'a.xml', date: '2024-07-26T00:00:00Z', writer: 'importer' };
const pdf: SourceInfo = { kind: 'pdf', file: 'b.pdf', date: '2024-08-01', writer: 'agent', llm: true };
const obs = (dt?: string, coded = true): Observation => ({
  resourceType: 'Observation',
  id: 'o1',
  status: 'final',
  code: coded ? { coding: [{ system: 'http://loinc.org', code: '4548-4' }] } : { text: 'A1c' },
  effectiveDateTime: dt,
  valueQuantity: { value: 5.6, unit: '%' },
});

test('stableIdentifier is deterministic for ccda and pdf', () => {
  const a = stableIdentifier(obs('2024-07-26'), pdf, 'h');
  expect(a).toEqual(stableIdentifier(obs('2024-07-26'), pdf, 'h'));
  expect(a.system).toBe('urn:ga-server:id:pdf');
  expect(a.value).toMatch(/^[0-9a-f]{64}$/);
  expect(stableIdentifier(obs('2024-07-27'), pdf, 'h').value).not.toBe(a.value);
  expect(stableIdentifier(obs('2024-07-26'), pdf, 'h2').value).not.toBe(a.value);
  const cond: Resource = { resourceType: 'Condition', id: 'x', subject: { reference: 'Patient/1' } };
  expect(stableIdentifier(cond, pdf, 'h')).toEqual(stableIdentifier({ ...cond, id: 'y', meta: {} }, pdf, 'h'));
});

test('contentKey ignores time of day', () => {
  expect(contentKey(obs('2024-07-26T08:00:00Z'))).toBe('http://loinc.org|4548-4|2024-07-26');
  expect(contentKey(obs('2024-07-26T08:00:00Z'))).toBe(contentKey(obs('2024-07-26T17:00:00Z')));
});

test('contentKey undefined when uncoded or undated', () => {
  expect(contentKey(obs('2024-07-26', false))).toBeUndefined();
  expect(contentKey(obs(undefined))).toBeUndefined();
});

test('stamp is idempotent and does not mutate', () => {
  const r = obs('2024-07-26');
  const id = stableIdentifier(r, pdf, 'h');
  const once = stamp(r, pdf, id);
  expect(r.identifier).toBeUndefined();
  const twice = stamp(once, pdf, id);
  expect(twice).toEqual(once);
  expect((twice as Observation).identifier).toHaveLength(1);
  expect(twice.meta?.tag?.map((t) => t.code).sort()).toEqual(['extracted-by-llm', 'src-pdf', 'writer-agent']);
  expect(twice.meta?.source).toBe('b.pdf');
  expect((twice as Observation).extension).toEqual([
    { url: 'urn:ga-server:ext:source-date', valueDateTime: '2024-08-01' },
  ]);
});

test('stamp keeps Composition identifier singular', () => {
  const id = { system: 'urn:ga-server:id:ccda', value: 'c1' };
  const comp = { resourceType: 'Composition', id: 'c1', identifier: { system: 'urn:oid:1', value: 'doc' } } as Resource;
  expect((stamp(comp, ccda, id) as { identifier?: unknown }).identifier).toEqual(id);
  const bare = { resourceType: 'Composition', id: 'c1' } as Resource;
  expect((stamp(bare, ccda, id) as { identifier?: unknown }).identifier).toEqual(id);
});

test('ccda stableIdentifier keys on the source identifier, else a reference-free content hash', () => {
  const med = { resourceType: 'MedicationStatement', id: 'm1', status: 'active', identifier: [{ system: 'urn:oid:1.2', value: 'e1' }] } as Resource;
  expect(stableIdentifier(med, ccda, 'h')).toEqual({ system: 'urn:ga-server:id:ccda', value: 'MedicationStatement|urn:oid:1.2|e1' });
  // Converter ids differ across documents; the source identifier doesn't.
  expect(stableIdentifier({ ...med, id: 'other', status: 'stopped' } as Resource, ccda, 'h2')).toEqual(stableIdentifier(med, ccda, 'h'));
  // Observation/Encounter source ids repeat within a document: source id + content hash.
  const src = { ...obs(), identifier: [{ system: 'urn:oid:1.2', value: 'e1' }] };
  expect(stableIdentifier(src, ccda, 'h').value).toMatch(/^Observation\|urn:oid:1\.2\|e1\|[0-9a-f]{64}$/);
  expect(stableIdentifier({ ...src, id: 'other' }, ccda, 'h').value).toBe(stableIdentifier(src, ccda, 'h').value);
  expect(stableIdentifier({ ...src, valueQuantity: { value: 9, unit: '%' } }, ccda, 'h').value).not.toBe(stableIdentifier(src, ccda, 'h').value);
  const comp = { resourceType: 'Composition', id: 'c', identifier: { system: 'urn:oid:9', value: 'd' } } as Resource;
  expect(stableIdentifier(comp, ccda, 'h').value).toBe('Composition|urn:oid:9|d');

  const allergy = { resourceType: 'AllergyIntolerance', id: 'a1', code: { text: 'x' }, patient: { reference: 'Patient/p1' } } as Resource;
  const h = stableIdentifier(allergy, ccda, 'h');
  expect(h.value).toMatch(/^AllergyIntolerance\|[0-9a-f]{64}$/);
  expect(stableIdentifier({ ...allergy, id: 'a2', meta: { versionId: '3' }, patient: { reference: 'Patient/p2' } } as Resource, ccda, 'h')).toEqual(h);
  expect(stableIdentifier({ ...allergy, code: { text: 'y' } } as Resource, ccda, 'h')).not.toEqual(h);
});

test('ccda content hash is patient-scoped for patient resources only', () => {
  const allergy = { resourceType: 'AllergyIntolerance', code: { text: 'x' }, patient: { reference: 'Patient/a' } } as Resource;
  expect(stableIdentifier(allergy, ccda, 'h', 'p1').value).not.toBe(stableIdentifier(allergy, ccda, 'h', 'p2').value);
  const medication = { resourceType: 'Medication', code: { text: 'x' } } as Resource;
  expect(stableIdentifier(medication, ccda, 'h', 'p1').value).toBe(stableIdentifier(medication, ccda, 'h', 'p2').value);
});

test('stableIdentifier for apple-health returns the first Apple identifier', () => {
  const apple: SourceInfo = { kind: 'apple-health', file: 'e.xml', date: '2026-11-05T00:00:00Z', writer: 'importer' };
  const o = { ...obs('2026-03-01'), identifier: [{ system: APPLE, value: 'abc' }] };
  expect(stableIdentifier(o, apple, '')).toEqual({ system: APPLE, value: 'abc' });
  expect(() => stableIdentifier(obs('2026-03-01'), apple, '')).toThrow(/no Apple Health identifier/);
});

const smart: SourceInfo = { kind: 'smart', file: 'https://fhir.example.org/R4', date: '2026-11-05T00:00:00Z', writer: 'importer' };
const SMART_ID = { system: 'urn:ga-server:id:smart:fhir-example-org', value: 'Observation/1' };

test('stableIdentifier for smart returns the first SMART identifier', () => {
  const o = { ...obs('2026-03-01'), identifier: [SMART_ID, { system: 'urn:oid:1.2.840.114350.1', value: 'x' }] };
  expect(stableIdentifier(o, smart, '')).toEqual(SMART_ID);
  expect(() => stableIdentifier(obs('2026-03-01'), smart, '')).toThrow(/no SMART identifier/);
  expect(() => stableIdentifier({ ...obs('2026-03-01'), identifier: [{ system: APPLE, value: 'a' }] }, smart, '')).toThrow(/no SMART identifier/);
});

test('stamp uses the per-resource source date and writes last-seen', () => {
  const r = { ...obs('2026-03-01'), identifier: [SMART_ID] };
  const dated = stamp(r, { ...smart, dateOf: () => '2026-01-02T00:00:00Z' }, SMART_ID) as Observation;
  expect(dated.extension).toEqual([{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2026-01-02T00:00:00Z' }]);
  expect(dated.meta?.tag?.map((t) => t.code)).toContain('src-smart');
  const at = { ...smart, dateOf: () => undefined, seenAt: '2026-11-05T00:00:00Z' };
  // Only medications, problems and allergies carry last-seen: no daily rewrite of every portal lab.
  expect((stamp(r, at, SMART_ID) as Observation).extension).toEqual([{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2026-11-05T00:00:00Z' }]);
  const seen = stamp({ resourceType: 'Condition', subject: r.subject, identifier: [SMART_ID] } as Resource, at, SMART_ID) as Observation;
  expect(LAST_SEEN).toBe('urn:ga-server:ext:last-seen');
  expect(seen.extension).toEqual([
    { url: 'urn:ga-server:ext:source-date', valueDateTime: '2026-11-05T00:00:00Z' },
    { url: LAST_SEEN, valueDateTime: '2026-11-05T00:00:00Z' },
  ]);
});

test('sameDay reads the instant in the first value\'s offset; a date-only side compares as written', () => {
  expect(sameDay('2024-03-01T19:30:00-05:00', '2024-03-02T00:30:00Z')).toBe(true);
  expect(sameDay('2024-03-01T19:30:00-05:00', '2024-03-02T15:00:00Z')).toBe(false); // next local day
  expect(sameDay('2024-03-01T23:00:00+09:00', '2024-03-01T14:30:00Z')).toBe(true);
  expect(sameDay('2024-03-01', '2024-03-01T22:00:00-05:00')).toBe(true);
  expect(sameDay('2024-03-01', '2024-03-02')).toBe(false);
});

test('a C-CDA Encounter keys on its id alone; an Observation on id + content hash', () => {
  const enc = { resourceType: 'Encounter', identifier: [{ system: 'urn:oid:1.2', value: 'v1' }], status: 'finished' } as Resource;
  expect(stableIdentifier(enc, ccda, 'h').value).toBe('Encounter|urn:oid:1.2|v1');
  expect(stableIdentifier({ ...enc, resourceType: 'Observation' } as Resource, ccda, 'h').value).toMatch(/^Observation\|urn:oid:1\.2\|v1\|[0-9a-f]{64}$/);
});

test('an id-less C-CDA entry keys alike in two documents that number its narrative anchor differently', () => {
  const nka = (anchor: string) => ({ resourceType: 'AllergyIntolerance', patient: { reference: 'urn:uuid:p' }, clinicalStatus: { text: 'active' },
    extension: [{ url: 'https://medplum.com/fhir/StructureDefinition/ccda-narrative-reference', valueString: anchor }] }) as Resource;
  const key = (r: Resource) => stableIdentifier(r, ccda, 'h', 'pid').value;
  expect(key(nka('#al1'))).toBe(key(nka('#allergy-7')));
  // any other content still separates entries
  expect(key(nka('#al1'))).not.toBe(key({ ...nka('#al1'), clinicalStatus: { text: 'resolved' } } as Resource));
  // two id-less entries of one document named only by text (the library puts a referenced name in code.text) stay two
  expect(key({ ...nka('#al1'), code: { text: 'Peanuts' } } as Resource)).not.toBe(key({ ...nka('#al2'), code: { text: 'Shellfish' } } as Resource));
});
