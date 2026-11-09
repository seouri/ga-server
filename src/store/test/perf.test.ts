// Search speed baseline on one Patient with 20,000 Observations (every type open): later work on the store must keep these
// limits. Limit = 1.5x the median of 5 runs on the starting code, rounded up to 10 ms (measured -> limit, ms):
// code+sort 2.9 -> 10; category+date 14.6 -> 30; subject 3.5 -> 10; _has 2.8 -> 10; chain 8.3 -> 20.
// System search (added with _type, measured then): unsorted 1.2 -> 10; sorted by -_lastUpdated 8.7 -> 20.
// RSS after the run measured 345 MB in a vitest worker (300 MB is not realistic: the 20,000 rows themselves grow it by ~343 MB), so the
// limit is measured + 25%, 440 MB.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Observation } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Store } from '../store.ts';

// RSS growth from before the store opens to after the run: measured 342-345 MB (3 runs), limit + 25%.
const GROWTH_MB = 430;
const BASE = 'http://store.local/', DAY = 86_400_000, N = 20_000;
const CODES = ['2093-3', '2085-9', '2571-8', '13457-7', '4548-4'];
const LAB = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];
let dir: string, store: Store, pid: string, rssBefore: number;

beforeAll(() => {
  rssBefore = process.memoryUsage().rss;
  dir = mkdtempSync(join(tmpdir(), 'store-perf-'));
  store = new Store(join(dir, 'store.db')); // no types: every R4 type
  pid = store.create({ resourceType: 'Patient', birthDate: '1980-02-03' }).resource.id!;
  const now = Date.now();
  store.transaction(() => {
    for (let i = 0; i < N; i++) {
      store.create({
        resourceType: 'Observation', status: 'final', subject: { reference: `Patient/${pid}` },
        code: { coding: [{ system: 'http://loinc.org', code: CODES[i % 5] }] },
        ...(i % 2 ? { category: LAB } : {}),
        effectiveDateTime: new Date(now - ((i * 3650) / N) * DAY).toISOString().slice(0, 10),
        valueQuantity: { value: i % 100, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
      } as Observation);
    }
  });
}, 120_000);
afterAll(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });

const fiveYearsAgo = new Date(Date.now() - 5 * 365 * DAY).toISOString().slice(0, 10);
// [query type, query, limit ms]
const LIMITS: [string, string, number][] = [
  ['Observation', `code=${CODES[0]}&_sort=-date&_count=100`, 10],
  ['Observation', `category=laboratory&date=ge${fiveYearsAgo}&_count=1000`, 30],
  ['Observation', 'subject=Patient/PID&_count=20', 10],
  ['Patient', `_has:Observation:subject:code=${CODES[0]}`, 10],
  ['Observation', 'subject:Patient.birthdate=1980-02-03&_count=20', 20],
  // System searches (the type is the _type list): the union of the types, sorted whole per page (search.ts shortcut).
  ['Observation,Condition', '_type=Observation,Condition&_count=20', 10],
  ['Observation,Condition', '_type=Observation,Condition&_sort=-_lastUpdated&_count=20', 20],
];

test.each(LIMITS)('%s?%s stays under its limit', (type, q, limit) => {
  const query = [...new URLSearchParams(q.replace('PID', pid))] as [string, string][];
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    store.search(type.includes(',') ? type.split(',') : type, query, BASE);
    times.push(performance.now() - t);
  }
  const median = times.sort((a, b) => a - b)[2];
  expect(median).toBeLessThan(limit);
});

test('resident memory stays under 440 MB', () => {
  const mb = process.memoryUsage().rss / 1024 ** 2;
  expect(mb).toBeLessThan(440);
  const grew = mb - rssBefore / 1024 ** 2;
  expect(grew).toBeLessThan(GROWTH_MB);
});
