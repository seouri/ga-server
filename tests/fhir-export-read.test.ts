import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Condition, DiagnosticReport, DocumentReference } from '@medplum/fhirtypes';
import { readFhirExport } from '../src/fhir-export/read.ts';
import { sourceKey } from '../src/smart/auth.ts';
import { mapForGa } from '../src/smart/fetch.ts';

const dir = join(import.meta.dirname, 'fixtures', 'fhir-export');
const MINI = join(dir, 'mini.json');
const NOT_EXPORT = join(dir, 'not-export.json');

describe('readFhirExport', () => {
  it('places attachments and counts the unplaced one', () => {
    const r = readFhirExport(MINI);
    const doc = r.resources.find((x) => x.resourceType === 'DocumentReference') as DocumentReference;
    expect(doc.content[0].attachment.data).toBeDefined();
    expect(r.attachmentsUnplaced).toBe(1);
  });
  it('counts unsupported types', () => expect(readFhirExport(MINI).skippedTypes).toEqual({ Account: 1 }));
  it('places report html for mapForGa to convert', () => {
    const dr = readFhirExport(MINI).resources.find((x) => x.resourceType === 'DiagnosticReport') as DiagnosticReport;
    expect(dr.presentedForm?.[0]).toMatchObject({ contentType: 'text/html' });
    expect(dr.presentedForm?.[0].data).toBeDefined();
  });
  it('dates the export by the newest lastUpdated', () => expect(readFhirExport(MINI).date).toBe('2026-10-01T12:00:00.000Z'));
  it('refuses a file without a fhir object', () => expect(() => readFhirExport(NOT_EXPORT)).toThrow('not a FHIR export: expected {"fhir": {...}}'));
  it('file import and portal sync give the same identifier', () => {
    const base = 'https://fhir.example.org/api/FHIR/R4/';
    const src = { key: sourceKey(base), name: 'x', fhirBase: base };
    const fromFile = mapForGa(readFhirExport(MINI).resources, src).resources.find((x) => x.resourceType === 'Condition')!;
    expect((fromFile as Condition).identifier?.[0]).toEqual({ system: `urn:ga-server:id:smart:${sourceKey(base)}`, value: 'Condition/c1' });
  });

  const exportWith = (attachments: object[], extra: object = {}): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'ga-fe-')), 'e.json');
    const doc = { fhir: { DocumentReference: [{ resourceType: 'DocumentReference', id: 'd1', status: 'current', content: [{ attachment: { contentType: 'text/html' } }] }], ...extra }, attachments };
    writeFileSync(f, JSON.stringify(doc));
    return f;
  };
  const att = (path: string) => ({ resourceType: 'DocumentReference', resourceId: 'd1', path, contentType: 'text/html', contentBase64: 'eA==' });
  it('refuses a prototype path', () => {
    const r = readFhirExport(exportWith([att('__proto__.polluted'), att('content.0.constructor'), att('content.0.attachment.__proto__')]));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.attachmentsUnplaced).toBe(3);
  });
  it('counts an out-of-range index as unplaced', () => {
    const r = readFhirExport(exportWith([att('content.5.attachment'), att('content.1')]));
    expect(r.attachmentsUnplaced).toBe(2);
    expect((r.resources[0] as DocumentReference).content).toHaveLength(1);
  });
  it('counts a length path as unplaced', () => {
    const r = readFhirExport(exportWith([att('content.length'), att('content.0.attachment')]));
    expect(r.attachmentsUnplaced).toBe(1);
  });
  it('counts resources without an id or of another type', () => {
    const r = readFhirExport(exportWith([], { Condition: [{ resourceType: 'Condition' }, { resourceType: 'Observation', id: 'x' }] }));
    expect(r.skippedTypes).toEqual({ 'Condition (invalid)': 2 });
  });
});
