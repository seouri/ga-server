import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MedplumClient } from '@medplum/core';
import { registerImportTools } from '../src/tools/imports.ts';
import { acceptUpload, newUpload } from '../src/gateway/uploads.ts';

const PUBLIC = 'https://ga.example.ts.net';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function setup(o: { fileHosts?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ga-imp-'));
  dirs.push(dir);
  const extracted: { sourceFile: string; patientId?: string; bytes: string }[] = [];
  const imported: { path: string; patientId: string; tz?: string; files: boolean }[] = [];
  const fetched: string[] = [];
  const fake = {
    importExtracted: async (_c: unknown, _cfg: unknown, _r: unknown, sourceFile: string, _d?: string, patientId?: string) => {
      extracted.push({ sourceFile, patientId, bytes: readFileSync(sourceFile, 'utf8') });
      return { created: 1 };
    },
    importAny: async (_c: unknown, cfg: { patientId: string }, path: string, opts: { tz?: string }) => {
      imported.push({ path, patientId: cfg.patientId, tz: opts.tz, files: existsSync(join(path, 'ccda-synthetic.xml')) });
      return { created: 2 };
    },
    fetch: async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response('%PDF-1.4 from chatgpt');
    },
    fileHosts: o.fileHosts,
  };
  const server = new McpServer({ name: 't', version: '0' });
  const deps = { client: {} as MedplumClient, cfg: { patientId: 'real' } as never, patientId: 'p', remote: { publicUrl: PUBLIC, clientName: 'c', dir, log: async () => {} } };
  registerImportTools(server, deps, dir, fake as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { isError: r.isError, msg: r.content[0].text!, json: r.isError ? undefined : JSON.parse(r.content[0].text!) };
  };
  const upload = async (name: string, bytes: Buffer | string) => {
    const u = newUpload(dir, PUBLIC);
    return (await acceptUpload(dir, u.token, name, Readable.from([Buffer.from(bytes)]))).fileId;
  };
  return { dir, call, upload, extracted, imported, fetched, client: c };
}

const OBS = [{ resourceType: 'Observation', status: 'final', code: { text: 'Synthetic' } }];

async function waitDone(call: Awaited<ReturnType<typeof setup>>['call'], jobId: string) {
  for (let i = 0; i < 50; i++) {
    const s = await call('import_status', { jobId });
    if (s.json.status !== 'running') return s.json;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('job never finished');
}

test('upload_link returns a one-time link for this gateway', async () => {
  const { call } = await setup();
  const r = await call('upload_link', { purpose: 'lab PDF' });
  expect(r.json.url).toMatch(new RegExp(`^${PUBLIC}/upload/[A-Za-z0-9_-]+$`));
  expect(r.json.fileId).toBeTruthy();
  expect(r.json.next).toContain('15 minutes');
});

test('remote ga_import without fileId is refused; it has no sourceFile', async () => {
  const { call, client, extracted } = await setup();
  const r = await call('ga_import', { resources: OBS });
  expect(r.isError).toBe(true);
  expect(r.msg).toContain('call upload_link first');
  const tool = (await client.listTools()).tools.find((t) => t.name === 'ga_import')!;
  expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('sourceFile');
  expect(tool._meta?.['openai/fileParams']).toEqual(['file']);
  expect(extracted).toEqual([]);
});

test('ga_import with fileId calls importExtracted with the stored upload', async () => {
  const { call, upload, extracted, dir } = await setup();
  const fileId = await upload('report.pdf', '%PDF-1.4 synthetic');
  const r = await call('ga_import', { resources: OBS, fileId, documentDate: '2026-01-02' });
  expect(r.json).toEqual({ created: 1 });
  expect(extracted).toEqual([{ sourceFile: join(dir, 'uploads', fileId, 'report.pdf'), patientId: 'p', bytes: '%PDF-1.4 synthetic' }]);
  expect((await call('ga_import', { resources: OBS, fileId: '../../x' })).msg).toContain('unknown fileId');
});

test('import_file unzips a C-CDA export in the background and import_status reports done', async () => {
  const { call, upload, imported } = await setup();
  const fileId = await upload('export.zip', readFileSync(join(import.meta.dirname, 'fixtures', 'zips', 'ccda.zip')));
  const r = await call('import_file', { fileId, tz: 'America/New_York' });
  expect(r.json.jobId).toBeTruthy();
  const s = await waitDone(call, r.json.jobId);
  expect(s).toMatchObject({ status: 'done', report: { created: 2 } });
  expect(imported).toEqual([{ path: expect.stringMatching(/\/ccda$/), patientId: 'p', tz: 'America/New_York', files: true }]);
  // The extracted copy is removed after the job.
  expect(existsSync(imported[0].path)).toBe(false);
  expect((await call('import_status', {})).json.jobs).toContainEqual(expect.objectContaining({ jobId: r.json.jobId, status: 'done' }));
});

test('import_file refuses PDFs, bad zips and bad zones', async () => {
  const { call, upload } = await setup();
  const pdf = await upload('scan.pdf', '%PDF');
  expect((await call('import_file', { fileId: pdf })).msg).toContain('read it in the chat and call ga_import with this fileId');
  const bad = await upload('bad.zip', 'not a zip');
  const s = await waitDone(call, (await call('import_file', { fileId: bad })).json.jobId);
  expect(s.status).toBe('failed');
  expect(s.message).toBeTruthy();
  const zip = await upload('e.zip', readFileSync(join(import.meta.dirname, 'fixtures', 'zips', 'ccda.zip')));
  expect((await call('import_file', { fileId: zip, tz: 'Not/AZone' })).msg).toContain('IANA');
});

test('ChatGPT download_url: refused unless https on a listed host, with no fetch', async () => {
  const none = await setup();
  for (const url of ['https://files.example.com/a.pdf', 'http://files.example.com/a.pdf']) {
    const r = await none.call('ga_import', { resources: OBS, file: { download_url: url, file_name: 'a.pdf' } });
    expect(r.msg).toContain('upload_link instead');
  }
  expect(none.fetched).toEqual([]);

  const listed = await setup({ fileHosts: ['files.example.com'] });
  expect((await listed.call('ga_import', { resources: OBS, file: { download_url: 'http://files.example.com/a.pdf', file_name: 'a.pdf' } })).msg).toContain('upload_link instead');
  expect((await listed.call('ga_import', { resources: OBS, file: { download_url: 'https://evil.example/a.pdf', file_name: 'a.pdf' } })).msg).toContain('upload_link instead');
  expect(listed.fetched).toEqual([]);
  const ok = await listed.call('ga_import', { resources: OBS, file: { download_url: 'https://files.example.com/a.pdf', file_name: 'a.pdf' } });
  expect(ok.json).toEqual({ created: 1 });
  expect(listed.extracted[0].bytes).toBe('%PDF-1.4 from chatgpt');
  expect(listed.extracted[0].sourceFile).toMatch(/\/uploads\/[A-Za-z0-9_-]{22}\/a\.pdf$/);
});
