// Import tools for chat apps (remote servers only): upload links, background export imports, and ga_import by fileId.
// Remote ga_import never takes a local path: file-path imports stay stdio-only.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Resource } from '@medplum/fhirtypes';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GaError } from '../config.ts';
import { gatewayDir } from '../gateway/store.ts';
import { newFileId, newUpload, storeUpload, uploadPath } from '../gateway/uploads.ts';
import { CLI_ONLY, type JobRecord, jobStatus, listJobs, type Run, startJob } from '../import-jobs.ts';
import { DOCUMENT_EXT, detectKind } from '../import.ts';
import { fail, importExtracted, text, type ToolDeps } from '../mcp.ts';

// Empty until a ChatGPT download host is verified in acceptance testing: until then ChatGPT uses upload_link too.
const FILE_HOSTS = (JSON.parse(readFileSync(new URL('../../config/chat-apps.json', import.meta.url), 'utf8')) as { fileHosts?: string[] }).fileHosts ?? [];
// What import_status shows of a job record: no paths, no checkpoint internals.
const view = (j: JobRecord) => ({ jobId: j.id, status: j.status, started: j.started, batchesDone: j.lastBatch + 1, attempts: j.attempts, report: j.report, message: j.message, note: j.note });

// ChatGPT passes attached files as {download_url, file_name} for the params named in _meta["openai/fileParams"].
const FILE = z.object({ download_url: z.string(), file_name: z.string() }).optional();
const CHATGPT = { 'openai/fileParams': ['file'] };
type File = { download_url: string; file_name: string };

const fns = { importExtracted, run: undefined as Run | undefined, fetch: globalThis.fetch as (u: URL, i: RequestInit) => Promise<Response>, fileHosts: undefined as string[] | undefined };
export function registerImportTools(server: McpServer, deps: ToolDeps, f: Partial<typeof fns> = {}): void {
  const { client, cfg, patientId, remote } = deps;
  if (!remote) throw new GaError('import tools need a remote server');
  const dir = remote.dir ?? gatewayDir();
  const { importExtracted: extract, run, fetch: get, fileHosts } = { ...fns, ...f };
  const hosts = fileHosts ?? FILE_HOSTS;

  // Fetched only over https from a listed host, never following redirects, into a new upload with the same 2 GB cap.
  async function download(file: File): Promise<string> {
    const u = URL.parse(file.download_url);
    if (u?.protocol !== 'https:' || u.username || u.password || !hosts.includes(u.hostname)) throw new GaError('GA does not download from that address: call upload_link instead');
    const r = await get(u, { redirect: 'error' });
    if (!r.ok || !r.body) throw new GaError(`download failed (HTTP ${r.status}): call upload_link instead`);
    const fileId = newFileId();
    await storeUpload(dir, fileId, file.file_name, Readable.fromWeb(r.body as never));
    return fileId;
  }
  const stored = async (fileId?: string, file?: File): Promise<string> => {
    if (file) return uploadPath(dir, await download(file));
    if (!fileId) throw new GaError('no file: call upload_link first, give the user the link, then pass its fileId');
    return uploadPath(dir, fileId);
  };

  server.registerTool(
    'upload_link',
    {
      description:
        'A one-time link (15 minutes, one use) for the user to upload a file to GA: a PDF or photo of a document, or an export as a .zip ' +
        '(Apple Health export.zip, Epic EHI export, Epic C-CDA Health Summary). The user signs in with their passkey on that page and picks the file.',
      inputSchema: { purpose: z.string().optional() },
    },
    async () => {
      try {
        const { url, expiresAt, fileId } = newUpload(dir, remote.publicUrl);
        return text({
          url, fileId, expiresAt,
          next:
            'Give the user this link (valid 15 minutes, one use). When they say the upload finished: for a PDF or photo, have them attach the same file in this chat, ' +
            'read it, extract by the PDF extraction rules and call ga_import with this fileId; for a .zip export call import_file with this fileId.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ga_import',
    {
      description:
        'Import resources you extracted from one PDF/image the user uploaded: pass its fileId (from upload_link) or, in ChatGPT, the attached file. ' +
        'GA links every resource to the stored original and dedups. Call once per document.',
      inputSchema: { resources: z.array(z.record(z.string(), z.unknown())), fileId: z.string().optional(), file: FILE, documentDate: z.string().optional() },
      annotations: { destructiveHint: true },
      _meta: CHATGPT,
    },
    async ({ resources, fileId, file, documentDate }) => {
      try {
        return text(await extract(client, cfg, resources as unknown as Resource[], await stored(fileId, file), documentDate, patientId));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'import_file',
    {
      description:
        'Import an uploaded export (zip of Apple Health, Epic EHI or C-CDA, or a C-CDA file) in the background. Returns a jobId at once: poll import_status. ' +
        'tz: the IANA zone of an Epic EHI export, e.g. America/New_York. PDFs and photos go through ga_import instead.',
      inputSchema: { fileId: z.string().optional(), file: FILE, tz: z.string().optional() },
      annotations: { destructiveHint: true },
      _meta: CHATGPT,
    },
    async ({ fileId, file, tz }) => {
      try {
        if (tz !== undefined) {
          try {
            if (!tz) throw new RangeError();
            new Intl.DateTimeFormat('en', { timeZone: tz });
          } catch {
            throw new GaError('tz needs an IANA time zone, e.g. America/New_York');
          }
        }
        const path = await stored(fileId, file);
        if (DOCUMENT_EXT.test(path)) throw new GaError('this is a PDF or image: read it in the chat and call ga_import with this fileId');
        // Chat apps cannot pass a FHIR base, and a DICOM study is not a single upload: only the CLI imports these.
        if (!/\.zip$/i.test(path) && ['fhir-export', 'dicom'].includes(detectKind(path))) throw new GaError(CLI_ONLY);
        const jobId = startJob(dir, path, { tz, patientId, run }).id;
        return text({ jobId, next: 'The import runs in the background: call import_status with this jobId.' });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'import_status',
    {
      description: 'Status of background imports: running (batches done so far; it resumes by itself after a GA restart), done (with the import report) or failed (with the message). Without jobId: all of them.',
      inputSchema: { jobId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      if (jobId === undefined) return text({ jobs: listJobs(dir).map(view) });
      const j = jobStatus(dir, jobId);
      return j ? text(view(j)) : fail(new GaError('unknown jobId'));
    },
  );
}
