// notes_search: text search inside clinical notes (inline text/plain DocumentReferences), MyChart messages (Communication) and
// report text: a DiagnosticReport's conclusion and text attachment, and the long text results hospitals file a report's body under
// (Epic pathology: clinical history, final diagnosis, gross description, each an Observation with a text value), and a study's
// findings (Epic echo: Observations of category study-finding that share the report's order and list their content by name).
import type { MedplumClient } from '@medplum/core';
import type { Communication, DiagnosticReport, DocumentReference, Observation } from '@medplum/fhirtypes';
import { APPLE, TAG } from './identity.ts';
import { collect, dateRange, fit } from './labs.ts';
import { NEVER_DOCS } from './share/scope.ts';
const SCAN = 5000; // records read per type per call: a text match reads every record in the range
const SNIP = 300;

type Searched = 'DocumentReference' | 'Communication' | 'DiagnosticReport' | 'Observation';
type NoteRow = { date?: string; kind: string; author?: string; snippet: string; type: Searched; id?: string };
const RESULT_TEXT = 80; // a text result this long is prose (a diagnosis, a description), not a value like "Negative"

// A note is an inline text/plain attachment; that also skips RTF originals (linked by relatesTo), PDFs and Binary-backed files.
// Archives, imported source files and Apple's ECG CSVs are not notes. An ECG CSV carries only the Apple identifier; a hospital
// note that is also in the phone's Health Records carries it next to its hospital identifier and is a note.
export function noteText(d: DocumentReference): string | undefined {
  const systems = (d.identifier ?? []).map((i) => i.system ?? '');
  if (systems.some((s) => NEVER_DOCS.has(s)) || (systems.includes(APPLE) && !systems.some((s) => s.startsWith('urn:ga-server:id:smart:')))) return undefined;
  const a = d.content?.find((c) => c.attachment?.data && /^text\/plain\b/i.test(c.attachment.contentType ?? ''))?.attachment;
  return a?.data ? Buffer.from(a.data, 'base64').toString('utf8') : undefined;
}

// A report's own text: its conclusion (written, or as named diagnoses) and its inline text attachment. A report whose text is
// only an address at the hospital has none.
export function reportText(d: DiagnosticReport): string | undefined {
  const forms = (d.presentedForm ?? []).filter((f) => f.data && /^text\/plain\b/i.test(f.contentType ?? '')).map((f) => Buffer.from(f.data!, 'base64').toString('utf8'));
  const coded = (d.conclusionCode ?? []).map((c) => c.text ?? c.coding?.find((x) => x.display)?.display);
  return [d.conclusion, ...coded, ...forms].filter(Boolean).join('\n') || undefined;
}
// A study finding as a line of text: its name and the findings it lists, without Epic's "FINDINGS - TESTS - IMAGING -" path.
export function findingText(o: Observation): string | undefined {
  const items = (o.hasMember ?? []).map((m) => m.display?.replace(/^FINDINGS( - (TESTS|IMAGING|PHYSICAL EXAM|PE))*\s*-\s*/i, '').toLowerCase()).filter(Boolean);
  const name = o.code?.text ?? o.code?.coding?.find((c) => c.display)?.display;
  return items.length ? `${name ?? 'Finding'}: ${[...new Set(items)].join('; ')}.` : undefined; // a finding that lists nothing says nothing
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

type Body = Omit<NoteRow, 'snippet'> & { body: string; order?: string }; // order: what joins a study's findings to its report
type Cached = { stamp: string; rows: Body[]; more: boolean };
// Decoded rows per client and patient, in memory only. A type reloads when its (total, newest lastUpdated) stamp changes.
const cache = new WeakMap<MedplumClient, Map<string, Cached>>();

async function load<T extends DocumentReference | Communication | DiagnosticReport | Observation>(
  client: MedplumClient, patientId: string, type: Searched, sort: string, row: (r: T) => Body | undefined, only: [string, string][] = [],
): Promise<Cached> {
  const subject = `Patient/${patientId}`;
  const b = await client.search(type as 'Communication', new URLSearchParams([['subject', subject], ...only, ['_sort', '-_lastUpdated'], ['_count', '1'], ['_elements', 'id,meta'], ['_total', 'accurate']]), { cache: 'no-cache' });
  // No total: cannot tell a delete, so always reload.
  const stamp = b.total === undefined ? undefined : `${b.total}|${b.entry?.[0]?.resource?.meta?.lastUpdated}`;
  const mine = cache.get(client) ?? cache.set(client, new Map()).get(client)!;
  const key = `${patientId}|${type}|${only.join('&')}`; // two readings of one type (text results, study findings) are cached apart
  const hit = mine.get(key);
  if (stamp && hit?.stamp === stamp) return hit;
  const q = new URLSearchParams([['subject', subject], ...only, ['_sort', `-${sort},_id`], ['_count', '100']]);
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
  const named = (c?: { text?: string; coding?: { display?: string }[] }) => c?.text ?? c?.coding?.find((x) => x.display)?.display;
  const [docs, msgs, reports, results, findings] = await Promise.all([
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
    load(client, patientId, 'DiagnosticReport', 'date', (d: DiagnosticReport) => {
      const body = reportText(d) ?? '', order = d.basedOn?.find((b) => b.reference)?.reference;
      if (!body && !order) return undefined; // with an order, its findings may be its only text
      return { body, order, date: (d.effectiveDateTime ?? d.effectivePeriod?.start ?? d.issued)?.slice(0, 10), kind: `report: ${named(d.code) ?? 'report'}`, author: (d.resultsInterpreter ?? d.performer)?.[0]?.display, type: 'DiagnosticReport', id: d.id };
    }),
    // Text results only (the server leaves out those with no text value), never Apple Health's.
    load(client, patientId, 'Observation', 'date', (o: Observation) => {
      const body = o.valueString;
      if (!body || body.length < RESULT_TEXT) return undefined;
      return { body, date: (o.effectiveDateTime ?? o.effectivePeriod?.start ?? o.issued)?.slice(0, 10), kind: `report text: ${named(o.code) ?? 'result'}${o.basedOn?.[0]?.display ? ` (${o.basedOn[0].display})` : ''}`, author: o.performer?.[0]?.display, type: 'Observation', id: o.id };
    }, [['value-string:missing', 'false'], ['_tag:not', `${TAG}|src-apple-health`]]),
    load(client, patientId, 'Observation', 'date', (o: Observation) => {
      const body = findingText(o);
      if (!body) return undefined;
      return { body, order: o.basedOn?.find((b) => b.reference)?.reference, date: (o.effectiveDateTime ?? o.issued)?.slice(0, 10), kind: `report text: findings${o.basedOn?.[0]?.display ? ` (${o.basedOn[0].display})` : ''}`, type: 'Observation', id: o.id };
    }, [['category', 'study-finding']]),
  ]);
  // A study's findings read as part of its report: one row, opened by the report's id. Findings with no report stay their own rows.
  const byOrder = new Map<string, Body>(reports.rows.flatMap((r): [string, Body][] => (r.order ? [[r.order, { ...r }]] : [])));
  const loose: Body[] = [];
  for (const f of findings.rows) { const r = f.order ? byOrder.get(f.order) : undefined; if (r) r.body = `${r.body}${r.body ? '\n' : ''}${f.body}`; else loose.push(f); }
  const reportRows = [...reports.rows.filter((r) => !r.order), ...byOrder.values()].filter((r) => r.body);
  const inRange = (d?: string) => (!since && !until) || (d !== undefined && (!since || d >= since) && (!until || d <= until));
  // The same text stored twice (Epic re-issues a note's id; two exports then hold it twice) is one row.
  const once = new Set<string>();
  const rows = [...docs.rows, ...msgs.rows, ...reportRows, ...results.rows, ...loose]
    .filter((r) => { const k = `${r.date}|${r.kind}|${norm(r.body)}`; return once.has(k) ? false : !!once.add(k); })
    .filter((r) => inRange(r.date) && (!text || find(norm(r.body), text) >= 0))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .map(({ body, order: _order, ...r }) => ({ ...r, snippet: snippet(body, text) }));
  const out = fit(rows, limit, docs.more || msgs.more || reports.more || results.more || findings.more);
  return out.truncated ? { ...out, hint: 'more may match: narrow since/until or the text' } : out;
}
