import { readFileSync } from 'node:fs';
import type { Bundle, DocumentReference, MedicationRequest, Resource } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { rebuild } from '../rebuild.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const BUNDLE = load('bundle.json') as Bundle;
const KNOWN = load('known.json').fhir as Record<string, Resource[]>;

describe('rebuild', () => {
  it('rebuilds a medication order after the cutoff', () => {
    const { resources } = rebuild(BUNDLE, KNOWN, {});
    const m = resources.find((r) => r.resourceType === 'MedicationRequest') as MedicationRequest;
    expect(m).toMatchObject({ id: 'eMED00000000000000001', status: 'unknown', intent: 'order', authoredOn: '2026-01-07', medicationCodeableConcept: { text: 'Synthetic drug 5 mg' } });
    expect(m.meta).toBeUndefined();
    expect((m as unknown as Record<string, unknown>).subject).toBeUndefined();
  });
  it('skips known ids and records before the cutoff', () => {
    expect(rebuild(BUNDLE, KNOWN, {}).report).toMatchObject({ alreadyKnown: 1, beforeCutoff: 1, otherSource: 1, notEpic: 1, cutoff: '2025-12-31' });
  });
  it('includes records before the cutoff on request', () => expect(rebuild(BUNDLE, KNOWN, { includeBeforeCutoff: true }).report.beforeCutoff).toBe(0));
  it('carries a note text into a DocumentReference attachment', () => {
    const d = rebuild(BUNDLE, KNOWN, {}).resources.find((r) => r.resourceType === 'DocumentReference') as DocumentReference;
    expect(Buffer.from(d.content[0].attachment.data!, 'base64').toString()).toBe('synthetic note text');
  });
  it('omits an unparseable note date instead of failing', () => {
    const entry = (BUNDLE.entry ?? []).find((e) => e.resource?.id?.startsWith('docref-'))!;
    const bad = { ...BUNDLE, entry: [{ resource: { ...entry.resource, effectiveDateTime: 'not a date' } as Resource }] };
    const d = rebuild(bad, KNOWN, { includeBeforeCutoff: true }).resources[0] as DocumentReference;
    expect(d.resourceType).toBe('DocumentReference');
    expect(d.date).toBeUndefined();
  });
  it('maps each prefix to its type and drops app fields', () => {
    const { resources, report } = rebuild(BUNDLE, KNOWN, {});
    expect(report.emitted).toEqual({ Observation: 1, MedicationRequest: 1, DocumentReference: 1, Condition: 1, DiagnosticReport: 1, Immunization: 1, Procedure: 1 });
    const o = resources.find((r) => r.resourceType === 'Observation') as Record<string, unknown>;
    for (const k of ['subject', 'meta', 'extension', 'source', 'data_type', 'element_id']) expect(o[k]).toBeUndefined();
    expect(o.note).toEqual([{ text: 'Reconstructed from a personalrecord export; original structure lost.' }]);
    const c = resources.find((r) => r.resourceType === 'Condition') as Record<string, unknown>;
    expect(c).toMatchObject({ id: 'eCND00000000000001', recordedDate: '2026-01-09' });
    expect((c.note as unknown[]).length).toBe(2);
  });
});
