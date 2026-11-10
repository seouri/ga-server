// Epic FHIR export import against the local Medplum, on a throwaway test patient.
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getClient, loadConfig, type GaConfig } from '../../src/config.ts';
import { importFhirExport } from '../../src/fhir-export/import.ts';
import { sourceKey } from '../../src/smart/auth.ts';
import { cleanupTestPatient, compartmentOf, createTestPatient } from './helpers.ts';

const dir = join(import.meta.dirname, '..', 'fixtures', 'fhir-export');
const MINI = join(dir, 'mini.json');
const MINI_NOTE = join(dir, 'mini-note.json');
const BASE = 'https://fhir.example.org/api/FHIR/R4/';
const ID = `urn:ga-server:id:smart:${sourceKey(BASE)}`;

let client: MedplumClient;
let cfg: GaConfig;
let patientId: string;
const cond = () => client.searchOne('Condition', { identifier: `${ID}|Condition/c1`, subject: `Patient/${patientId}` }, { cache: 'no-cache' });

beforeAll(async () => {
  cfg = loadConfig();
  client = await getClient(cfg);
  patientId = await createTestPatient(client);
});

afterAll(async () => {
  for (const r of await compartmentOf(client, patientId)) {
    for (const c of (r as DocumentReference).content ?? []) {
      const id = /(?:Binary|storage)\/([0-9a-f-]{36})/.exec(c.attachment?.url ?? '')?.[1];
      if (id) await client.deleteResource('Binary', id).catch(() => undefined);
    }
  }
  await cleanupTestPatient(client, patientId);
});

describe('importFhirExport', () => {
  it('imports the export', async () => {
    const r = await importFhirExport(client, cfg, MINI, patientId, { fhirBase: BASE });
    expect(r.created).toBe(4);
    expect(r.attachmentsUnplaced).toBe(1);
    expect(r.skippedTypes).toEqual({ Account: 1 });
    const c = await cond();
    expect(c?.meta?.tag?.map((t) => t.code)).toContain('src-fhir-export');
  });
  it('re-import is a no-op', async () => {
    const r = await importFhirExport(client, cfg, MINI, patientId, { fhirBase: BASE });
    expect(r.created).toBe(0);
    expect(r.updated).toBe(0);
  });
  it('an added note updates the record', async () => {
    await importFhirExport(client, cfg, MINI_NOTE, patientId, { fhirBase: BASE });
    expect((await cond())?.note?.map((n) => n.text)).toContain('patient note');
  });
});
