import { describe, expect, it } from 'vitest';
import type { AuditEvent, Resource } from '@medplum/fhirtypes';
import { auditKey, binaryIds, mismatches, normalise, rewriteShares, sourceDoc, stripExtracted } from '../src/migrate.ts';
import type { Share } from '../src/share/store.ts';

const obs = {
  resourceType: 'Observation',
  id: 'o1',
  meta: { source: '/x/labs.pdf', tag: [{ system: 'urn:ga-server:tag', code: 'extracted-by-llm' }] },
  status: 'final',
  code: { text: 'LDL' },
  subject: { reference: 'Patient/p1' },
  derivedFrom: [{ reference: 'DocumentReference/d1' }, { reference: 'Observation/o0' }],
  valueQuantity: { value: 100, unit: 'mg/dL' },
} as Resource;
const cond = {
  resourceType: 'Condition',
  id: 'c1',
  subject: { reference: 'Patient/p1' },
  code: { text: 'Hypertension' },
  note: [{ text: 'Extracted from DocumentReference/d2' }, { text: 'as printed' }],
} as Resource;
const report = { resourceType: 'DiagnosticReport', meta: { source: '/tmp/a/labs.pdf' }, status: 'final', code: { text: 'Panel' }, result: [{ reference: 'Observation/o1' }] } as Resource;

describe('stripExtracted', () => {
  it('drops what importExtracted adds and keeps the extracted values and id', () => {
    expect(stripExtracted(obs)).toEqual({ resourceType: 'Observation', id: 'o1', status: 'final', code: { text: 'LDL' }, derivedFrom: [{ reference: 'Observation/o0' }], valueQuantity: { value: 100, unit: 'mg/dL' } });
    expect(stripExtracted(cond)).toEqual({ resourceType: 'Condition', id: 'c1', code: { text: 'Hypertension' }, note: [{ text: 'as printed' }] });
    expect(stripExtracted({ ...cond, note: [{ text: 'Extracted from DocumentReference/d2' }] } as Resource)).not.toHaveProperty('note');
    expect(obs.meta).toBeDefined(); // input untouched
  });
});

describe('sourceDoc', () => {
  const titles = new Map([['labs.pdf', ['d1']], ['dup.pdf', ['d3', 'd4']]]);
  it('finds the source document by derivedFrom, note, then unique file name', () => {
    expect(sourceDoc(obs, titles)).toBe('d1');
    expect(sourceDoc(cond, titles)).toBe('d2');
    expect(sourceDoc(report, titles)).toBe('d1');
    expect(sourceDoc({ ...report, meta: { source: '/y/dup.pdf' } } as Resource, titles)).toBeUndefined();
    expect(sourceDoc({ resourceType: 'Encounter' } as Resource, titles)).toBeUndefined();
  });
});

describe('verification', () => {
  const rows = [{ type: 'Observation', old: 5, new: 5 }, { type: 'Condition', old: 2, new: 3 }, { type: 'Procedure', old: 4, new: 1 }];
  it('migrate needs equal counts; delete-old only needs the new copy not smaller', () => {
    expect(mismatches(rows, true).map((r) => r.type)).toEqual(['Condition', 'Procedure']);
    expect(mismatches(rows, false).map((r) => r.type)).toEqual(['Procedure']);
  });
  it('normalise ignores server ids and array order', () => {
    const a = { results: [{ v: 'MMR', records: [{ id: '11111111-1111-4111-8111-111111111111' }] }, { v: 'Tdap' }] };
    const b = { results: [{ v: 'Tdap' }, { v: 'MMR', records: [{ id: '22222222-2222-4222-8222-222222222222' }] }] };
    expect(normalise(a)).toBe(normalise(b));
    expect(normalise(a)).not.toBe(normalise({ results: [{ v: 'Tdap' }] }));
  });
});

describe('rewriteShares', () => {
  it('moves only the old patient, tokens untouched', () => {
    const s = (id: string, patientId: string) => ({ id, patientId, tokenHash: `h-${id}` }) as Share;
    expect(rewriteShares([s('a', 'old'), s('b', 'other')], 'old', 'new')).toEqual([s('a', 'new'), s('b', 'other')]);
  });
});

describe('binaryIds', () => {
  it('reads Binary ids from references and presigned storage URLs', () => {
    const id1 = '11111111-1111-4111-8111-111111111111', id2 = '22222222-2222-4222-8222-222222222222';
    const docs = [
      { resourceType: 'DocumentReference', content: [{ attachment: { url: `Binary/${id1}` } }] },
      { resourceType: 'DocumentReference', content: [{ attachment: { url: `http://localhost:8103/storage/${id2}/abc?Signature=x` } }] },
      { resourceType: 'DocumentReference', content: [{ attachment: { url: `Binary/${id1}` } }] },
    ] as Resource[];
    expect(binaryIds(docs)).toEqual([id1, id2]);
  });
});

describe('auditKey', () => {
  it('matches a copied access log event, not a different one', () => {
    const e = { resourceType: 'AuditEvent', id: 'a', recorded: '2026-01-02T03:04:05.000Z', meta: { tag: [{ system: 'urn:ga-server:share', code: 's1' }] }, entity: [{ what: { reference: 'Patient/new' } }] } as AuditEvent;
    const copy = { ...e, id: 'b', recorded: '2026-01-02T03:04:05Z', meta: { ...e.meta, lastUpdated: '2026-02-01T00:00:00Z' } } as AuditEvent;
    expect(auditKey(copy)).toBe(auditKey(e));
    expect(auditKey({ ...e, recorded: '2026-01-02T03:04:06Z' })).not.toBe(auditKey(e));
    expect(auditKey({ ...e, entity: [{ what: { display: 'fhir_search' } }] })).not.toBe(auditKey(e));
  });
});
