// Child of upload-stream.test.ts: uploads argv[2] to the store in GA_STORE_URL and prints {id, sha256}.
import { MedplumClient } from '@medplum/core';
import { bearer } from '../src/config.ts';
import { uploadBinaryFile } from '../src/upload-stream.ts';

const client = new MedplumClient({ baseUrl: process.env.GA_STORE_URL, fetch: bearer(process.env.GA_STORE_TOKEN!) });
console.log(JSON.stringify(await uploadBinaryFile(client, process.argv[2], 'application/octet-stream')));
