import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Attachment, Communication, DocumentReference, Resource } from '@medplum/fhirtypes';
import { storeDocument } from '../document.ts';
import { importResources, type ImportReport } from '../engine.ts';
import { ehiDate } from './dates.ts';
import { mapEncounters } from './encounters.ts';
import { type EhiCtx, ehiId, encounterRef, localId, PATIENT_REF, resolveUnlinked } from './ids.ts';
import type { EhiTables, Row } from './read.ts';
import { rtfToText } from './rtf.ts';

const byLine = (a: Row, b: Row) => Number(a.LINE) - Number(b.LINE);
const instant = (s: string | undefined) => (s && s.length > 10 ? s : undefined); // DocumentReference.date needs a time
const textAttachment = (text: string, title: string): Attachment => ({
  contentType: 'text/plain; charset=utf-8',
  data: Buffer.from(text, 'utf8').toString('base64'),
  title,
});

function linesBy(t: EhiTables, table: string, key: string, col: string): Map<string, string[]> {
  const m = new Map<string, Row[]>();
  for (const r of t.rows(table)) m.set(r[key], [...(m.get(r[key]) ?? []), r]);
  return new Map([...m].map(([k, rows]) => [k, rows.sort(byLine).map((r) => r[col] ?? '')]));
}

// MyChart messages. Text: the message's RTF (MYC_MESG_RTF_TEXT, split at fixed widths, so joined without separator),
// else MSG_TXT lines. Care-team names are stored as given (display only). Sorted by time, so a thread reads in order.
export function mapMessages(t: EhiTables, ctx: EhiCtx): Resource[] {
  const enc = encounterRef(t);
  const rtf = linesBy(t, 'MYC_MESG_RTF_TEXT', 'MESSAGE_ID', 'RTF_TXT');
  const txt = linesBy(t, 'MSG_TXT', 'MESSAGE_ID', 'MSG_TXT');
  const msgs = t.rows('MYC_MESG');
  const ids = new Set(msgs.map((m) => m.MESSAGE_ID));
  return msgs
    .map((r): Communication => {
      const id = r.MESSAGE_ID;
      const text = rtf.has(id) ? rtfToText((rtf.get(id) ?? []).join('')) : (txt.get(id) ?? []).join('\n').trim();
      const sent = ehiDate(r.CREATED_TIME, ctx);
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
    })
    .sort((a, b) => Date.parse(a.sent ?? '') - Date.parse(b.sent ?? ''));
}

// R5: a note's RTF is found by NOTE_ID in its file name (`HNO_<NOTE_ID>_<seg>_41.RTF`); its text becomes a text/plain
// attachment (importDocuments adds the RTF itself as a Binary). Without RTF, HNO_PLAIN_TEXT; without either, metadata
// only, with a placeholder attachment (R4 content is 1..*).
export function mapNotes(t: EhiTables, ctx: EhiCtx, dir: string): { resources: Resource[]; rtf: Map<string, string[]> } {
  const enc = encounterRef(t);
  const rtfDir = join(dir, 'Rich Text');
  const files = existsSync(rtfDir) ? readdirSync(rtfDir).filter((f) => /^HNO_\d+_.*\.rtf$/i.test(f)).sort() : [];
  const plain = linesBy(t, 'HNO_PLAIN_TEXT', 'NOTE_ID', 'NOTE_TEXT');
  const rtf = new Map<string, string[]>();
  const resources = t.rows('HNO_INFO').map((r): DocumentReference => {
    const id = localId('HNO_INFO', r.NOTE_ID);
    const mine = files.filter((f) => f.split('_')[1] === r.NOTE_ID).map((f) => join(rtfDir, f));
    if (mine.length) rtf.set(id, mine);
    const texts = mine.length
      ? mine.map((f) => textAttachment(rtfToText(readFileSync(f, 'latin1')), `${basename(f)} (text)`))
      : plain.has(r.NOTE_ID)
        ? [textAttachment((plain.get(r.NOTE_ID) ?? []).join('\n').trim(), 'Note text')]
        : [];
    const type = r.IP_NOTE_TYPE_C_NAME || r.NOTE_TYPE_NOADD_C_NAME;
    const author = r.CURRENT_AUTHOR_ID_NAME || r.ENTRY_USER_ID_NAME;
    const date = instant(ehiDate(r.CREATE_INSTANT_DTTM, ctx)) ?? instant(ehiDate(r.UPDATE_DATE, ctx));
    const encounter = enc(r.PAT_ENC_CSN_ID);
    const start = ehiDate(r.DATE_OF_SERVIC_DTTM, ctx);
    const context = { ...(encounter && { encounter: [encounter] }), ...(start && { period: { start } }) };
    return {
      resourceType: 'DocumentReference',
      id,
      identifier: [ehiId(ctx, 'HNO_INFO', r.NOTE_ID)],
      status: r.DELETE_INSTANT_DTTM ? 'entered-in-error' : 'current',
      ...(type && { type: { text: type } }),
      ...(r.NOTE_DESC && { description: r.NOTE_DESC }),
      subject: PATIENT_REF,
      ...(date && { date }),
      ...(author && { author: [{ display: author }] }),
      content: (texts.length ? texts : [{ title: 'No text in export' }]).map((attachment) => ({ attachment })),
      ...(Object.keys(context).length && { context }),
    } as DocumentReference;
  });
  return { resources, rtf };
}

const MEDIA_TYPE: Record<string, string> = { '.pdf': 'application/pdf', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.html': 'text/html', '.htm': 'text/html' };
const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('base64');

// Notes and messages go through the engine (EHI identifiers: re-import is a no-op). A note's RTF is uploaded as a Binary
// only when the stored note (same EHI identifier, same patient) lacks an RTF attachment with the same hash, so a
// re-import leaves no orphan Binary. Media files go through storeDocument (stored once per content hash).
// The batch includes the export's Encounters so note/message encounter references resolve (no-ops once imported).
export async function importDocuments(client: MedplumClient, dir: string, t: EhiTables, ctx: EhiCtx, patientId: string): Promise<ImportReport> {
  const notes = mapNotes(t, ctx, dir);
  for (const doc of notes.resources as DocumentReference[]) {
    const files = notes.rtf.get(doc.id as string);
    if (!files) continue;
    const ident = doc.identifier?.[0];
    const stored = await client.searchOne('DocumentReference', { identifier: `${ident?.system}|${ident?.value}`, subject: `Patient/${patientId}` }, { cache: 'no-cache' });
    const have = (stored?.content ?? []).map((c) => c.attachment).filter((a) => a.contentType === 'text/rtf' && a.url);
    const rtfs: Attachment[] = [];
    for (const f of files) {
      const data = readFileSync(f);
      const hash = sha1(data);
      const old = have.find((a) => a.hash === hash);
      const url = old?.url ?? `Binary/${(await client.createBinary({ data, contentType: 'text/rtf', filename: basename(f) })).id}`;
      rtfs.push({ contentType: 'text/rtf', url, size: data.length, hash, title: basename(f) });
    }
    doc.content = [...rtfs.map((attachment) => ({ attachment })), ...doc.content];
  }
  const batch: Resource[] = [{ resourceType: 'Patient', id: PATIENT_REF.reference.split('/')[1] }, ...mapEncounters(t, ctx), ...notes.resources, ...mapMessages(t, ctx)];
  const { resources } = await resolveUnlinked(client, batch, patientId);
  const report = await importResources(client, resources, { kind: 'ehi', file: dir, date: ctx.date, writer: 'importer' }, patientId, '');
  const mediaDir = join(dir, 'Media');
  for (const f of existsSync(mediaDir) ? readdirSync(mediaDir).sort() : []) {
    const type = MEDIA_TYPE[extname(f).toLowerCase()];
    if (!type) {
      console.error(`media skipped, unknown type: ${extname(f)}`);
      report.skipped++;
      continue;
    }
    const path = join(mediaDir, f);
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    const existed = await client.searchOne('DocumentReference', `identifier=urn:ga-server:id:file|${hash}`, { cache: 'no-cache' });
    await storeDocument(client, path, patientId, type);
    if (existed) report.skipped++;
    else report.created++;
  }
  return report;
}
