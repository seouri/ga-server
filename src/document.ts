import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Identifier } from '@medplum/fhirtypes';

// Stores the source file once per content hash: Binary plus a DocumentReference identified by the hash.
export async function storeDocument(
  client: MedplumClient,
  filePath: string,
  patientId: string,
  contentType: string,
  extraIdentifiers: Identifier[] = [], // written in the same create, so the record is never without them
): Promise<{ docRef: DocumentReference; fileHash: string; created: boolean }> {
  const data = readFileSync(filePath);
  const fileHash = createHash('sha256').update(data).digest('hex');
  const query = `identifier=urn:ga-server:id:file|${fileHash}`;
  // Look first so a re-import doesn't upload an orphan Binary.
  const existing = await client.searchOne('DocumentReference', query, { cache: 'no-cache' });
  if (existing) return { docRef: existing, fileHash, created: false };
  const bin = await client.createBinary({ data, contentType, filename: basename(filePath) });
  const docRef = await client.createResourceIfNoneExist<DocumentReference>(
    {
      resourceType: 'DocumentReference',
      status: 'current',
      identifier: [{ system: 'urn:ga-server:id:file', value: fileHash }, ...extraIdentifiers],
      subject: { reference: `Patient/${patientId}` },
      content: [{ attachment: { contentType, url: `Binary/${bin.id}`, title: basename(filePath) } }],
    },
    query,
  );
  return { docRef, fileHash, created: true };
}
