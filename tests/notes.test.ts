import { expect, test } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { noteText, notesSearch, snippet } from '../src/notes.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const doc = (id: string, body: string, extra: object = {}) =>
  ({ resourceType: 'DocumentReference', id, status: 'current', date: '2025-02-01', type: { text: 'Progress note' }, author: [{ display: 'Dr. A' }], content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: b64(body) } }], ...extra }) as never;

test('noteText: inline text/plain only; archives, source files and RTF skipped', () => {
  expect(noteText(doc('a', 'hello'))).toBe('hello');
  expect(noteText(doc('b', 'x', { identifier: [{ system: 'urn:ga-server:id:file', value: 'h' }] }))).toBeUndefined();
  expect(noteText(doc('c', 'x', { content: [{ attachment: { contentType: 'text/rtf', data: b64('{\\rtf') } }] }))).toBeUndefined();
  expect(noteText(doc('e', 'ecg csv', { identifier: [{ system: 'urn:ga-server:id:apple-health', value: 'h' }] }))).toBeUndefined();
  expect(noteText(doc('d', 'x', { content: [{ attachment: { contentType: 'text/plain', url: 'Binary/1' } }] }))).toBeUndefined();
});

test('snippet: around the first match, collapsed, ellipses', () => {
  const t = `${'a '.repeat(200)}Knee   PAIN here ${'b '.repeat(200)}`;
  const s = snippet(t, 'knee pain');
  expect(s.startsWith('…')).toBe(true);
  expect(s.endsWith('…')).toBe(true);
  expect(s).toContain('Knee PAIN here');
  expect(snippet('short note')).toBe('short note');
  expect(snippet('say knee\n  pain now', 'knee pain')).toBe('say knee pain now');
});

test('notesSearch: notes and messages merged newest first, case-insensitive, date params', async () => {
  const seen: [string, URLSearchParams][] = [];
  const by: Record<string, Resource[]> = {
    DocumentReference: [doc('n1', 'Patient reports knee pain.'), doc('n2', 'Nothing relevant.')],
    Communication: [{ resourceType: 'Communication', id: 'm1', status: 'completed', sent: '2025-03-01T10:00:00Z', sender: { display: 'Nurse B' }, payload: [{ contentString: 'Your KNEE x-ray is normal' }] } as Resource],
  };
  const client = { search: async (t: string, q: URLSearchParams) => (seen.push([t, q]), { resourceType: 'Bundle', entry: by[t].map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  const r = await notesSearch(client, 'p', { text: 'Knee', since: '2025-01-01' });
  expect(r.rows).toEqual([
    { date: '2025-03-01', kind: 'message', author: 'Nurse B', snippet: 'Your KNEE x-ray is normal', type: 'Communication', id: 'm1' },
    { date: '2025-02-01', kind: 'Progress note', author: 'Dr. A', snippet: 'Patient reports knee pain.', type: 'DocumentReference', id: 'n1' },
  ]);
  expect(seen.map(([t, q]) => [t, q.getAll(t === 'Communication' ? 'sent' : 'date')])).toEqual([['DocumentReference', ['ge2025-01-01']], ['Communication', ['ge2025-01-01']]]);
  expect((await notesSearch(client, 'p', { limit: 1 })).truncated).toBe(true);
  expect((await notesSearch(client, 'p', { text: 'reports  knee' })).rows.map((r) => r.id)).toEqual(['n1']); // whitespace-insensitive
});
