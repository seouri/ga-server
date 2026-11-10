import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Identifier } from '@medplum/fhirtypes';
import { sha256File, uploadBinaryFile } from './upload-stream.ts';

// Stores the source file once per content hash: Binary plus a DocumentReference identified by the hash.
export async function storeDocument(
  client: MedplumClient,
  filePath: string,
  patientId: string,
  contentType: string,
  extraIdentifiers: Identifier[] = [], // written in the same create, so the record is never without them
): Promise<{ docRef: DocumentReference; fileHash: string; created: boolean }> {
  const fileHash = await sha256File(filePath);
  const query = `identifier=urn:ga-server:id:file|${fileHash}&subject=Patient/${patientId}`; // per patient: the same file may belong to two
  // Look first so a re-import doesn't upload an orphan Binary.
  const existing = await client.searchOne('DocumentReference', query, { cache: 'no-cache' });
  if (existing) return { docRef: existing, fileHash, created: false };
  const bin = await uploadBinaryFile(client, filePath, contentType, fileHash);
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
