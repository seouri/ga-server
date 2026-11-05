import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
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
      const bin = c.attachment.url?.match(/^Binary\/(.+)$/)?.[1];
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
  expect(first.created).toBeGreaterThanOrEqual(6); // 3 notes, 2 messages, 1 media (+ the Encounter when new)
  const notes = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${ctx.org}|HNO_INFO|1001` }, { cache: 'no-cache' });
  expect(notes).toHaveLength(1);
  const [rtf, text] = notes[0].content;
  expect(rtf.attachment).toMatchObject({ contentType: 'text/rtf', title: 'HNO_1001_56510_41.RTF' });
  expect(Buffer.from(text.attachment.data as string, 'base64').toString('utf8')).toBe('Synthetic note body.');
  const msgs = await client.searchResources('Communication', { subject: `Patient/${pid}` }, { cache: 'no-cache' });
  expect(msgs.map((m) => m.payload?.[0]?.contentString).sort()).toEqual(['Hello there\nSecond’s line', 'plain line\nsay "x\n"quoted" start not split\nline1\nline2']);
  const reply = msgs.find((m) => m.inResponseTo);
  expect(reply?.inResponseTo?.[0]?.reference).toBe(`Communication/${msgs.find((m) => !m.inResponseTo)?.id}`);
  const again = await importDocuments(client, EHI, new EhiTables(EHI), ctx, pid);
  expect(again).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0 });
  // No second Binary: the stored note still points at the first upload.
  const [same] = await client.searchResources('DocumentReference', { subject: `Patient/${pid}`, identifier: `urn:ga-server:id:ehi:${ctx.org}|HNO_INFO|1001` }, { cache: 'no-cache' });
  expect(same.content[0].attachment.url).toBe(rtf.attachment.url);
});
