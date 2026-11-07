import { expect, test, vi } from 'vitest';
import type { MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import type { MedplumClient } from '@medplum/core';
import { badRequest, OperationOutcomeError, serverError, validationError } from '@medplum/core';
import { decide, fillFrom, importResources, sameValue } from '../src/engine.ts';
import { ARRIVED, stableIdentifier, stamp, type SourceInfo } from '../src/identity.ts';

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
  expect(decide(ex, stamp(ms('active'), src('2024-06-01T10:00:00Z'), ID))).toBe('update'); // newer source re-confirms a medication
  const obs = { resourceType: 'Observation', status: 'final', code: { text: 'x' } } as Resource;
  expect(decide(existing(obs, src('2024-01-01')), stamp(obs, src('2024-06-01'), ID))).toBe('skip'); // other types: no churn
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

test('merging a source into a person-edited match keeps it protected with source-conflict', async () => {
  const obs = (id?: string) => ({
    resourceType: 'Observation', id, status: 'final', subject: { reference: 'Patient/p' },
    code: { coding: [{ system: 'http://loinc.org', code: '2093-3' }] },
    effectiveDateTime: '2024-01-01T08:00:00Z', valueQuantity: { value: 180, unit: 'mg/dL' },
  }) as Resource;
  // An imported record a person later edited; the incoming source is older, so decide() says skip and only the identifier is appended.
  const edited = {
    ...obs('srv-9'), meta: { author: { reference: 'Practitioner/person' } },
    extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2024-06-01' }],
  } as Resource;
  const writes: Resource[] = [];
  const client = {
    getProfile: () => ({ resourceType: 'ClientApplication', id: 'ga' }),
    readResource: async () => ({ resourceType: 'Patient', id: 'p', identifier: [] }),
    searchOne: async () => undefined,
    searchResources: async () => [edited],
    updateResource: async (r: Resource) => (writes.push(r), r),
  } as unknown as MedplumClient;
  expect(await importResources(client, [obs('o1')], src('2024-01-01'), 'p', 'h')).toMatchObject({ merged: 1 });
  expect(writes.at(-1)?.meta?.tag).toContainEqual({ system: 'urn:ga-server:tag', code: 'source-conflict' });
});

const ehi: SourceInfo = { kind: 'ehi', file: '/x/ehi', date: '2026-11-04', writer: 'importer' };
const EHI_ID = { system: 'urn:ga-server:id:ehi:synthetic-org', value: 'PAT_ENC|123' };
const EPIC_CSN = { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.3.698084.8', value: '123' };

test('stableIdentifier for ehi uses identifier[0]', () => {
  const enc = { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, identifier: [EHI_ID, EPIC_CSN] } as Resource;
  expect(stableIdentifier(enc, ehi, 'h', 'p')).toEqual(EHI_ID);
  // singular identifier types (QuestionnaireResponse) carry it as an object
  const qr = { resourceType: 'QuestionnaireResponse', status: 'completed', identifier: EHI_ID } as Resource;
  expect(stableIdentifier(qr, ehi, 'h', 'p')).toEqual(EHI_ID);
});

test('stableIdentifier for ehi without a GA identifier throws', () => {
  const enc = (identifier?: unknown) => ({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, identifier }) as Resource;
  expect(() => stableIdentifier(enc(), ehi, 'h', 'p')).toThrow(/EHI identifier/);
  expect(() => stableIdentifier(enc([EPIC_CSN, EHI_ID]), ehi, 'h', 'p')).toThrow(/EHI identifier/);
  expect(() => stableIdentifier(enc([{ system: EHI_ID.system }]), ehi, 'h', 'p')).toThrow(/EHI identifier/);
});

test('sameValue compares quantities, strings, first codings and booleans (R19)', () => {
  const o = (v: Partial<Observation>): Observation => ({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, ...v });
  const cc = (system: string, code: string, text?: string) => ({ valueCodeableConcept: { coding: [{ system, code }], ...(text && { text }) } });
  expect(sameValue(o(cc('http://snomed.info/sct', '266919005', 'Never')), o(cc('http://snomed.info/sct', '266919005')))).toBe(true);
  expect(sameValue(o(cc('http://snomed.info/sct', '266919005')), o(cc('http://snomed.info/sct', '8517006')))).toBe(false);
  expect(sameValue(o(cc('http://snomed.info/sct', '1')), o(cc('http://loinc.org', '1')))).toBe(false);
  expect(sameValue(o({ valueCodeableConcept: { text: 'Never' } }), o({ valueCodeableConcept: { text: 'Never' } }))).toBe(false); // no coding: not compared
  expect(sameValue(o({ valueBoolean: false }), o({ valueBoolean: false }))).toBe(true);
  expect(sameValue(o({ valueBoolean: true }), o({ valueBoolean: false }))).toBe(false);
  expect(sameValue(o({ valueString: 'a' }), o({ valueString: 'a' }))).toBe(true);
  expect(sameValue(o({ valueQuantity: { value: 1, unit: 'kg' } }), o({ valueQuantity: { value: 1, unit: 'g' } }))).toBe(false);
  expect(sameValue(o({}), o({}))).toBe(false);
});

// C1/I1: an EHI update never replaces a more specific existing value with a less specific one.
const EHI: SourceInfo = { kind: 'ehi', file: 'x', date: '2026-01-17', writer: 'importer' };
const SNO = { system: 'http://snomed.info/sct', code: '1' };
test('EHI fill keeps codings, references, periods, known status, UCUM and unmatched results', () => {
  const ex = {
    resourceType: 'Observation', status: 'final', code: { coding: [SNO] }, subject: { reference: 'Patient/p' },
    interpretation: [{ coding: [{ system: 'v3', code: 'H' }], text: 'High' }],
    effectivePeriod: { start: '2024-01-05T09:00:00Z', end: '2024-01-05T10:00:00Z' },
    valueQuantity: { value: 5, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
    referenceRange: [{ low: { value: 1, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' } }],
  } as unknown as Resource;
  const inc = {
    resourceType: 'Observation', status: 'unknown', code: { text: 'Thing' }, subject: { reference: 'Patient/p' },
    interpretation: [{ text: 'H' }], effectiveDateTime: '2024-01-05', valueQuantity: { value: 5, unit: 'mg/dL' },
    referenceRange: [{ low: { value: 1, unit: 'mg/dL' } }],
  } as unknown as Resource;
  const f = fillFrom(ex, inc, EHI) as unknown as Record<string, unknown>;
  expect(f).toEqual({ ...ex, code: { coding: [SNO], text: 'Thing' } });
  // Idempotent: the stored result filled again is equal (decide compares bodies once source dates are out of the way).
  expect(decide(f as unknown as Resource, fillFrom(f as unknown as Resource, inc, EHI))).toBe('skip');
  // C-CDA unchanged: the incoming body as is.
  expect(fillFrom(ex, inc, src('2026-01-01'))).toBe(inc);
});

test('EHI fill: participant display over reference, unknown status, same-day period; a more specific incoming value wins', () => {
  const p = { individual: { reference: 'Practitioner/1', display: 'DR X' }, type: [{ coding: [{ code: 'ATND' }] }] };
  const ex = { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, participant: [p], period: { start: '2024-01-05T09:00:00-05:00', end: '2024-01-05T10:00:00-05:00' } } as unknown as Resource;
  const inc = { resourceType: 'Encounter', status: 'unknown', participant: [{ individual: { display: 'X, DR' } }], period: { start: '2024-01-05' } } as unknown as Resource;
  expect(fillFrom(ex, inc, EHI)).toEqual(ex);
  const newer = { resourceType: 'Encounter', status: 'cancelled', period: { start: '2024-01-06' }, participant: [{ individual: { reference: 'Practitioner/2' } }] } as unknown as Resource;
  expect(fillFrom(ex, newer, EHI)).toMatchObject({ status: 'cancelled', period: { start: '2024-01-06' }, participant: [{ individual: { reference: 'Practitioner/2' } }] });
  // Another day replaces the period; a text-only concept over a text-only one is just newer.
  const o = { resourceType: 'Observation', effectivePeriod: { start: '2024-01-05' }, code: { text: 'a' } } as unknown as Resource;
  expect(fillFrom(o, { resourceType: 'Observation', effectiveDateTime: '2024-01-07', code: { text: 'b' } } as unknown as Resource, EHI)).toEqual({ resourceType: 'Observation', effectiveDateTime: '2024-01-07', code: { text: 'b' } });
  // A report keeps the results the export didn't match, existing first.
  const dr = (refs: string[]) => ({ resourceType: 'DiagnosticReport', result: refs.map((reference) => ({ reference })) }) as unknown as Resource;
  expect(fillFrom(dr(['Observation/a', 'Observation/b']), dr(['Observation/c', 'Observation/a']), EHI)).toEqual(dr(['Observation/a', 'Observation/b', 'Observation/c']));
});

test('arrival is not content', () => {
  const ex = existing(ms('active'), src('2024-01-01'));
  const withArrival = { ...ex, extension: [...((ex as MedicationStatement).extension ?? []), { url: ARRIVED, valueInstant: '2024-01-02T00:00:00.000Z' }] } as Resource;
  expect(decide(withArrival, stamp(ms('active'), src('2024-01-01'), ID))).toBe('skip');
});

test('each created record is stamped with its own arrival time', async () => {
  vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z') });
  try {
    const created: Resource[] = [];
    const client = {
      ...fake('search', new Error('unused')),
      searchOne: async () => undefined,
      createResource: async (r: Resource) => (created.push(r), vi.advanceTimersByTime(60_000), { ...r, id: `n${created.length}` }),
    } as unknown as MedplumClient;
    await importResources(client, [{ ...ms('active'), id: 'a' }, { ...ms('stopped'), id: 'b' }] as Resource[], src('2024-01-01'), 'p', 'h');
    const at = created.map((r) => (r as MedicationStatement).extension?.find((e) => e.url === ARRIVED)?.valueInstant);
    expect(at).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z']);
  } finally {
    vi.useRealTimers();
  }
});
