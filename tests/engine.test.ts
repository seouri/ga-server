import { expect, test } from 'vitest';
import type { MedicationStatement, Resource } from '@medplum/fhirtypes';
import type { MedplumClient } from '@medplum/core';
import { badRequest, OperationOutcomeError, serverError, validationError } from '@medplum/core';
import { decide, importResources } from '../src/engine.ts';
import { stamp, type SourceInfo } from '../src/identity.ts';

const src = (date: string, writer: SourceInfo['writer'] = 'importer'): SourceInfo => ({ kind: 'ccda', file: 'a.xml', date, writer });
const ID = { system: 'urn:ga-server:id:ccda', value: 'm1' };
const ms = (status: MedicationStatement['status']): MedicationStatement => ({
  resourceType: 'MedicationStatement',
  status,
  medicationCodeableConcept: { text: 'metformin' },
  subject: { reference: 'Patient/p' },
});
const existing = (r: Resource, s: SourceInfo): Resource => ({ ...stamp(r, s, ID), id: 'srv-1', meta: { ...stamp(r, s, ID).meta, versionId: '1' } });

test('create when none', () => {
  expect(decide(undefined, stamp(ms('active'), src('2024-01-01'), ID))).toBe('create');
});

test('older source does not overwrite', () => {
  const ex = existing(ms('stopped'), src('2024-06-01'));
  expect(decide(ex, stamp(ms('active'), src('2024-03-01'), ID))).toBe('skip');
  expect(decide(ex, stamp(ms('active'), src('2024-06-01'), ID))).toBe('skip');
});

test('equal content skips', () => {
  // existing carries an extra identifier from an earlier merge, in a different order
  const ex = existing({ ...ms('active'), identifier: [{ system: 'urn:ga-server:id:pdf', value: 'h' }] } as Resource, src('2024-01-01'));
  expect(decide(ex, stamp(ms('active'), src('2024-06-01T10:00:00Z'), ID))).toBe('skip');
});

test('newer different content updates', () => {
  const ex = existing(ms('active'), src('2024-01-01'));
  expect(decide(ex, stamp(ms('stopped'), src('2024-06-01'), ID))).toBe('update');
});

test('agent-written conflicts', () => {
  const ex = existing(ms('active'), src('2024-01-01', 'agent'));
  expect(decide(ex, stamp(ms('stopped'), src('2024-06-01'), ID))).toBe('conflict');
});

test('agent-written equal content skips', () => {
  const ex = existing(ms('active'), src('2024-01-01', 'agent'));
  expect(decide(ex, stamp(ms('active'), src('2024-06-01'), ID))).toBe('skip');
  expect(decide(ex, stamp(ms('stopped'), src('2023-06-01'), ID))).toBe('skip');
});

test('re-stamped Composition with singular identifier skips', () => {
  const comp = { resourceType: 'Composition', status: 'final', title: 't', identifier: { value: 'doc' } } as Resource;
  expect(decide(existing(comp, src('2024-01-01')), stamp(comp, src('2024-01-01'), ID))).toBe('skip');
  expect(decide(existing(comp, src('2024-01-01')), stamp({ ...comp, title: 'u' } as Resource, src('2024-02-01'), ID))).toBe('update');
});

test('a record last changed by someone other than GA conflicts; the source-conflict tag sticks', () => {
  const GA = 'ClientApplication/ga';
  const by = (author: string, tag?: string): Resource => {
    const ex = existing(ms('active'), src('2024-01-01'));
    return { ...ex, meta: { ...ex.meta, author: { reference: author }, tag: [...(ex.meta?.tag ?? []), ...(tag ? [{ system: 'urn:ga-server:tag', code: tag }] : [])] } };
  };
  const newer = stamp(ms('stopped'), src('2024-06-01'), ID);
  expect(decide(by('Practitioner/person'), newer, GA)).toBe('conflict');
  expect(decide(by(GA, 'source-conflict'), newer, GA)).toBe('conflict');
  expect(decide(by(GA), newer, GA)).toBe('update');
  expect(decide(by('Practitioner/person'), stamp(ms('active'), src('2024-06-01'), ID), GA)).toBe('skip'); // nothing to write
});

// Fake client: one failure injected at search or create.
const fake = (where: 'search' | 'create', err: Error) =>
  ({
    getProfile: () => undefined,
    readResource: async () => ({ resourceType: 'Patient', id: 'p', identifier: [] }),
    updateResource: async (r: Resource) => r,
    searchOne: async () => {
      if (where === 'search') throw err;
      return undefined;
    },
    searchResources: async () => [],
    createResource: async (r: Resource) => {
      if (where === 'create') throw err;
      return { ...r, id: 'new' };
    },
  }) as unknown as MedplumClient;
const one = [{ ...ms('active'), id: 'm1' } as Resource];

test('a 400 validation failure on write is counted invalid, not thrown', async () => {
  const err = new OperationOutcomeError(validationError('missing', ['MedicationStatement.status']));
  expect(await importResources(fake('create', err), one, src('2024-01-01'), 'p', 'h')).toMatchObject({ invalid: 1, created: 0 });
});

test('non-validation errors abort the import', async () => {
  for (const [where, err] of [
    ['create', new OperationOutcomeError(serverError(new Error('boom')))],
    ['create', new OperationOutcomeError(badRequest('generic bad request', 'MedicationStatement.status'))],
    ['search', new OperationOutcomeError(validationError('bad search param', ['identifier']))],
    ['create', new Error('network')],
  ] as const) {
    await expect(importResources(fake(where, err), one, src('2024-01-01'), 'p', 'h')).rejects.toThrow();
  }
});
