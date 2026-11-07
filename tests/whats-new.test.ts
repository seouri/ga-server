import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Observation, Resource } from '@medplum/fhirtypes';
import type { MedplumClient } from '@medplum/core';
import { expect, test } from 'vitest';
import { clinicalDate, followUpItems, kindOf, labItems, medicationItems, readLastSeen, statusItems, tally, whatsNew, writeLastSeen } from '../src/whats-new.ts';

const TAG = 'urn:ga-server:tag';
const tag = (code: string) => ({ tag: [{ system: TAG, code }] });
const obs = (extra: object = {}) => ({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, ...extra }) as Resource;

test('kindOf covers each branch', () => {
  expect(kindOf(obs({ meta: tag('src-apple-health'), category: [{ coding: [{ code: 'vital-signs' }] }] }))).toBe('Apple Health readings');
  expect(kindOf(obs({ category: [{ coding: [{ code: 'vital-signs' }] }] }))).toBe('vital signs');
  expect(kindOf(obs({ category: [{ coding: [{ code: 'laboratory' }] }] }))).toBe('lab results');
  expect(kindOf(obs({ meta: tag('extracted-by-llm') }))).toBe('lab results');
  expect(kindOf(obs())).toBe('lab results');
  const t = (resourceType: string) => kindOf({ resourceType } as Resource);
  expect([t('MedicationStatement'), t('MedicationRequest'), t('Condition'), t('AllergyIntolerance'), t('Immunization'), t('Procedure'), t('Encounter'), t('DocumentReference'), t('Communication'), t('FamilyMemberHistory')])
    .toEqual(['medications', 'medications', 'problems', 'allergies', 'vaccines', 'procedures', 'visits', 'notes and messages', 'notes and messages', 'other']);
});

test('clinicalDate takes the first present field', () => {
  expect(clinicalDate(obs({ effectiveDateTime: '2024-01-02T10:00:00Z', issued: '2025-01-01' }))).toBe('2024-01-02');
  expect(clinicalDate(obs({ effectivePeriod: { start: '2024-03-04' }, issued: '2025-01-01' }))).toBe('2024-03-04');
  expect(clinicalDate({ resourceType: 'Condition', onsetDateTime: '2020-05-06', recordedDate: '2021-01-01' } as Resource)).toBe('2020-05-06');
  expect(clinicalDate({ resourceType: 'Communication', sent: '2023-07-08T01:00:00Z' } as Resource)).toBe('2023-07-08');
  expect(clinicalDate({ resourceType: 'Procedure', performedDateTime: '2019-02-03T00:00:00Z' } as Resource)).toBe('2019-02-03');
  expect(clinicalDate({ resourceType: 'Procedure', performedPeriod: { start: '2018-04-05' } } as Resource)).toBe('2018-04-05');
  expect(clinicalDate(obs())).toBeUndefined();
});

test('tally splits historical at 365 days and lists sources', () => {
  const smart = { identifier: [{ system: 'urn:ga-server:id:smart:portal-a', value: 'Observation/1' }] };
  const t = tally([
    obs({ effectiveDateTime: '2025-11-06', meta: tag('src-pdf') }),
    obs({ effectiveDateTime: '2025-11-07', ...smart }),
    { resourceType: 'Condition' } as Resource,
  ], '2026-11-07');
  expect(t).toEqual({ total: 3, historical: 1, noRangeGiven: 2, byKind: { 'lab results': 2, problems: 1 }, sources: ['PDF or photo', 'portal-a'] });
});

test('last-seen file: missing, then round trip with mode 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wn-'));
  expect(readLastSeen(dir)).toBeUndefined();
  writeLastSeen('2026-11-07T01:02:03.000Z', dir);
  expect(readLastSeen(dir)).toBe('2026-11-07T01:02:03.000Z');
  expect(statSync(join(dir, 'whats-new.json')).mode & 0o777).toBe(0o600);
});

test('readLastSeen ignores a corrupt or unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wn-'));
  writeFileSync(join(dir, 'whats-new.json'), '{not json');
  expect(readLastSeen(dir)).toBeUndefined();
  writeFileSync(join(dir, 'whats-new.json'), 'null');
  expect(readLastSeen(dir)).toBeUndefined();
  expect(readLastSeen(join(dir, 'whats-new.json'))).toBeUndefined(); // a file where the directory should be
});

const ARRIVED = 'urn:ga-server:ext:arrived';
const ldl = (id: string, date: string, value: number, extra: object = {}) => obs({
  id, code: { coding: [{ system: 'http://loinc.org', code: '13457-7' }], text: 'LDL' }, effectiveDateTime: date, valueQuantity: { value, unit: 'mg/dL' },
  referenceRange: [{ high: { value: 100, unit: 'mg/dL' } }], ...extra,
}) as Observation;

test('labItems: high with previous, no range, and historical', () => {
  const a = ldl('a', '2026-10-01', 160), old = ldl('b', '2025-01-01', 120);
  const [item, ...rest] = labItems([a], [a, old], '2026-11-07');
  expect(rest).toEqual([]);
  expect(item).toMatchObject({ kind: 'lab', title: 'LDL', date: '2026-10-01', id: 'a', detail: { flag: 'high', previous: { date: '2025-01-01' } } });
  const plain = obs({ id: 'c', effectiveDateTime: '2026-10-01', valueQuantity: { value: 5 } }) as Observation;
  expect(labItems([plain], [plain], '2026-11-07')).toEqual([]);
  const h = ldl('d', '2024-05-05', 170);
  expect(labItems([h], [h], '2026-11-07')).toEqual([]);
});

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const med = (id: string, over: object) => ({ resourceType: 'MedicationStatement', id, status: 'active', ...over }) as Resource;
const arrivedExt = (at: string) => ({ extension: [{ url: ARRIVED, valueInstant: at }] });

test('medicationItems: new only when no earlier record shares the code or name', () => {
  const since = '2026-11-01T00:00:00Z';
  const coded = (id: string, at: string) => med(id, { medicationCodeableConcept: { coding: [{ system: RX, code: '1234' }], text: 'Drug A' }, ...arrivedExt(at) });
  const earlier = coded('e', '2026-01-01T00:00:00Z'), fresh = coded('f', '2026-11-02T00:00:00Z');
  expect(medicationItems([fresh], [earlier, fresh], since, '2026-11-07')).toEqual([]);
  const items = medicationItems([fresh], [fresh], since, '2026-11-07');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'new medication', title: 'Drug A', detail: { rxnorm: '1234', status: 'active' } });
  const named = (id: string, text: string, ext: object) => med(id, { medicationCodeableConcept: { text }, ...ext });
  const oldN = named('o', 'Drug  B', {}), newN = named('n', 'drug b', arrivedExt('2026-11-02T00:00:00Z'));
  expect(medicationItems([newN], [oldN, newN], since, '2026-11-07')).toEqual([]);
});

const vac = (vaccine: string, status: string, n: number) => ({ vaccine, status, reason: 'r', records: Array.from({ length: n }, () => ({ date: '2020-01-01', source: 's' })) });
const hm = (topic: string, status: string, next?: string) => obs({
  id: topic, code: { text: `Health maintenance: ${topic}` }, valueString: status,
  extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2026-06-01' }],
  ...(next && { component: [{ code: { text: 'Next due date' }, valueDateTime: next }] }),
}) as Observation;

test('followUpItems: started vaccine series and Epic health maintenance', () => {
  const v = { edition: 'x', asOf: '2026-11-07', unmatched: [], possibleDuplicates: [], results: [vac('zoster', 'due', 1), vac('flu', 'due', 0), vac('mmr', 'complete', 2)] } as unknown as Parameters<typeof followUpItems>[0];
  const items = followUpItems(v, [hm('Colonoscopy', 'Overdue', '1900-01-01'), hm('Mammogram', 'Not Due', '2026-11-08')], '2026-11-07', '1970-01-01');
  expect(items.map((i) => [i.kind, i.title])).toEqual([['vaccine follow-up', 'zoster'], ['health maintenance', 'Colonoscopy']]);
  expect(items[1].detail).toEqual({ status: 'Overdue', nextDue: undefined, asOfExport: '2026-06-01' });
});

test('medicationItems resolves a referenced Medication for RxNorm and name', () => {
  const since = '2026-11-01T00:00:00Z';
  const m = { resourceType: 'Medication', id: 'm1', code: { coding: [{ system: RX, code: '999' }], text: 'Drug C' } } as Resource;
  const ref = (id: string, ext: object) => med(id, { medicationReference: { reference: 'Medication/m1' }, meta: { source: '/x/clinic.xml' }, ...ext });
  const fresh = ref('f', arrivedExt('2026-11-02T00:00:00Z'));
  const [item] = medicationItems([fresh], [m, fresh], since, '2026-11-07');
  expect(item).toMatchObject({ title: 'Drug C', source: 'clinic.xml', id: 'f', detail: { rxnorm: '999' } });
  expect(medicationItems([fresh], [m, fresh, ref('e', {})], since, '2026-11-07')).toEqual([]);
});

test('whatsNew: first run, markSeen and since', async () => {
  const empty = { resourceType: 'Bundle', entry: [] };
  const client = {
    search: async () => empty, searchOne: async () => undefined, searchResources: async () => [],
    searchResourcePages: async function* () { yield []; },
    readResource: async () => ({ resourceType: 'Patient', birthDate: '1980-01-01', gender: 'female' }),
  } as unknown as MedplumClient;
  const dir = mkdtempSync(join(tmpdir(), 'ga-wn-'));
  const run = (o: object) => whatsNew(client, 'p', Promise.resolve([]), { asOf: '2026-11-07', dir, ...o });
  const first = await run({});
  expect(first).toMatchObject({ since: '2026-08-09', firstRun: true, items: [], medicationCheck: [], tally: { total: 0 } });
  expect(first.note).toContain('not a full interaction screen');
  expect(readLastSeen(dir)).toBeUndefined();
  await run({ since: '2026-11-01', markSeen: true });
  expect(readLastSeen(dir)).toBeUndefined();
  await run({ markSeen: true });
  const at = readLastSeen(dir);
  expect(at).toBeDefined();
  expect(await run({})).toMatchObject({ since: at });
  expect((await run({})).firstRun).toBeUndefined();
});

const ARRIVED_EXT = { url: 'urn:ga-server:ext:arrived', valueInstant: '2026-11-05T00:00:00Z' };
const big = (patient: object = { resourceType: 'Patient', birthDate: '1980-01-01' }, longMeds = 0) => {
  const labs = Array.from({ length: 1000 }, (_, i) => ({ resourceType: 'Observation', id: `o${i}`, status: 'final', code: { text: `Test number ${i}` }, effectiveDateTime: '2026-11-01', valueQuantity: { value: 9, unit: 'mg' }, interpretation: [{ coding: [{ code: 'H' }] }], extension: [ARRIVED_EXT] }));
  const meds = Array.from({ length: 4 }, (_, i) => ({ resourceType: 'MedicationStatement', id: `m${i}`, status: 'active', medicationCodeableConcept: { text: `Drug ${i}`, coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: `${100 + i}` }] }, effectiveDateTime: '2026-11-02', extension: [ARRIVED_EXT] }));
  const old = Array.from({ length: longMeds }, (_, i) => ({ resourceType: 'MedicationStatement', id: `l${i}`, status: 'active', medicationCodeableConcept: { text: `Long drug ${i} ${'y'.repeat(100)}` } }));
  const client = {
    search: async (type: string) => ({ resourceType: 'Bundle', entry: (type === 'MedicationStatement' ? [...meds, ...old] : labs).map((resource) => ({ resource })) }), searchOne: async () => undefined, searchResources: async () => [],
    searchResourcePages: async function* (type: string) { yield type === 'Observation' ? labs : type === 'MedicationStatement' ? meds : []; },
    readResource: async () => patient, readHistory: async () => ({ entry: [] }),
  } as unknown as MedplumClient;
  const text = 'x'.repeat(10_000);
  const fetch = (async (u: string) => ({ ok: true, status: 200, json: async () => ({ results: [{ set_id: 's', effective_time: '20260101', drug_interactions: [text], warnings: [text], contraindications: [text], boxed_warning: [text], warnings_and_cautions: [text], use_in_specific_populations: [text] }] }) })) as unknown as typeof globalThis.fetch;
  return { client, fetch, dir: mkdtempSync(join(tmpdir(), 'ga-wn-')) };
};

test('whatsNew: the whole result stays under the remote cap, note and labels kept', async () => {
  const { client, fetch, dir } = big();
  const r = await whatsNew(client, 'p', Promise.resolve([]), { asOf: '2026-11-07', fetch, dir });
  expect(JSON.stringify(r).length).toBeLessThan(150_000);
  expect(JSON.stringify(r).startsWith('{"note":')).toBe(true);
  expect(r.items.length).toBeGreaterThan(10);
  expect(r.items.filter((i) => i.kind === 'new medication')).toHaveLength(4);
  expect(r.truncated).toBe(true);
  expect(r.itemsTotal).toBe(1004);
  expect(r.seen).toBeUndefined();
  const mc = r.medicationCheck as { label: { status: string } }[];
  expect(mc.length).toBe(4);
  expect(mc[0].label.status).toBe('ok');
  expect(mc.some((c) => c.label.status === 'omitted: too large')).toBe(true);
});

test('whatsNew: a failed section is {error} or sectionErrors and the rest returns', async () => {
  const { client, fetch, dir } = big({ resourceType: 'Patient' }); // no birthDate: vaccines fail
  const r = await whatsNew(client, 'p', Promise.resolve([]), { asOf: '2026-11-07', fetch, dir });
  expect(r.sectionErrors?.['follow-ups']).toMatch(/birthDate/);
  expect(r.items.some((i) => i.kind === 'lab')).toBe(true);
  expect((r.tally as { total: number }).total).toBeGreaterThan(0);
});

test('whatsNew: markSeen is refused when the summary was cut or a section failed', async () => {
  const cutOne = big();
  const r = await whatsNew(cutOne.client, 'p', Promise.resolve([]), { asOf: '2026-11-07', fetch: cutOne.fetch, dir: cutOne.dir, markSeen: true });
  expect(r).toMatchObject({ seen: false, seenReason: expect.stringContaining('cut') });
  expect(readLastSeen(cutOne.dir)).toBeUndefined();
  const bad = big({ resourceType: 'Patient' });
  expect(await whatsNew(bad.client, 'p', Promise.resolve([]), { asOf: '2026-11-07', fetch: bad.fetch, dir: bad.dir, markSeen: true })).toMatchObject({ seen: false, seenReason: expect.stringContaining('failed') });
  expect(readLastSeen(bad.dir)).toBeUndefined();
});

test('whatsNew: large current lists and many errors still fit the cap', async () => {
  const { client, fetch, dir } = big(undefined, 600);
  const r = await whatsNew(client, 'p', Promise.resolve([]), { asOf: '2026-11-07', fetch, dir });
  const meds = (r.context.currentMedications as { rows: unknown[]; total: number; truncated?: true });
  expect(meds.truncated).toBe(true);
  expect(meds.total).toBe(604);
  expect(JSON.stringify(r).length).toBeLessThan(150_000);
});

test('whatsNew: markSeen writes when everything succeeded and nothing was cut', async () => {
  const { client, fetch, dir } = big(undefined, 0);
  const small = { ...client, search: async () => ({ resourceType: 'Bundle', entry: [] }), searchResourcePages: async function* () { yield []; } } as unknown as MedplumClient;
  expect(await whatsNew(small, 'p', Promise.resolve([]), { asOf: '2026-11-07', fetch, dir, markSeen: true })).toMatchObject({ seen: true });
  expect(readLastSeen(dir)).toBeDefined();
});

test('whatsNew: tally counts labs with no range given', () => {
  const noRange = obs({ id: 'n', valueQuantity: { value: 1 } }), ranged = obs({ id: 'r', referenceRange: [{ high: { value: 5 } }] });
  expect(tally([noRange, ranged], '2026-11-07').noRangeGiven).toBe(1);
});

test('medicationItems: first-import burst, uncoded copies and name-only matches', () => {
  const since = '2026-11-01T00:00:00Z';
  const fresh = (id: string, over: object) => med(id, { ...arrivedExt('2026-11-02T00:00:00Z'), ...over });
  const stoppedOld = fresh('s', { status: 'stopped', medicationCodeableConcept: { text: 'Old drug' }, effectiveDateTime: '2019-01-01' });
  const stoppedRecent = fresh('r', { status: 'stopped', medicationCodeableConcept: { text: 'Recent drug' }, effectiveDateTime: '2026-06-01' });
  const activeOld = fresh('a', { medicationCodeableConcept: { text: 'Active drug' }, effectiveDateTime: '2019-01-01' });
  expect(medicationItems([stoppedOld, stoppedRecent, activeOld], [stoppedOld, stoppedRecent, activeOld], since, '2026-11-07').map((i) => i.id)).toEqual(['r', 'a']);
  const earlierUncoded = med('e', { medicationCodeableConcept: { text: 'Drug A' } });
  const coded = fresh('c', { medicationCodeableConcept: { text: 'Drug A', coding: [{ system: RX, code: '1234' }] } });
  expect(medicationItems([coded], [earlierUncoded, coded], since, '2026-11-07')).toEqual([]);
});

test('statusItems: names referenced drugs and reads history in small pages', async () => {
  const stmt = { resourceType: 'MedicationStatement', id: 's1', status: 'stopped', medicationReference: { reference: 'Medication/m1' }, meta: { lastUpdated: '2026-11-05T00:00:00Z' } };
  const versions = Array.from({ length: 45 }, (_, i) => ({ resource: { ...stmt, status: i < 30 ? 'stopped' : 'active', meta: { lastUpdated: i < 30 ? `2026-11-0${(i % 4) + 2}T00:00:00Z` : '2026-10-01T00:00:00Z' } } }));
  const calls: unknown[] = [];
  const client = {
    searchResourcePages: async function* (type: string) { yield type === 'MedicationStatement' ? [stmt] : []; },
    readHistory: async (_t: string, _id: string, o: { count: number; offset: number }) => (calls.push(o), { entry: versions.slice(o.offset, o.offset + o.count) }),
  } as unknown as MedplumClient;
  const m = { resourceType: 'Medication', id: 'm1', code: { text: 'Drug D' } } as Resource;
  const items = await statusItems(client, 'p', '2026-11-01T00:00:00Z', [m]);
  expect(items).toMatchObject([{ title: 'Drug D', detail: { from: 'active', to: 'stopped' } }]);
  expect(calls).toHaveLength(2);
});

test('whatsNew: label lookups run at most 3 at a time', async () => {
  const { client, fetch, dir } = big();
  let now = 0, max = 0;
  const slow = (async (...a: Parameters<typeof fetch>) => { max = Math.max(max, ++now); await new Promise((r) => setTimeout(r, 10)); now--; return fetch(...a); }) as typeof fetch;
  await whatsNew(client, 'p', Promise.resolve([]), { asOf: '2026-11-07', fetch: slow, dir });
  expect(max).toBe(3);
});
