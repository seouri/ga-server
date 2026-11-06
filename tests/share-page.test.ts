import { expect, test } from 'vitest';
import { renderInactive, renderPage, renderQr } from '../src/share/page.ts';
import type { Share } from '../src/share/store.ts';
import type { Item, Row, Summary } from '../src/share/summary.ts';

const share = (layout: 'A' | 'B'): Share => ({ id: 's1', label: 'Dr "X"', audience: 'doctor', groups: ['labs'], since: '2020-01-01', layout, questionsPerDay: 20, tokenHash: 'h', patientId: 'p', baseUrl: 'http://x', created: '2026-01-01T00:00:00Z' });
const lab = (label: string): Item => ({ label, value: '1 mg', date: '2026-01-01', ref: 'Observation/1', note: 'possible duplicate' });
const sum = (labs: Item[]): Summary => ({ patient: { name: 'Pat Test' }, problems: [], medications: [], allergies: [], labs, vitals: [], immunizations: [], apple: [] });
const o = { base: '/s/tok', askEnabled: true };

const X = '"><img onerror=x>';

test('escapes record text', () => {
  const h = renderPage(share('A'), sum([lab('<script>alert(1)</script>' + X)]), [], o);
  expect(h).not.toContain('<script>alert');
  expect(h).not.toContain('<img onerror');
  expect(h).toContain('&lt;script&gt;');
  expect(h).toContain('possible duplicate');
});

test('escapes every interpolated field', async () => {
  const sh = { ...share('B'), label: 'L' + X };
  const rows: Row[] = [{ group: 'notes', items: [{ label: 'n', ref: 'DocumentReference/d' + X, note: 'N' + X }] }];
  const h = renderPage(sh, sum([]), rows, { ...o, tab: 'records', answer: { q: 'Q' + X, a: 'A' + X + '<br>\nline2' }, notice: 'T' + X });
  const ask = renderPage(sh, sum([]), rows, { ...o, tab: 'ask', answer: { q: 'Q' + X, a: 'A' + X + '<br>\nline2' }, notice: 'T' + X });
  for (const out of [h, ask, await renderQr('http://x/' + X)]) {
    expect(out).not.toContain('<img onerror');
    expect(out).not.toContain('"><img');
  }
  expect(h).toContain('L&quot;&gt;&lt;img');
  expect(h).toContain('%22%3E%3Cimg');
  expect(ask).toContain('A&quot;&gt;&lt;img onerror=x&gt;&lt;br&gt;<br>line2');
});

test('layout A: downloads before summary', () => {
  const h = renderPage(share('A'), sum([]), [], o);
  expect(h.indexOf('summary.pdf')).toBeLessThan(h.indexOf('<h2>Summary'));
  expect(h).toContain('Answers come only from the shared records');
});

test('layout B: absolute tab links and paging', () => {
  const items = Array.from({ length: 450 }, (_, i): Item => ({ label: `rec${String(i).padStart(3, '0')}`, date: '2026-01-01', ref: `Observation/${i}` }));
  const rows: Row[] = [{ group: 'labs', items }];
  const h = renderPage(share('B'), sum([]), rows, { ...o, tab: 'records', page: 2 });
  expect(h).toContain('href="/s/tok?tab=ask"');
  expect(h).toContain('href="/s/tok?tab=download"');
  for (const x of ['rec200', 'rec399']) expect(h).toContain(x);
  for (const x of ['rec199', 'rec400']) expect(h).not.toContain(x);
  expect(h).toContain('/s/tok?tab=records&amp;page=3');
  expect(renderPage(share('B'), sum([]), rows, { ...o, tab: 'records', page: 99 })).toContain('rec400');
  expect(renderPage(share('B'), sum([]), rows, { ...o, tab: 'records', page: NaN })).toContain('rec000');
});

test('expiry shown in local time, never when absent', () => {
  expect(renderPage({ ...share('A'), expires: '2026-11-13' }, sum([]), [], o)).toContain('expires 2026-11-13');
  expect(renderPage(share('A'), sum([]), [], o)).toContain('no expiry');
});

test('ask disabled, inactive, qr', async () => {
  expect(renderPage(share('A'), sum([]), [], { ...o, askEnabled: false })).toContain('Questions are not set up');
  const i = renderInactive();
  expect(i).toContain('This link is no longer active');
  expect(i).not.toContain('Pat');
  expect(await renderQr('http://x/s/tok')).toContain('<svg');
});
