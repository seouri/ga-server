import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Attachment, Communication, DocumentReference, Resource } from '@medplum/fhirtypes';
import { together } from '../apple/batches.ts';
import { ehiDate } from './dates.ts';
import { type EhiCtx, ehiId, epicId, encounterRef, localId, PATIENT_REF } from './ids.ts';
import type { EhiTables, Ranges, Row } from './read.ts';
import { rtfToText } from './rtf.ts';

const byLine = (a: Row, b: Row) => Number(a.LINE) - Number(b.LINE);
const instant = (s: string | undefined) => (s && s.length > 10 ? s : undefined); // DocumentReference.date needs a time
const textAttachment = (text: string, title: string): Attachment => ({
  contentType: 'text/plain; charset=utf-8',
  data: Buffer.from(text, 'utf8').toString('base64'),
  title,
});

// A record's text lines (MESSAGE_ID or NOTE_ID -> rows), read back one record at a time.
const lines = (t: EhiTables, ix: Map<string, Ranges>, table: string, id: string, col: string): string[] =>
  t.read(table, ix.get(id) ?? []).sort(byLine).map((r) => r[col] ?? '');

// MyChart messages. Text: the message's RTF (MYC_MESG_RTF_TEXT, split at fixed widths, so joined without separator),
// else MSG_TXT lines. Care-team names are stored as given (display only). Sorted by time, so a thread reads in order; yields a
// thread at a time (a reply points at its parent).
export function* mapMessages(t: EhiTables, ctx: EhiCtx): Generator<Resource[]> {
  const enc = encounterRef(t);
  const rtf = t.index('MYC_MESG_RTF_TEXT', (r) => r.MESSAGE_ID);
  const txt = t.index('MSG_TXT', (r) => r.MESSAGE_ID);
  const msgs: { id: string; parent: string; sent?: string; n: string }[] = [];
  const at = t.index('MYC_MESG', (r) => {
    msgs.push({ id: r.MESSAGE_ID, parent: r.PARENT_MESSAGE_ID, sent: ehiDate(r.CREATED_TIME, ctx), n: String(msgs.length) });
    return String(msgs.length - 1);
  });
  const ids = new Set(msgs.map((m) => m.id));
  msgs.sort((a, b) => Date.parse(a.sent ?? '') - Date.parse(b.sent ?? ''));
  const message = (m: (typeof msgs)[number]): Communication => {
    const [r] = t.read('MYC_MESG', at.get(m.n) ?? []);
    const id = r.MESSAGE_ID;
    // An RTF with no text (e.g. only tables of formatting) falls back to MSG_TXT.
    const text = (rtf.has(id) && rtfToText(lines(t, rtf, 'MYC_MESG_RTF_TEXT', id, 'RTF_TXT').join(''))) || lines(t, txt, 'MSG_TXT', id, 'MSG_TXT').join('\n').trim();
    const sent = m.sent;
    const encounter = enc(r.PAT_ENC_CSN_ID);
    const toPatient = /to patient/i.test(r.TOFROM_PAT_C_NAME);
    const fromPatient = /from patient/i.test(r.TOFROM_PAT_C_NAME);
    const staff = (toPatient ? r.FROM_USER_ID_NAME : r.TO_USER_ID_NAME) || r.PROV_ID_PROV_NAME;
    const other = staff ? { display: staff } : undefined;
    const sender = fromPatient ? PATIENT_REF : toPatient ? other : undefined;
    const recipient = toPatient ? PATIENT_REF : fromPatient ? other : undefined;
    return {
      resourceType: 'Communication',
      id: localId('MYC_MESG', id),
      identifier: [ehiId(ctx, 'MYC_MESG', id)],
      ...(r.PARENT_MESSAGE_ID && ids.has(r.PARENT_MESSAGE_ID) && { inResponseTo: [{ reference: `Communication/${localId('MYC_MESG', r.PARENT_MESSAGE_ID)}` }] }),
      status: 'completed',
      subject: PATIENT_REF,
      ...(encounter && { encounter }),
      ...(r.SUBJECT && { topic: { text: r.SUBJECT } }),
      ...(sent && { sent }),
      ...(sender && { sender }),
      ...(recipient && { recipient: [recipient] }),
      ...(text && { payload: [{ contentString: text }] }),
    } as Communication;
  };
  for (const thread of together(msgs, (m) => [m.id, ...(m.parent && ids.has(m.parent) ? [m.parent] : [])])) yield thread.map(message);
}

// Rich Text files by NOTE_ID (`HNO_<NOTE_ID>_<seg>_41.RTF`), each note's in segment order: numeric (`NNNNN` or `NNNNN.NN`), not
// string order.
export function noteFiles(dir: string): Map<string, string[]> {
  const rtfDir = join(dir, 'Rich Text');
  const out = new Map<string, string[]>();
  for (const f of existsSync(rtfDir) ? readdirSync(rtfDir).filter((f) => /^HNO_\d+_.*\.rtf$/i.test(f)).sort() : []) {
    const id = f.split('_')[1];
    out.set(id, [...(out.get(id) ?? []), f]);
  }
  for (const fs of out.values()) fs.sort((a, b) => Number(a.split('_')[2]) - Number(b.split('_')[2]));
  return new Map([...out].map(([id, fs]) => [id, fs.map((f) => join(rtfDir, f))]));
}

// R5: a note's RTF is found by NOTE_ID in its file name; its text becomes a text/plain attachment (the importer stores the RTF
// itself and links it). Without RTF, HNO_PLAIN_TEXT; without either, metadata only, with a placeholder attachment (R4 content is
// 1..*). Yields each note with its RTF files.
export function* mapNotes(t: EhiTables, ctx: EhiCtx, dir: string, files = noteFiles(dir)): Generator<{ doc: DocumentReference; rtf: string[] }> {
  const enc = encounterRef(t);
  const plain = t.index('HNO_PLAIN_TEXT', (r) => r.NOTE_ID);
  for (const r of t.rows('HNO_INFO')) {
    const id = localId('HNO_INFO', r.NOTE_ID);
    const mine = files.get(r.NOTE_ID) ?? [];
    const texts = mine.length
      ? mine.map((f) => textAttachment(rtfToText(readFileSync(f, 'latin1')), `${basename(f)} (text)`))
      : plain.has(r.NOTE_ID)
        ? [textAttachment(lines(t, plain, 'HNO_PLAIN_TEXT', r.NOTE_ID, 'NOTE_TEXT').join('\n').trim(), 'Note text')]
        : [];
    const type = r.IP_NOTE_TYPE_C_NAME || r.NOTE_TYPE_NOADD_C_NAME;
    const author = r.CURRENT_AUTHOR_ID_NAME || r.ENTRY_USER_ID_NAME;
    const date = instant(ehiDate(r.CREATE_INSTANT_DTTM, ctx)) ?? instant(ehiDate(r.UPDATE_DATE, ctx));
    const encounter = enc(r.PAT_ENC_CSN_ID);
    const start = ehiDate(r.DATE_OF_SERVIC_DTTM, ctx);
    const context = { ...(encounter && { encounter: [encounter] }), ...(start && { period: { start } }) };
    const doc = {
      resourceType: 'DocumentReference',
      id,
      identifier: [ehiId(ctx, 'HNO_INFO', r.NOTE_ID), ...epicId(ctx, 'note', r.NOTE_ID)],
      status: r.DELETE_INSTANT_DTTM ? 'entered-in-error' : 'current',
      ...(type && { type: { text: type } }),
      ...(r.NOTE_DESC && { description: r.NOTE_DESC }),
      subject: PATIENT_REF,
      ...(date && { date }),
      ...(author && { author: [{ display: author }] }),
      content: (texts.length ? texts : [{ title: 'No text in export' }]).map((attachment) => ({ attachment })),
      ...(Object.keys(context).length && { context }),
    } as DocumentReference;
    yield { doc, rtf: mine };
  }
}

export const MEDIA_TYPE: Record<string, string> = { '.pdf': 'application/pdf', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.html': 'text/html', '.htm': 'text/html' };
