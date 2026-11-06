import { expect, test } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { recordRows, summarize, toBundle, toPdf } from '../src/share/export.ts';
import type { Scoped } from '../src/share/scope.ts';

const r = (o: object): Resource => o as Resource;
const scoped = (resources: Resource[], extra: Partial<Scoped> = {}): Scoped => ({
  patient: r({ resourceType: 'Patient', id: 'p', name: [{ text: 'Test Person' }], birthDate: '1980-01-01', gender: 'female' }) as Scoped['patient'],
  resources, support: [], endpoints: [], ...extra,
});
const ldl = (id: string, date: string, v: number) =>
  r({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '13457-7' }], text: 'LDL' },
    category: [{ coding: [{ code: 'laboratory' }] }], effectiveDateTime: date, valueQuantity: { value: v, unit: 'mg/dL' } });
const cond = (id: string, status: string, cat: string) =>
  r({ resourceType: 'Condition', id, code: { text: id }, clinicalStatus: { coding: [{ code: status }] }, category: [{ coding: [{ code: cat }] }] });
const apple = (i: number) =>
  r({ resourceType: 'Observation', id: `a${i}`, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }], text: 'Heart rate' },
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }] }, effectiveDateTime: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    valueQuantity: { value: 60 + (i % 40), unit: 'bpm' } });

test('labs keep the newest per code', () => {
  const s = summarize(scoped([ldl('1', '2023-01-01', 130), ldl('2', '2024-01-01', 110)]));
  expect(s.labs).toHaveLength(1);
  expect(s.labs[0].value).toBe('110 mg/dL');
});

test('statin with an older source-date is unconfirmed', () => {
  const med = (id: string, d: string) => r({ resourceType: 'MedicationStatement', id, status: 'active', medicationCodeableConcept: { text: 'statin' },
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] }, extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: d }] });
  const s = summarize(scoped([med('old', '2023-01-01T00:00:00Z'), med('new', '2024-01-01T00:00:00Z')]));
  expect(s.medications.find((m) => m.ref === 'MedicationStatement/old')?.note).toBe('unconfirmed (not on the latest hospital list)');
  expect(s.medications.find((m) => m.ref === 'MedicationStatement/new')?.note).toBeUndefined();
});

test('only active problem-list conditions are problems', () => {
  const s = summarize(scoped([cond('a', 'active', 'problem-list-item'), cond('b', 'resolved', 'problem-list-item'), cond('c', 'active', 'encounter-diagnosis')]));
  expect(s.problems.map((p) => p.label)).toEqual(['a']);
});

test('medication reference is named from support; blood pressure components join', () => {
  const med = r({ resourceType: 'Medication', id: 'm', code: { text: 'Atorvastatin' } });
  const ms = r({ resourceType: 'MedicationRequest', id: 'q', status: 'active', medicationReference: { reference: 'Medication/m' } });
  expect(summarize(scoped([ms], { support: [med] })).medications[0].label).toBe('Atorvastatin');
  const bp = r({ resourceType: 'Observation', id: 'bp', status: 'final', code: { text: 'BP' }, category: [{ coding: [{ code: 'vital-signs' }] }], effectiveDateTime: '2024-01-01',
    component: [{ code: { text: 's' }, valueQuantity: { value: 120, unit: 'mmHg' } }, { code: { text: 'd' }, valueQuantity: { value: 80, unit: 'mmHg' } }] });
  expect(summarize(scoped([bp])).vitals[0].value).toBe('120 mmHg / 80 mmHg');
});

const big = scoped([...Array.from({ length: 5000 }, (_, i) => apple(i)), ldl('1', '2024-01-01', 100)]);
test('5000 Apple readings are one summary line and no rows', () => {
  const s = summarize(big);
  expect(s.apple).toHaveLength(1);
  expect(s.apple[0].value).toContain('5000 readings');
  expect(s.apple[0].note).toBe('home reading');
  expect(recordRows(big).flatMap((g) => g.items)).toHaveLength(1);
});

test('bundle: collection, Patient first, meta.source is a basename', () => {
  const o = { ...ldl('1', '2024-01-01', 1), meta: { source: '/a/b/report.pdf' } } as Resource;
  const b = toBundle(scoped([o]));
  expect(b.type).toBe('collection');
  expect(b.entry![0].resource!.resourceType).toBe('Patient');
  expect(b.entry!.every((e) => !e.resource!.meta?.source?.includes('/'))).toBe(true);
  expect(b.entry![1].resource!.meta!.source).toBe('report.pdf');
});

test('pdf is a small PDF even with 5000 Apple readings', async () => {
  const pdf = await toPdf(summarize(big), recordRows(big), { label: 'x', created: '2026-11-06', scope: 'all' });
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  expect(pdf.length).toBeLessThan(1_000_000);
});

test('30,000 Apple readings summarize quickly', () => {
  const many = scoped(Array.from({ length: 30000 }, (_, i) => apple(i)));
  const t = Date.now();
  expect(summarize(many).apple).toHaveLength(1);
  expect(Date.now() - t).toBeLessThan(2000);
});

test('notes merge, values format, code-less and non-completed are dropped, bundle Patient is trimmed', () => {
  const tag = (code: string) => ({ tag: [{ system: 'urn:ga-server:tag', code }] });
  const a = { ...ldl('1', '2024-01-01', 100), meta: tag('possible-duplicate') } as Resource;
  const b = { ...apple(1), meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-apple-health' }, { system: 'urn:ga-server:tag', code: 'extracted-by-llm' }] } } as Resource;
  const str = r({ resourceType: 'Observation', id: 's', status: 'final', code: { text: 'Smell' }, category: [{ coding: [{ code: 'vital-signs' }] }], effectiveDateTime: '2024-01-01', valueString: 'ok' });
  const cod = r({ resourceType: 'Observation', id: 'c', status: 'final', code: { text: 'Colour' }, category: [{ coding: [{ code: 'vital-signs' }] }], effectiveDateTime: '2024-01-01', valueCodeableConcept: { text: 'red' } });
  const none = r({ resourceType: 'Observation', id: 'n', status: 'final', code: {}, category: [{ coding: [{ code: 'laboratory' }] }], effectiveDateTime: '2024-01-01' });
  const imm = (id: string, status: string) => r({ resourceType: 'Immunization', id, status, vaccineCode: { text: 'Flu' }, occurrenceDateTime: '2024-01-01' });
  const sc = scoped([a, b, str, cod, none, imm('i1', 'completed'), imm('i2', 'entered-in-error')]);
  sc.patient = { ...sc.patient, identifier: [{ value: 'MRN' }], address: [{ city: 'X' }] } as Scoped['patient'];
  const s = summarize(sc);
  expect(s.labs.map((x) => x.note)).toEqual(['possible duplicate']);
  expect(s.apple[0].note).toBe('read from a document by AI; home reading');
  expect(s.vitals.map((x) => x.value).sort()).toEqual(['ok', 'red']);
  expect(s.immunizations.map((x) => x.ref)).toEqual(['Immunization/i1']);
  const p = toBundle(sc).entry![0].resource as unknown as Record<string, unknown>;
  expect(p.identifier).toBeUndefined();
  expect(p.address).toBeUndefined();
});

test('medications-only share: an old med is unconfirmed when the newest import is a lab outside the share', () => {
  const med = r({ resourceType: 'MedicationStatement', id: 'old', status: 'active', medicationCodeableConcept: { text: 'statin' },
    meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] }, extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2023-01-01T00:00:00Z' }] });
  expect(summarize(scoped([med])).medications[0].note).toBeUndefined();
  const s = summarize(scoped([med], { newestImport: Date.parse('2025-01-01T00:00:00Z') }));
  expect(s.medications[0].note).toBe('unconfirmed (not on the latest hospital list)');
});

test('bundle drops Medplum storage and Binary urls from DocumentReference attachments, keeps the rest', () => {
  const doc = r({ resourceType: 'DocumentReference', id: 'd', content: [
    { attachment: { contentType: 'application/pdf', title: 'a.pdf', url: 'http://localhost:8103/storage/00000000-0000-0000-0000-000000000001/a.pdf?Signature=x' } },
    { attachment: { contentType: 'text/rtf', url: 'Binary/00000000-0000-0000-0000-000000000002' } },
    { attachment: { contentType: 'text/plain', data: 'eA==', title: 'note' } },
  ] });
  const out = toBundle(scoped([doc])).entry![1].resource as any;
  expect(out.content.map((c: any) => c.attachment)).toEqual([
    { contentType: 'application/pdf', title: 'a.pdf' }, { contentType: 'text/rtf' }, { contentType: 'text/plain', data: 'eA==', title: 'note' },
  ]);
  expect((doc as any).content[0].attachment.url).toContain('/storage/');
});
