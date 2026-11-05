import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Reference, Resource } from '@medplum/fhirtypes';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { importDocuments } from '../../src/ehi/documents.ts';
import { mapEncounters } from '../../src/ehi/encounters.ts';
import { linkImmunizationsToExisting, mapFamilyHistory, mapHealthMaintenance, mapImmunizations, mapQuestionnaires, mapSocial, mapVitals } from '../../src/ehi/history.ts';
import { type EhiCtx, PATIENT_REF, resolveUnlinked } from '../../src/ehi/ids.ts';
import { mapMeds } from '../../src/ehi/meds.ts';
import { EhiTables, exportInfo } from '../../src/ehi/read.ts';
import { importResources } from '../../src/engine.ts';
import { cleanupTestPatient, createTestPatient } from './helpers.ts';

const EHI = join(import.meta.dirname, '..', 'fixtures', 'ehi');
// Own org: stable identifiers are global, so this file's records never meet ehi.test.ts's.
const ctx: EhiCtx = { ...exportInfo(EHI), org: 'synthetic-health-docs' };
let client: MedplumClient;
let pid: string;

beforeAll(async () => {
  client = await getClient(loadConfig());
  pid = await createTestPatient(client);
});

afterAll(async () => {
  for (const d of await client.searchResources('DocumentReference', { subject: `Patient/${pid}` }, { cache: 'no-cache' })) {
    for (const c of d.content ?? []) {
      const bin = c.attachment.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
      if (bin) await client.deleteResource('Binary', bin);
    }
  }
  await cleanupTestPatient(client, pid);
});

async function importHistory() {
  const t = new EhiTables(EHI);
  const batch: Resource[] = [
    { resourceType: 'Patient', id: PATIENT_REF.reference.split('/')[1] }, ...mapEncounters(t, ctx), ...mapImmunizations(t, ctx), ...mapFamilyHistory(t, ctx),
    ...mapVitals(t, ctx), ...mapSocial(t, ctx), ...mapHealthMaintenance(t, ctx), ...mapQuestionnaires(t, ctx), ...mapMeds(t, ctx),
  ];
  const linked = await linkImmunizationsToExisting(client, batch, pid);
  const { resources } = await resolveUnlinked(client, linked.resources, pid);
  return importResources(client, resources, { kind: 'ehi', file: EHI, date: ctx.date, writer: 'importer' }, pid, '');
}

test('history and medication records are valid FHIR and re-import is a no-op', async () => {
  // 1 Encounter, 3 Immunizations, 4 FamilyMemberHistory, 6 vitals, 3 social, 2 HM statuses + 1 completion, 1 QuestionnaireResponse, 1 MedicationRequest
  expect(await importHistory()).toMatchObject({ created: 22, invalid: 0, possibleDuplicates: 0 });
  expect(await importHistory()).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0 });
});

test('importDocuments stores notes, messages and media once, readable', async () => {
  const t = new EhiTables(EHI);
  const first = await importDocuments(client, EHI, t, ctx, pid);
  expect(first).toMatchObject({ invalid: 0, possibleDuplicates: 0 });
  expect(first.created).toBeGreaterThanOrEqual(7); // 3 notes, 2 messages, 1 RTF file, 1 media (+ the Encounter when new)
  const notes = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${ctx.org}|HNO_INFO|1001` }, { cache: 'no-cache' });
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
  const again = await importDocuments(client, EHI, new EhiTables(EHI), ctx, pid);
  expect(again).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0 });
  const [same] = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${ctx.org}|HNO_INFO|1001` }, { cache: 'no-cache' });
  expect(same.relatesTo).toEqual(notes[0].relatesTo); // the same stored RTF, no second upload
});
