import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Reference, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { importEhi } from '../../src/ehi/import.ts';
import { mapEncounters } from '../../src/ehi/encounters.ts';
import { linkImmunizationsToExisting, mapFamilyHistory, mapHealthMaintenance, mapImmunizations, mapQuestionnaires, mapSocial, mapVitals } from '../../src/ehi/history.ts';
import { type EhiCtx, PATIENT_REF, resolveUnlinked } from '../../src/ehi/ids.ts';
import { mapMeds } from '../../src/ehi/meds.ts';
import { EhiTables, exportInfo } from '../../src/ehi/read.ts';
import { importResources } from '../../src/engine.ts';
import { ehiTables } from '../fixtures-gen/ehi.ts';
import { cleanupTestMaps, cleanupTestPatient, createTestPatient } from './helpers.ts';

const EHI = join(import.meta.dirname, '..', 'fixtures', 'ehi');
// Own org: stable identifiers are global, so this file's records never meet ehi.test.ts's.
const ctx: EhiCtx = { ...exportInfo(EHI), org: 'synthetic-health-docs' };
let client: MedplumClient;
let pid: string;
let docsPid: string | undefined;

beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
});

afterAll(async () => {
  await cleanupTestMaps(client);
  for (const p of [pid, docsPid ?? []].flat()) {
    for (const d of await client.searchResources('DocumentReference', { subject: `Patient/${p}` }, { cache: 'no-cache' })) {
      for (const c of d.content ?? []) {
        const bin = c.attachment.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
        if (bin) await client.deleteResource('Binary', bin);
      }
    }
    await cleanupTestPatient(client, p);
  }
});

async function importHistory() {
  const t = new EhiTables(EHI);
  const batch: Resource[] = [
    { resourceType: 'Patient', id: PATIENT_REF.reference.split('/')[1] }, ...mapEncounters(t, ctx), ...mapImmunizations(t, ctx), ...mapFamilyHistory(t, ctx),
    ...mapVitals(t, ctx), ...mapSocial(t, ctx), ...mapHealthMaintenance(t, ctx), ...mapQuestionnaires(t, ctx), ...mapMeds(t, ctx),
  ].flat() as Resource[];
  const linked = await linkImmunizationsToExisting(client, batch, pid);
  const { resources } = await resolveUnlinked(client, linked.resources, pid);
  return importResources(client, resources, { kind: 'ehi', file: EHI, date: ctx.date, writer: 'importer' }, pid, '');
}

test('history and medication records are valid FHIR and re-import is a no-op', async () => {
  // 1 Encounter, 3 Immunizations, 4 FamilyMemberHistory, 6 vitals, 3 social, 2 HM statuses + 1 completion, 1 QuestionnaireResponse, 1 MedicationRequest
  expect(await importHistory()).toMatchObject({ created: 22, invalid: 0, possibleDuplicates: 0 });
  expect(await importHistory()).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0 });
});

// Its own patient: the history records above would meet the export's own as possible duplicates.
test('the import stores notes, messages and media once, readable', async () => {
  const pid = await createTestPatient(client);
  docsPid = pid;
  const first = await importEhi(client, { patientId: pid } as GaConfig, EHI, pid, ctx.timeZone);
  expect(first).toMatchObject({ invalid: 0, possibleDuplicates: 0 });
  expect(first.created).toBeGreaterThanOrEqual(7); // 3 notes, 2 messages, 1 RTF file, 1 media (+ the Encounter when new)
  const notes = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${exportInfo(EHI).org}|HNO_INFO|1001` }, { cache: 'no-cache' });
  expect(notes).toHaveLength(1);
  // The note holds its text; the RTF is its own stored file, linked by relatesTo.
  const [text, ...more] = notes[0].content;
  expect(more).toHaveLength(0);
  expect(Buffer.from(text.attachment.data as string, 'base64').toString('utf8')).toBe('Synthetic note body.');
  const rtfRef = notes[0].relatesTo?.[0];
  expect(rtfRef?.code).toBe('transforms');
  const rtf = await client.readReference<DocumentReference>(rtfRef?.target as Reference<DocumentReference>);
  expect(rtf.content[0].attachment).toMatchObject({ contentType: 'text/rtf', title: 'HNO_1001_56510_41.RTF' });
  const msgs = await client.searchResources('Communication', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(msgs.map((m) => m.payload?.[0]?.contentString).sort()).toEqual(['Hello there\nSecond’s line', 'plain line\nsay "x\n"quoted" start not split\nline1\nline2']);
  const reply = msgs.find((m) => m.inResponseTo);
  expect(reply?.inResponseTo?.[0]?.reference).toBe(`Communication/${msgs.find((m) => !m.inResponseTo)?.id}`);
  // Medplum presigns attachment URLs with an expiry: wait so a URL in the compared body would differ.
  await new Promise((r) => setTimeout(r, 1100));
  const again = await importEhi(client, { patientId: pid } as GaConfig, EHI, pid, ctx.timeZone);
  expect(again).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0 });
  const [same] = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${exportInfo(EHI).org}|HNO_INFO|1001` }, { cache: 'no-cache' });
  expect(same.relatesTo).toEqual(notes[0].relatesTo); // the same stored RTF, no second upload
});

test('R18: an IMM_ADMIN dose on an IMMUNE dose date is stored as its possible duplicate, pointing at it', async () => {
  const base = new EhiTables(EHI);
  const extra = { ...[...base.rows('IMM_ADMIN')][1], IMM_TYPE_FREE_TEXT: 'Other name', IMM_DATE: '1/15/2026 12:00:00 AM', IMM_LOT_NUMBER: 'LOT2' };
  const t = ehiTables((table: string) => (table === 'IMM_ADMIN' ? [...base.rows(table), extra] : base.rows(table)));
  const c: EhiCtx = { ...ctx, org: 'synthetic-health-dup' };
  const batch: Resource[] = [{ resourceType: 'Patient', id: PATIENT_REF.reference.split('/')[1] }, ...mapEncounters(t, c), ...mapImmunizations(t, c)].flat() as Resource[];
  const src = { kind: 'ehi' as const, file: EHI, date: c.date, writer: 'importer' as const };
  const run = async () => importResources(client, (await resolveUnlinked(client, batch, pid)).resources, src, pid, '');
  expect(await run()).toMatchObject({ invalid: 0 });
  const [dose] = await client.searchResources('Immunization', { patient: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${c.org}|IMMUNE|6100001` }, { cache: 'no-cache' });
  const [dup] = await client.searchResources('Immunization', { patient: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${c.org}|IMM_ADMIN|other name|2026-01-15` }, { cache: 'no-cache' });
  expect(dup.meta?.tag).toEqual(expect.arrayContaining([{ system: 'urn:ga-server:tag', code: 'possible-duplicate' }]));
  expect(dup.extension).toEqual(expect.arrayContaining([{ url: 'urn:ga-server:ext:possible-duplicate-of', valueReference: { reference: `Immunization/${dose.id}` } }]));
  expect(await run()).toMatchObject({ created: 0, updated: 0, invalid: 0 });
});
