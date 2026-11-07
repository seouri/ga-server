// notes_search: text search inside clinical notes (inline text/plain DocumentReferences) and MyChart messages (Communication).
import type { MedplumClient } from '@medplum/core';
import type { Communication, DocumentReference } from '@medplum/fhirtypes';
import { APPLE } from './identity.ts';
import { collect, dateRange, fit } from './labs.ts';
import { NEVER_DOCS } from './share/scope.ts';
const SCAN = 5000; // records read per type per call: a text match reads every record in the range
const SNIP = 300;

export type NoteRow = { date?: string; kind: string; author?: string; snippet: string; type: 'DocumentReference' | 'Communication'; id?: string };

// A note is an inline text/plain attachment; that also skips RTF originals (linked by relatesTo), PDFs and Binary-backed files.
// Archives, imported source files and Apple's ECG CSVs (the only Apple DocumentReferences) are not notes.
export function noteText(d: DocumentReference): string | undefined {
  if (d.identifier?.some((i) => NEVER_DOCS.has(i.system ?? '') || i.system === APPLE)) return undefined;
  const a = d.content?.find((c) => c.attachment?.data && /^text\/plain\b/i.test(c.attachment.contentType ?? ''))?.attachment;
  return a?.data ? Buffer.from(a.data, 'base64').toString('utf8') : undefined;
}

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

export async function notesSearch(
  client: MedplumClient,
  patientId: string,
  { text, since, until, limit = 50 }: { text?: string; since?: string; until?: string; limit?: number },
): Promise<{ rows: NoteRow[]; total: number; truncated?: true; hint?: string }> {
  const q = (sort: string) => new URLSearchParams([['subject', `Patient/${patientId}`], ['_sort', `-${sort},_id`], ['_count', '100']]);
  const dq = q('date'), mq = q('sent');
  dateRange(dq, 'date', since, until);
  dateRange(mq, 'sent', since, until);
  const hit = (body: string | undefined) => body !== undefined && (!text || find(norm(body), text) >= 0);
  const row = (body: string, r: Omit<NoteRow, 'snippet'>): NoteRow => ({ ...r, snippet: snippet(body, text) });
  const [docs, msgs] = await Promise.all([
    collect(client, 'DocumentReference', dq, (d: DocumentReference) => {
      const body = noteText(d);
      if (!hit(body)) return undefined;
      const kind = d.type?.text ?? d.type?.coding?.find((c) => c.display)?.display ?? 'note';
      return row(body as string, { date: (d.date ?? d.context?.period?.start)?.slice(0, 10), kind, author: d.author?.[0]?.display, type: 'DocumentReference', id: d.id });
    }, limit, SCAN),
    collect(client, 'Communication', mq, (c: Communication) => {
      const body = c.payload?.map((p) => p.contentString).filter(Boolean).join('\n');
      if (!body || !hit(body)) return undefined;
      return row(body, { date: (c.sent ?? c.received)?.slice(0, 10), kind: 'message', author: c.sender?.display, type: 'Communication', id: c.id });
    }, limit, SCAN),
  ]);
  const rows = [...docs.rows, ...msgs.rows].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const out = fit(rows, limit, docs.more || msgs.more);
  return out.truncated ? { ...out, hint: 'more may match: narrow since/until or the text' } : out;
}
