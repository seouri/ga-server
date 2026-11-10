import { readFileSync } from 'node:fs';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { attachAnnotations, type PrAnnotation } from '../annotations.ts';
import { rebuild } from '../rebuild.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const KNOWN = load('known.json').fhir as Record<string, Resource[]>;
const ANNS = load('annotations.json') as PrAnnotation[];
const [ENDED_CONDITION, AMBIGUOUS, DATE_CHANGE, NOMATCH] = ANNS;

describe('attachAnnotations', () => {
  it('appends the note to a verbatim copy of the known resource', () => {
    const { resources } = attachAnnotations([ENDED_CONDITION], KNOWN, []);
    expect(resources[0]).toEqual({ ...KNOWN.Condition[0], note: [...(KNOWN.Condition[0] as { note: unknown[] }).note, expect.objectContaining({ authorString: 'Patient', text: expect.stringContaining('Ended') })] });
    expect((KNOWN.Condition[0] as { note: unknown[] }).note).toHaveLength(1); // input untouched
  });
  it('reports an annotation matching two resources', () => expect(attachAnnotations([AMBIGUOUS], KNOWN, []).unmatched).toEqual([{ code: 'Synthetic twin', reason: 'several' }]));
  it('reports one matching none', () => expect(attachAnnotations([NOMATCH], KNOWN, []).unmatched).toEqual([{ code: 'Nothing like this', reason: 'none' }]));
  it('adds a note to a rebuilt resource', () => {
    const rebuilt = rebuild(load('bundle.json') as Bundle, KNOWN, {}).resources;
    const { resources, unmatched } = attachAnnotations([DATE_CHANGE], KNOWN, rebuilt);
    expect(unmatched).toEqual([]);
    expect(resources).toHaveLength(rebuilt.length);
    const c = resources.find((r) => r.resourceType === 'Condition') as { note: { text: string }[] };
    expect(c.note.at(-1)!.text).toContain('Date corrected to 2017-07-27T18:24Z');
  });
  const ann = (code: string, orig: string | null): PrAnnotation => ({ annotation_type: 'comment', created_at: '2026-02-02T10:00:00Z', code_display: code, effective_datetime_original: orig, annotation_data: '{"text":"t","type":"comment"}' });
  it('prefers a known resource over a rebuilt one with the same text', () => {
    const rebuilt = [{ resourceType: 'Condition', id: 'eREBUILT0000000000001', code: { text: 'Synthetic condition' } } as Resource];
    const { resources, unmatched } = attachAnnotations([ann('Synthetic condition', null)], KNOWN, rebuilt);
    expect(unmatched).toEqual([]);
    expect(resources.find((r) => r.id === 'eCOND000000000000000001')).toBeDefined();
    expect((resources.find((r) => r.id === 'eREBUILT0000000000001') as { note?: unknown }).note).toBeUndefined();
  });
  it('rejects a single text match on a different day', () => {
    expect(attachAnnotations([ann('Synthetic condition', '2019-01-01T00:00:00Z')], KNOWN, []).unmatched).toEqual([{ code: 'Synthetic condition', reason: 'none' }]);
    expect(attachAnnotations([ann('Synthetic condition', '2020-05-01T09:00:00Z')], KNOWN, []).unmatched).toEqual([]);
  });
  it('matches a MedicationRequest by medicationReference.display', () => {
    const known = { MedicationRequest: [{ resourceType: 'MedicationRequest', id: 'eMR0000000000000000001', status: 'active', intent: 'order', medicationReference: { display: 'Synthetic Drug' }, authoredOn: '2024-03-03' } as Resource] };
    const { resources, unmatched } = attachAnnotations([ann('synthetic drug', '2024-03-03')], known, []);
    expect(unmatched).toEqual([]);
    expect(resources[0]).toMatchObject({ id: 'eMR0000000000000000001' });
  });
  it('omits an empty status date and appends a date-change reason', () => {
    const e = { ...ann('Synthetic condition', null), annotation_type: 'ended' as const, annotation_data: '{"type":"ended"}' };
    const d = { ...ann('Synthetic condition', null), annotation_type: 'date_change' as const, annotation_data: '{"original_date":null,"annotated_date":"2017-07-27","reason":"typo","type":"date_change"}' };
    const notes = attachAnnotations([e, d], KNOWN, []).resources[0] as unknown as { note: { text: string }[] };
    expect(notes.note.at(-2)!.text).toBe('Ended (personalrecord annotation)');
    expect(notes.note.at(-1)!.text).toContain('; reason: typo');
  });
});
