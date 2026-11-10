import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { MedplumClient } from '@medplum/core';

export async function sha256File(filePath: string): Promise<string> {
  const h = createHash('sha256');
  await pipelineAsync(createReadStream(filePath), h);
  return h.digest('hex');
}

// Two passes, never a full read: hash, then stream the file as the request body (the client sets duplex 'half' for streams).
// The client's own request path carries the auth of Medplum or GA's store. No retries: a consumed stream can't be resent.
export async function uploadBinaryFile(client: MedplumClient, filePath: string, contentType: string, hash?: string): Promise<{ id: string; sha256: string }> {
  const sha256 = hash ?? await sha256File(filePath);
  const size = statSync(filePath).size; // before opening: a vanished file throws here, not as a stream error
  const url = `${client.getBaseUrl()}fhir/R4/Binary?_filename=${encodeURIComponent(basename(filePath))}`;
  // The hash of the bytes actually sent: a file changed between the passes fails the import instead of being stored under the wrong hash.
  const sent = createHash('sha256');
  const body = new Transform({ transform(chunk, _e, cb) { sent.update(chunk); cb(null, chunk); } });
  pipeline(createReadStream(filePath), body, (e) => { if (e) body.destroy(e); });
  // Content-Length from the file size: stores that refuse a chunked body accept it.
  const bin = await client.post(url, body, contentType, { maxRetries: 0, headers: { 'Content-Length': String(size) } }) as { id: string };
  if (sent.digest('hex') !== sha256) throw new Error(`file changed during upload: ${basename(filePath)}`);
  return { id: bin.id, sha256 };
}
