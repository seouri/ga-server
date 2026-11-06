import { expect, test } from 'vitest';
import { renderInactive, renderPage, renderQr } from '../src/share/page.ts';
import type { Share } from '../src/share/store.ts';
import type { Item, Row, Summary } from '../src/share/summary.ts';

const share = (layout: 'A' | 'B'): Share => ({ id: 's1', label: 'Dr "X"', audience: 'doctor', groups: ['labs'], since: '2020-01-01', layout, questionsPerDay: 20, tokenHash: 'h', patientId: 'p', baseUrl: 'http://x', created: '2026-01-01T00:00:00Z' });
const lab = (label: string): Item => ({ label, value: '1 mg', date: '2026-01-01', ref: 'Observation/1', note: 'possible duplicate' });
const sum = (labs: Item[]): Summary => ({ patient: { name: 'Pat Test' }, problems: [], medications: [], allergies: [], labs, vitals: [], immunizations: [], apple: [] });
const o = { base: '/s/tok', askEnabled: true };

test('escapes record text', () => {
  const h = renderPage(share('A'), sum([lab('<script>alert(1)</script>"><img onerror=x>')]), [], o);
  expect((!h.includes('<script>alert'))).toBeTruthy();
  expect((!h.includes('<img onerror'))).toBeTruthy();
  expect((h.includes('&lt;script&gt;'))).toBeTruthy();
  expect((h.includes('possible duplicate'))).toBeTruthy();
});

test('layout A: downloads before summary', () => {
  const h = renderPage(share('A'), sum([]), [], o);
  expect((h.indexOf('summary.pdf') < h.indexOf('<h2>Summary'))).toBeTruthy();
  expect((h.includes('Answers come only from the shared records'))).toBeTruthy();
});

test('layout B: tabs and paging', () => {
  const items = Array.from({ length: 450 }, (_, i): Item => ({ label: `rec${String(i).padStart(3, '0')}`, date: `2026-01-01`, ref: `Observation/${i}` }));
  const rows: Row[] = [{ group: 'labs', items }];
  const h = renderPage(share('B'), sum([]), rows, { ...o, tab: 'records', page: 2 });
  expect((h.includes('tab=ask') && h.includes('tab=download'))).toBeTruthy();
  expect((h.includes('rec200') && h.includes('rec399') && !h.includes('rec199') && !h.includes('rec400'))).toBeTruthy();
  expect((h.includes('page=3'))).toBeTruthy();
});

test('ask disabled, inactive, qr', async () => {
  expect((renderPage(share('A'), sum([]), [], { ...o, askEnabled: false }).includes('Questions are not set up'))).toBeTruthy();
  const i = renderInactive();
  expect((i.includes('This link is no longer active') && !i.includes('Pat'))).toBeTruthy();
  expect(((await renderQr('http://x/s/tok')).includes('<svg'))).toBeTruthy();
});
