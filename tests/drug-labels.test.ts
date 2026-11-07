import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { drugLabel } from '../src/drug-labels.ts';

const label = (set_id: string, effective_time: string, di: string[]) => ({ set_id, effective_time, drug_interactions: di, openfda: { generic_name: ['x'] } });
const mk = (handler: (u: string) => Response) => {
  const urls: string[] = [];
  const fetch = (async (u: string) => (urls.push(u), handler(u))) as unknown as typeof globalThis.fetch;
  return { urls, fetch, dir: mkdtempSync(join(tmpdir(), 'labels-')) };
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

test('finds the newest label with sections by product code', async () => {
  const t = mk(() => json({ results: [label('old', '20200101', ['a']), label('new', '20240101', ['b'.repeat(5000)])] }));
  const r = await drugLabel('617312', t);
  expect(r.status === 'ok' && r.setId).toBe('new');
  if (r.status !== 'ok') throw new Error();
  expect(r.sections.drug_interactions).toHaveLength(4000);
  expect(r.sections.drug_interactions!.endsWith('…')).toBe(true);
});

test('falls back through RxNav related products', async () => {
  const t = mk((u) => u.includes('rxnav') ? json({ relatedGroup: { conceptGroup: [{ conceptProperties: [{ rxcui: '111' }] }, { conceptProperties: [{ rxcui: '222' }] }] } })
    : u.includes('%22') || !u.includes('111') ? json({ error: { code: 'NOT_FOUND' } }, 404) : json({ results: [label('s', '20240101', ['i'])] }));
  const r = await drugLabel('617312', t);
  expect(r.status).toBe('ok');
  expect(t.urls.at(-1)).toContain('("111"+OR+"222")');
});

test('caches for 30 days', async () => {
  const t = mk(() => json({ results: [label('s', '20240101', ['i'])] }));
  const now = new Date('2026-01-01');
  await drugLabel('1', { ...t, now });
  await drugLabel('1', { ...t, now: new Date('2026-01-20') });
  expect(t.urls).toHaveLength(1);
  await drugLabel('1', { ...t, now: new Date('2026-02-01') });
  expect(t.urls).toHaveLength(2);
});

test('unavailable on network error or 429, no label on empty', async () => {
  const boom = mk(() => { throw new Error('net'); });
  expect((await drugLabel('1', boom)).status).toBe('unavailable');
  expect((await drugLabel('1', mk(() => json({}, 429)))).status).toBe('unavailable');
  const empty = mk((u) => u.includes('rxnav') ? json({ relatedGroup: {} }) : json({ error: {} }, 404));
  expect((await drugLabel('1', empty)).status).toBe('no label');
  expect((await drugLabel('1; drop', empty)).status).toBe('no code');
});

test('sends only the code', async () => {
  const t = mk((u) => u.includes('rxnav') ? json({ relatedGroup: { conceptGroup: [{ conceptProperties: [{ rxcui: '9' }] }] } }) : json({ error: {} }, 404));
  await drugLabel('617312', t);
  for (const u of t.urls) expect(u).toMatch(/rxcui[:/]"?\d+/);
  expect(t.urls.join()).not.toMatch(/617312.*(name|date|value)/i);
});

test('combination products are skipped: single-substance label preferred, RxNav combos dropped', async () => {
  const sub = (id: string, t: string, names: string[]) => ({ ...label(id, t, ['i']), openfda: { generic_name: ['x'], substance_name: names } });
  const a = mk(() => json({ results: [sub('combo', '20260101', ['A', 'B']), sub('single', '20240101', ['A'])] }));
  const r = await drugLabel('6809', a);
  expect(r.status === 'ok' && r.setId).toBe('single');
  const only = mk(() => json({ results: [sub('combo', '20260101', ['A', 'B'])] }));
  expect((await drugLabel('6809', only)).status).toBe('no label');
  const b = mk((u) => u.includes('rxnav') ? json({ relatedGroup: { conceptGroup: [{ conceptProperties: [{ rxcui: '111', name: 'a 5 MG Oral Tablet' }, { rxcui: '222', name: 'a / b Oral Tablet' }] }] } })
    : u.includes('rxcui:%22') || u.includes('"6809"') ? json({}, 404) : json({ results: [label('s', '20240101', ['i'])] }));
  expect((await drugLabel('6809', b)).status).toBe('ok');
  expect(b.urls.at(-1)).toContain('"111"');
  expect(b.urls.at(-1)).not.toContain('222');
});

test('a cache file from the old format is refetched', async () => {
  const t = mk(() => json({ results: [label('s', '20240101', ['i'])] }));
  writeFileSync(join(t.dir, '1.json'), JSON.stringify({ fetchedAt: Date.now(), result: { status: 'ok', setId: 'combo' } }));
  expect((await drugLabel('1', t) as { setId: string }).setId).toBe('s');
});

test('kit and combination labels without substance_name are skipped by generic name', async () => {
  const gen = (id: string, names: string[]) => ({ ...label(id, '20260101', ['i']), openfda: { generic_name: names } });
  for (const names of [['EPINEPHRINE, ALBUTEROL SULFATE, ASPIRIN'], ['EMPAGLIFLOZIN AND METFORMIN HYDROCHLORIDE'], ['A', 'B']]) {
    expect((await drugLabel('1191', mk(() => json({ results: [gen('kit', names)] })))).status).toBe('no label');
  }
  const r = await drugLabel('1191', mk(() => json({ results: [gen('kit', ['EPINEPHRINE, ASPIRIN']), gen('plain', ['ASPIRIN'])] })));
  expect(r.status === 'ok' && r.setId).toBe('plain');
});
