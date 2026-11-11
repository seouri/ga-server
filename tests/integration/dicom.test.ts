import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type GaConfig, getClient, loadConfig } from '../../src/config.ts';
import { importDicom } from '../../src/dicom/import.ts';
import { NEVER_DOCS } from '../../src/share/scope.ts';
import { cleanupTestMaps, cleanupTestPatient, createTestPatient } from './helpers.ts';

let client: MedplumClient;
let cfg: GaConfig;
let patientId: string;
let dir: string;

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
  patientId = await createTestPatient(client);
  dir = mkdtempSync(join(tmpdir(), 'ga-dicom-'));
  cpSync(join(import.meta.dirname, '..', 'fixtures', 'dicom'), dir, { recursive: true, filter: (s) => !s.endsWith('make.ts') });
  writeFileSync(join(dir, 'DICOMDIR'), '');
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await cleanupTestMaps(client);
  for (const d of await client.searchResources('DocumentReference', { subject: `Patient/${patientId}` }, { cache: 'no-cache' })) {
    for (const c of d.content ?? []) {
      const bin = c.attachment.url?.match(/(?:Binary|storage)\/([^/?]+)/)?.[1];
      if (bin) await client.deleteResource('Binary', bin);
    }
  }
  await cleanupTestPatient(client, patientId);
});

it('imports study, overview PDF and archive', async () => {
  const r = await importDicom(client, cfg, dir, patientId);
  expect(r).toMatchObject({ studies: 1, documents: 1, unsupported: 1, archive: 'stored' });
  expect(r.notDicom).toBeGreaterThanOrEqual(2); // DICOMDIR, Preview.jpg
  const doc = await client.searchOne('DocumentReference', { identifier: 'urn:ga-server:id:dicom-archive|', subject: `Patient/${patientId}` });
  expect(doc).toBeDefined();
  const study = await client.searchOne('ImagingStudy', { identifier: 'urn:dicom:uid|urn:oid:1.2.3', subject: `Patient/${patientId}` });
  expect(study?.numberOfInstances).toBe(5);
  const pdf = await client.searchOne('DocumentReference', { identifier: 'urn:dicom:uid|urn:oid:1.2.3.8.1', subject: `Patient/${patientId}` });
  expect(pdf?.context?.related?.[0]?.reference).toBe(`ImagingStudy/${study?.id}`);
});
it('re-import is a no-op', async () => expect(await importDicom(client, cfg, dir, patientId)).toMatchObject({ created: 0, updated: 0, skipped: 1, documents: 0, archive: 'already-present' }));
it('never shares the archive', () => expect(NEVER_DOCS.has('urn:ga-server:id:dicom-archive')).toBe(true));
