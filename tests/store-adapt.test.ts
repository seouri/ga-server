// GA on the SQLite store: concepts_to_review order does not depend on storage order; attachment Binary/<id> URLs download.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Observation } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { reviewList } from '../src/concepts-cli.ts';
import { storeDocument } from '../src/document.ts';
import { binaryFetcher } from '../src/share/cli.ts';
import { BINARY_URL } from '../src/share/scope.ts';
import { onStore } from './temp-store.ts';

const lab = (name: string, day: string): Observation => ({
  resourceType: 'Observation', status: 'final', code: { text: name }, subject: { reference: 'Patient/p' }, effectiveDateTime: day,
  valueQuantity: { value: 1, unit: 'mg/dL' },
  meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-pdf' }, { system: 'urn:ga-server:tag', code: 'concept-unmapped' }] },
});

const listed = (order: Observation[]) => onStore(async ({ client }) => {
  for (const o of order) await client.createResource(o);
  return (await reviewList(client, 'p', 'unmapped')).map((t) => [t.key, t.name, t.count]);
});

test('two runs on reshuffled storage return the same rows (ties by source, type and term; name by most frequent, then smallest spelling)', async () => {
  const rows = [lab('Zinc', '2024-01-01'), lab('Alpha', '2024-01-02'), lab('Mid', '2024-01-03'), lab('Mid', '2024-01-04'), lab('MID', '2024-01-05'), lab('beta', '2024-01-06'), lab('BETA', '2024-01-07')];
  const a = await listed(rows);
  const b = await listed([...rows].reverse());
  expect(a).toEqual([['mid|mg/dl', 'Mid', 3], ['beta|mg/dl', 'BETA', 2], ['alpha|mg/dl', 'Alpha', 1], ['zinc|mg/dl', 'Zinc', 1]]);
  expect(b).toEqual(a);
});

test('a stored file\'s attachment is Binary/<id> on the store; binaryFetcher downloads its bytes, the share regex sees it', async () => {
  await onStore(async ({ client, dir }) => {
    const file = join(dir, 'doc.xml');
    writeFileSync(file, '<ClinicalDocument/>');
    const p = await client.createResource({ resourceType: 'Patient' });
    const { docRef } = await storeDocument(client, file, p.id as string, 'application/xml');
    const [read] = await client.searchResources('DocumentReference', { _id: docRef.id as string });
    const url = read.content[0].attachment.url as string;
    expect(url).toMatch(/^Binary\/[0-9a-f-]{36}$/);
    expect(BINARY_URL.exec(url)?.[1]).toBe(url.slice('Binary/'.length));
    const got = (await binaryFetcher(client)(url, p.id as string))!;
    expect(got.data.toString('utf8')).toBe('<ClinicalDocument/>');
    expect(got.contentType).toMatch(/^application\/xml/);
    expect(await client.readResource('Binary', BINARY_URL.exec(url)?.[1] as string)).toMatchObject({ resourceType: 'Binary', contentType: 'application/xml' });
  });
});

test('concepts review reads a C-CDA custodian from the stored file through its Binary/<id> URL (MedplumClient.download maps Binary/ to the FHIR base)', async () => {
  await onStore(async ({ client, dir }) => {
    const file = join(dir, 'synthetic.xml');
    writeFileSync(file, '<ClinicalDocument><custodian><assignedCustodian><representedCustodianOrganization><name>Synthetic Clinic</name></representedCustodianOrganization></assignedCustodian></custodian></ClinicalDocument>');
    await storeDocument(client, file, 'p', 'application/xml');
    const o = lab('Glucose', '2024-01-01');
    await client.createResource({ ...o, meta: { source: file, tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }, { system: 'urn:ga-server:tag', code: 'concept-unmapped' }] } });
    expect((await reviewList(client, 'p', 'unmapped')).map((t) => t.source)).toEqual(['ccda:synthetic clinic']);
  });
});
