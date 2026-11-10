import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MedplumClient } from '@medplum/core';

export async function sha256File(filePath: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(filePath), h);
  return h.digest('hex');
}

// Two passes, never a full read: hash, then stream the file as the request body (the client sets duplex 'half' for streams).
// The client's own request path carries the auth of Medplum or GA's store. No retries: a consumed stream can't be resent.
export async function uploadBinaryFile(client: MedplumClient, filePath: string, contentType: string, hash?: string): Promise<{ id: string; sha256: string }> {
  const sha256 = hash ?? await sha256File(filePath);
  const url = `${client.getBaseUrl()}fhir/R4/Binary?_filename=${encodeURIComponent(basename(filePath))}`;
  // Content-Length from the file size: stores that refuse a chunked body accept it.
  const bin = await client.post(url, createReadStream(filePath), contentType, { maxRetries: 0, headers: { 'Content-Length': String(statSync(filePath).size) } }) as { id: string };
  return { id: bin.id, sha256 };
}
