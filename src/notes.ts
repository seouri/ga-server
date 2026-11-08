// notes_search: text search inside clinical notes (inline text/plain DocumentReferences) and MyChart messages (Communication).
import type { MedplumClient } from '@medplum/core';
import type { Communication, DocumentReference } from '@medplum/fhirtypes';
import { APPLE } from './identity.ts';
import { collect, dateRange, fit } from './labs.ts';
import { NEVER_DOCS } from './share/scope.ts';
const SCAN = 5000; // records read per type per call: a text match reads every record in the range
const SNIP = 300;

type NoteRow = { date?: string; kind: string; author?: string; snippet: string; type: 'DocumentReference' | 'Communication'; id?: string };

// A note is an inline text/plain attachment; that also skips RTF originals (linked by relatesTo), PDFs and Binary-backed files.
// Archives, imported source files and Apple's ECG CSVs (the only Apple DocumentReferences) are not notes.
export function noteText(d: DocumentReference): string | undefined {
  if (d.identifier?.some((i) => NEVER_DOCS.has(i.system ?? '') || i.system === APPLE)) return undefined;
  const a = d.content?.find((c) => c.attachment?.data && /^text\/plain\b/i.test(c.attachment.contentType ?? ''))?.attachment;
  return a?.data ? Buffer.from(a.data, 'base64').toString('utf8') : undefined;
}

export const messageText = (c: Communication): string | undefined => c.payload?.map((p) => p.contentString).filter(Boolean).join('\n') || undefined;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
// Position of needle in the whitespace-collapsed text, case-insensitive (-1: none).
const find = (t: string, needle: string) => t.toLowerCase().indexOf(norm(needle).toLowerCase());

// ~300 characters around the first match (or from the start), whitespace collapsed.
export function snippet(text: string, needle?: string): string {
  const t = norm(text);
  const at = needle ? find(t, needle) : 0;
  const start = Math.max(0, at - 100);
  return `${start ? '…' : ''}${t.slice(start, start + SNIP)}${start + SNIP < t.length ? '…' : ''}`;
}

type Body = Omit<NoteRow, 'snippet'> & { body: string };
type Cached = { stamp: string; rows: Body[]; more: boolean };
// Decoded rows per client and patient, in memory only. A type reloads when its (total, newest lastUpdated) stamp changes.
const cache = new WeakMap<MedplumClient, Map<string, Cached>>();

async function load<T extends DocumentReference | Communication>(
  client: MedplumClient, patientId: string, type: 'DocumentReference' | 'Communication', sort: string, row: (r: T) => Body | undefined,
): Promise<Cached> {
  const subject = `Patient/${patientId}`;
  const b = await client.search(type as 'Communication', new URLSearchParams([['subject', subject], ['_sort', '-_lastUpdated'], ['_count', '1'], ['_elements', 'id,meta'], ['_total', 'accurate']]), { cache: 'no-cache' });
  // No total: cannot tell a delete, so always reload.
  const stamp = b.total === undefined ? undefined : `${b.total}|${b.entry?.[0]?.resource?.meta?.lastUpdated}`;
  const mine = cache.get(client) ?? cache.set(client, new Map()).get(client)!;
  const key = `${patientId}|${type}`;
  const hit = mine.get(key);
  if (stamp && hit?.stamp === stamp) return hit;
  const q = new URLSearchParams([['subject', subject], ['_sort', `-${sort},_id`], ['_count', '100']]);
  const { rows, more } = await collect(client, type, q, row, Infinity, SCAN);
  const fresh = { stamp: stamp ?? '', rows, more };
  if (stamp) mine.set(key, fresh);
  return fresh;
}

export async function notesSearch(
  client: MedplumClient,
  patientId: string,
  { text, since, until, limit = 50 }: { text?: string; since?: string; until?: string; limit?: number },
): Promise<{ rows: NoteRow[]; total: number; truncated?: true; hint?: string }> {
  dateRange(new URLSearchParams(), 'date', since, until); // validates since/until
  const [docs, msgs] = await Promise.all([
    load(client, patientId, 'DocumentReference', 'date', (d: DocumentReference) => {
      const body = noteText(d);
      if (body === undefined) return undefined;
      const kind = d.type?.text ?? d.type?.coding?.find((c) => c.display)?.display ?? 'note';
      return { body, date: (d.date ?? d.context?.period?.start)?.slice(0, 10), kind, author: d.author?.[0]?.display, type: 'DocumentReference', id: d.id };
    }),
    load(client, patientId, 'Communication', 'sent', (c: Communication) => {
      const body = messageText(c);
      if (!body) return undefined;
      return { body, date: (c.sent ?? c.received)?.slice(0, 10), kind: 'message', author: c.sender?.display, type: 'Communication', id: c.id };
    }),
  ]);
  const inRange = (d?: string) => (!since && !until) || (d !== undefined && (!since || d >= since) && (!until || d <= until));
  const rows = [...docs.rows, ...msgs.rows]
    .filter((r) => inRange(r.date) && (!text || find(norm(r.body), text) >= 0))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .map(({ body, ...r }) => ({ ...r, snippet: snippet(body, text) }));
  const out = fit(rows, limit, docs.more || msgs.more);
  return out.truncated ? { ...out, hint: 'more may match: narrow since/until or the text' } : out;
}
