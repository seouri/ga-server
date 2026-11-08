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
  const by: Record<string, Resource[]> = {
    DocumentReference: [doc('n1', 'Patient reports knee pain.'), doc('n2', 'Nothing relevant.')],
    Communication: [{ resourceType: 'Communication', id: 'm1', status: 'completed', sent: '2025-03-01T10:00:00Z', sender: { display: 'Nurse B' }, payload: [{ contentString: 'Your KNEE x-ray is normal' }] } as Resource],
  };
  const client = { search: async (t: string, q: URLSearchParams) => ({ resourceType: 'Bundle', entry: by[t].map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  const r = await notesSearch(client, 'p', { text: 'Knee', since: '2025-01-01' });
  expect(r.rows).toEqual([
    { date: '2025-03-01', kind: 'message', author: 'Nurse B', snippet: 'Your KNEE x-ray is normal', type: 'Communication', id: 'm1' },
    { date: '2025-02-01', kind: 'Progress note', author: 'Dr. A', snippet: 'Patient reports knee pain.', type: 'DocumentReference', id: 'n1' },
  ]);
  expect((await notesSearch(client, 'p', { limit: 1 })).truncated).toBe(true);
  expect((await notesSearch(client, 'p', { text: 'reports  knee' })).rows.map((r) => r.id)).toEqual(['n1']); // whitespace-insensitive
});

// Fake server: stamp requests (_count=1) answer total + newest lastUpdated; full reads return everything.
function fake(by: Record<string, any[]>) {
  const calls: string[] = [];
  const client = { search: async (t: string, q: URLSearchParams) => {
    const stamp = q.get('_count') === '1';
    calls.push(`${t}${stamp ? ':stamp' : ':full'}`);
    const all = by[t];
    const newest = [...all].sort((a, b) => b.meta.lastUpdated.localeCompare(a.meta.lastUpdated))[0];
    return { resourceType: 'Bundle', total: all.length, entry: (stamp ? [newest] : all).map((resource) => ({ resource })) };
  } } as unknown as MedplumClient;
  return { client, calls };
}
const lu = (r: any, lastUpdated = '2025-01-01T00:00:00Z') => ({ ...r, meta: { lastUpdated } });

test('notesSearch cache: unchanged stamp makes only the two stamp requests; a change reloads', async () => {
  const by = { DocumentReference: [lu(doc('n1', 'colonoscopy done'))], Communication: [] as any[] };
  const { client, calls } = fake(by);
  const pid = 'cache1';
  expect((await notesSearch(client, pid, { text: 'colonoscopy' })).rows.map((r) => r.id)).toEqual(['n1']);
  calls.length = 0;
  expect((await notesSearch(client, pid, { text: 'colonoscopy' })).rows.map((r) => r.id)).toEqual(['n1']);
  expect(calls.sort()).toEqual(['Communication:stamp', 'DocumentReference:stamp']);
  by.DocumentReference.push(lu(doc('n2', 'second colonoscopy note'), '2025-06-01T00:00:00Z')); // total and lastUpdated change
  calls.length = 0;
  expect((await notesSearch(client, pid, { text: 'colonoscopy' })).rows.map((r) => r.id).sort()).toEqual(['n1', 'n2']);
  expect(calls).toContain('DocumentReference:full');
  expect(calls).not.toContain('Communication:full');
  by.DocumentReference[0] = lu(doc('n1', 'edited text'), '2025-07-01T00:00:00Z'); // same total, newer lastUpdated
  expect((await notesSearch(client, pid, { text: 'edited' })).rows.map((r) => r.id)).toEqual(['n1']);
});

test('notesSearch cache: since/until inclusive on the row date; excluded docs never appear', async () => {
  const msg = (id: string, sent: string) => lu({ resourceType: 'Communication', id, status: 'completed', sent, payload: [{ contentString: 'visit' }] });
  const by = {
    DocumentReference: [
      lu(doc('a', 'visit', { date: '2025-01-01' })), lu(doc('b', 'visit', { date: '2025-01-31' })), lu(doc('c', 'visit', { date: '2025-02-01' })),
      lu(doc('nv', 'visit', { identifier: [{ system: 'urn:ga-server:id:file', value: 'h' }] })),
      lu(doc('ap', 'visit', { identifier: [{ system: 'urn:ga-server:id:apple-health', value: 'h' }] })),
      lu(doc('rtf', 'x', { content: [{ attachment: { contentType: 'text/rtf', data: b64('visit') } }] })),
    ],
    Communication: [msg('m1', '2025-01-31T23:59:00Z'), msg('m2', '2025-02-01T00:00:00Z')],
  };
  const { client } = fake(by);
  const ids = async (o: object) => (await notesSearch(client, 'cache2', { text: 'visit', ...o })).rows.map((r) => r.id).sort();
  expect(await ids({ since: '2025-01-01', until: '2025-01-31' })).toEqual(['a', 'b', 'm1']);
  expect(await ids({})).toEqual(['a', 'b', 'c', 'm1', 'm2']);
  await expect(ids({ since: 'nope' })).rejects.toThrow();
});
