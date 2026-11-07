import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { type MedplumClient, OperationOutcomeError, projectAdminResourceTypes, protectedResourceTypes } from '@medplum/core';
import type { Extension, Identifier, Immunization, Narrative, Resource } from '@medplum/fhirtypes';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { type GaConfig, GaError, getClient } from './config.ts';
import { storeDocument } from './document.ts';
import { importResources, type ImportReport } from './engine.ts';
import { pairImmunizations } from './ehi/history.ts';
import { type SourceInfo, stableIdentifier } from './identity.ts';
import { cardiovascularRisk10yr } from './cardiovascular-risk.ts';
import { vaccineGaps } from './vaccines.ts';
import { labResults } from './labs.ts';
import { chatInstructions } from './instructions.ts';
import { registerHospitalTools } from './tools/hospitals.ts';
import { registerAppTools } from './tools/apps.ts';
import { registerImportTools } from './tools/imports.ts';
import { registerShareTools } from './tools/shares.ts';

// Allow-list of types; the patient element is always set (and overridden) so an agent can't write to another patient.
const PATIENT_FIELD: Record<string, string> = { AllergyIntolerance: 'patient', Immunization: 'patient' };
const SUBJECT_TYPES = ['Observation', 'Condition', 'MedicationStatement', 'MedicationRequest', 'DiagnosticReport', 'Procedure', 'Encounter'];
// R4 Encounter and DiagnosticReport have no note: their link to the file is meta.source only.
const NO_NOTE = new Set(['Encounter', 'DiagnosticReport']);
// FHIR date, or dateTime with seconds and zone.
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;
const TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

// Validate, store the source file, link every resource to it, then run the dedup-safe write path.
export async function importExtracted(
  client: MedplumClient,
  cfg: GaConfig,
  resources: Resource[],
  sourceFile: string,
  documentDate?: string,
  patientId = cfg.patientId,
): Promise<ImportReport> {
  if (documentDate !== undefined) {
    const day = documentDate.slice(0, 10);
    const ok = DATE_RE.test(documentDate) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().startsWith(day);
    // A future date would win every later update.
    if (!ok || Date.parse(documentDate) > Date.now()) throw new GaError('documentDate must be a past date (YYYY-MM-DD) or dateTime with zone');
  }
  if (!resources.length) throw new GaError('no resources to import');
  const bad = resources.find((r) => !r || typeof r !== 'object' || typeof r.resourceType !== 'string' || !r.resourceType);
  if (bad !== undefined) throw new GaError('every resource needs a resourceType');
  const unsupported = resources.find((r) => !PATIENT_FIELD[r.resourceType] && !SUBJECT_TYPES.includes(r.resourceType));
  if (unsupported) throw new GaError(`unsupported resourceType: ${unsupported.resourceType}`);
  // Only document types: a prompt-injected "document" must not make GA store an arbitrary local file.
  const contentType = TYPES[extname(sourceFile).toLowerCase()];
  if (!contentType) throw new GaError(`sourceFile must be a PDF or image (${Object.keys(TYPES).join(', ')})`);
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) throw new GaError(`sourceFile not found: ${sourceFile}`);
  const who = { reference: `Patient/${patientId}` };
  const link = (ref: string) =>
    resources.map((r) => {
      const withPatient = { ...untrusted(r), [PATIENT_FIELD[r.resourceType] ?? 'subject']: who };
      if (r.resourceType === 'Observation') return { ...withPatient, derivedFrom: [...(r.derivedFrom ?? []), { reference: ref }] };
      if (NO_NOTE.has(r.resourceType)) return withPatient;
      return { ...withPatient, note: [...((r as { note?: unknown[] }).note ?? []), { text: `Extracted from ${ref}` }] };
    }) as Resource[];
  // Validate before storeDocument so a bad batch leaves no orphan Binary/DocumentReference. Type/element only: messages can echo values.
  for (const r of link('DocumentReference/00000000-0000-4000-8000-000000000000')) {
    try {
      await client.validateResource(r);
    } catch (e) {
      const paths = e instanceof OperationOutcomeError ? (e.outcome.issue ?? []).map((i) => i.expression?.join(',')).filter(Boolean) : [];
      throw new GaError(`invalid ${r.resourceType}${paths.length ? `: ${paths.join(' ')}` : ''}`);
    }
  }
  // Re-extraction gives different LLM output, so a second import of the same file would only add duplicates.
  const hash = createHash('sha256').update(readFileSync(sourceFile)).digest('hex');
  const seen = await client.searchOne('DocumentReference', { identifier: `urn:ga-server:id:file|${hash}`, subject: `Patient/${patientId}` }, { cache: 'no-cache' });
  if (seen) throw new GaError(`already imported: ${basename(sourceFile)} (if that import failed, delete DocumentReference/${seen.id} to retry)`);
  const { docRef, fileHash } = await storeDocument(client, sourceFile, patientId, contentType);
  const linked = link(`DocumentReference/${docRef.id}`);
  const date = documentDate ?? statSync(sourceFile).mtime.toISOString();
  const source: SourceInfo = { kind: 'pdf', file: sourceFile, date, writer: 'agent', llm: true };
  // Immunizations have no content-key dedup in the engine: a dose GA already holds only gains this document as a source
  // (its identifier); the existing record's body stays as recorded.
  const imms = linked.filter((r): r is Immunization => r.resourceType === 'Immunization');
  const existing = imms.length ? await client.searchResources('Immunization', { patient: `Patient/${patientId}`, _count: '1000' }, { cache: 'no-cache' }) : [];
  const pairs = pairImmunizations(existing, imms);
  // The identifier can't be there yet: it embeds this file's hash, and a file is imported once (checked above).
  for (const [n, m] of pairs.entries()) {
    if (m) await client.updateResource<Immunization>({ ...m, identifier: [...(m.identifier ?? []), stableIdentifier(imms[n], source, fileHash, patientId)] });
  }
  const paired = new Set(imms.filter((_, n) => pairs[n]));
  const report = await importResources(client, linked.filter((r) => !paired.has(r as Immunization)), source, patientId, fileHash);
  report.merged += paired.size;
  return report;
}

// Trust boundary: agent output must not pre-set GA bookkeeping (tags, source date, GA identifiers).
const ours = (x: { url?: string; system?: string }) => (x.url ?? x.system ?? '').startsWith('urn:ga-server:');
function untrusted(r: Resource): Resource {
  const { meta: _m, ...out } = r as Resource & { extension?: Extension[]; identifier?: Identifier[] };
  for (const k of ['extension', 'identifier'] as const) {
    const kept = (out[k] as { url?: string; system?: string }[] | undefined)?.filter((x) => !ours(x));
    if (kept?.length) Object.assign(out, { [k]: kept });
    else delete out[k];
  }
  return out as Resource;
}

// Keeps MCP output small: no narrative, meta reduced to source and tags.
export const slim = (r: Resource) => {
  const { text: _t, meta, ...rest } = r as Resource & { text?: Narrative };
  return { ...rest, meta: { source: meta?.source, tag: meta?.tag } };
};

// Output only (stored data unchanged): a text/plain attachment (EHI notes) shows its decoded text in place of base64 data.
export const readable = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(readable);
  if (!x || typeof x !== 'object') return x;
  const o = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, readable(v)]));
  if (typeof o.data !== 'string' || !/^text\/plain\b/i.test(String(o.contentType ?? ''))) return o;
  const { data, ...rest } = o;
  return { ...rest, text: Buffer.from(data as string, 'base64').toString('utf8') };
};

const TYPE_RE = /^[A-Z][A-Za-z]+$/;
// Medplum project-admin types (secrets, logins, bots): never readable through the agent tools, either transport.
// Medplum's own lists (so upgrades are covered) plus the types GA already blocked.
const ADMIN_TYPES = new Set([...protectedResourceTypes, ...projectAdminResourceTypes, 'ClientApplication', 'User', 'Project', 'ProjectMembership', 'Login', 'Bot', 'AccessPolicy', 'JsonWebKey', 'UserConfiguration', 'UserSecurityRequest', 'Subscription', 'Agent', 'DomainConfiguration', 'PasswordChangeRequest', 'SmartAppLaunch', 'BulkDataExport', 'AsyncJob']);
const refuseAdmin = (t: string) => (ADMIN_TYPES.has(t) ? fail(new GaError(`${t} is not available through this tool`)) : undefined);
export const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
export const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

export type ToolDeps = {
  client: MedplumClient;
  cfg: GaConfig;
  patientId: string;
  // dir: the gateway's state directory (uploads); default gatewayDir().
  remote?: { publicUrl: string; clientName: string; dir?: string; disconnect?: (clientId: string) => Promise<void>; log: (tool: string) => Promise<void> };
};

const CAP = 150_000; // claude.ai's tool-result limit is about this size
const STDIO_INSTRUCTIONS =
        "GA (Guardian Angel) is the user's personal health record: labs, vitals, medications, problems and documents from their hospitals. " +
        "For any question about the user's own health, look here first and cite the records you use. " +
        'Hospital portal sync status: first fhir_search Endpoint with identifier urn:ga-server:id:smart-source| (system only). A source is stale if its ' +
        'status is off or error, or its extension urn:ga-server:ext:smart-last-success is missing or older than 48 hours. If any is stale, start the ' +
        'answer with one line naming it, its last success and the fix: `ga connect <its address>` when off (error disconnected: the user disconnected it on purpose, say so; error not_enabled: no types enabled yet, nothing synced from it, fix `ga sync --enable <Type,...> <source>`), else `ga sync`. ' +
        'Medications (and problems, allergies) from a portal: current only if active and its urn:ga-server:ext:last-seen equals the smart-last-success ' +
        'of the Endpoint whose identifier value is the <key> in its urn:ga-server:id:smart:<key> identifier (any of them, if several); otherwise unconfirmed (may have stopped). ' +
        'Records without last-seen: an active one whose urn:ga-server:ext:source-date is older than the newest Epic import is unconfirmed.';

export function buildMcpServer(deps: ToolDeps): McpServer {
  const { client, cfg, patientId, remote } = deps;
  const server = new McpServer({ name: 'ga-server', version: '0.1.0' }, { instructions: remote ? chatInstructions() : STDIO_INSTRUCTIONS });
  if (remote) {
    // One wrap for every tool: log first, then cap the text.
    const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...a: unknown[]) => Promise<any>) => unknown;
    (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: (...a: unknown[]) => Promise<any>) =>
      register(name, config, async (...a: unknown[]) => {
        await remote.log(name);
        const r = await cb(...a);
        for (const c of r.content ?? [])
          if (c.type === 'text' && c.text.length > CAP) c.text = `${c.text.slice(0, CAP)}[truncated: narrow the search, e.g. _count, _elements or a date range]`;
        return r;
      });
  }
  server.registerTool(
    'fhir_search',
    {
      description:
        "Search the user's personal health record (GA) by FHIR resource type and search params. A param given as a list is repeated, " +
        'e.g. a date range {"date": ["ge2024-01-01", "lt2025-01-01"]}; dates need full YYYY-MM-DD (not "2024"). Newest first: "_sort": "-date". ' +
        'Results read from PDFs may lack a category, so also search without "category" before concluding a result is missing.',
      inputSchema: { resourceType: z.string().regex(TYPE_RE), params: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}) },
      annotations: { readOnlyHint: true },
    },
    async ({ resourceType, params }) => {
      const no = refuseAdmin(resourceType);
      if (no) return no;
      try {
        // Medplum's client joins arrays with commas (FHIR OR); repeated params (AND, e.g. date ranges) need URLSearchParams.
        const q = new URLSearchParams(Object.entries(params).flatMap(([k, v]) => [v].flat().map((x) => [k, x])));
        q.set('_count', String(Math.min(Number([params._count].flat()[0]) || 20, 1000)));
        const b = await client.search(resourceType as 'Observation', q, { cache: 'no-cache' });
        b.entry = b.entry?.filter((e) => !ADMIN_TYPES.has(e.resource?.resourceType ?? ''));
        for (const e of b.entry ?? []) if (e.resource) e.resource = slim(e.resource) as typeof e.resource;
        return text(readable(b));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'fhir_read',
    { description: "Read one resource from the user's personal health record (GA).", inputSchema: { resourceType: z.string().regex(TYPE_RE), id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ resourceType, id }) => {
      const no = refuseAdmin(resourceType);
      if (no) return no;
      try {
        return text(readable(await client.readResource(resourceType as 'Observation', id, { cache: 'no-cache' })));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'lab_results',
    {
      description:
        "The user's lab and test results from GA (blood tests, urine tests, A1c, cholesterol...): use this for any question about lab results " +
        '(the latest value, a trend, a year\'s results) instead of fhir_search. Finds labs from every source, including PDFs imported without a category; ' +
        'excludes Apple Health and vital signs. name: part of the test name, case-insensitive (e.g. "a1c", "ldl"); since/until: YYYY-MM-DD, inclusive. ' +
        'Newest first; one row per result: date, name, value (with unit), range, interpretation, source file, flags, id (for fhir_read). ' +
        'Flag "read from a document by AI": tell the user to check the value against the original document. "possible-duplicate": the same test twice; mention both. ' +
        'truncated: more results exist; narrow by name or dates.',
      inputSchema: {
        name: z.string().min(1).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return text(await labResults(client, patientId, input));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'cardiovascular_risk_10yr',
    {
      description:
        '10-year cardiovascular risk from inputs you read from GA: AHA PREVENT base model (ASCVD and total CVD) and the 2013 Pooled Cohort Equations. ' +
        'Use this instead of computing risk yourself. Cholesterol in mg/dL; returns probabilities (0-1) and notes on out-of-range inputs.',
      inputSchema: {
        age: z.number(), sex: z.enum(['male', 'female']), totalC: z.number(), hdlC: z.number(), sbp: z.number(),
        bpTx: z.boolean(), statin: z.boolean(), diabetes: z.boolean(), smoker: z.boolean(), egfr: z.number(),
        race: z.enum(['black', 'other']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => text(cardiovascularRisk10yr(input)),
  );
  server.registerTool(
    'vaccine_gaps',
    {
      description:
        "Adult vaccination status from GA against the shipped CDC adult immunization schedule: reads the user's birth date, sex, Immunizations and " +
        'immunity lab results from GA itself. Use this instead of judging the schedule yourself. Returns per vaccine: status ' +
        '(complete/due/overdue/not-recommended/immune/not-evaluated), the GA records used (date, source) and the reason; unmatched records; ' +
        'possible-duplicate records; and the schedule edition. asOf defaults to today (YYYY-MM-DD).',
      inputSchema: { asOf: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ asOf }) => {
      try {
        return text(await vaccineGaps(client, patientId, asOf));
      } catch (e) {
        return fail(e);
      }
    },
  );
  // Remote ga_import (by fileId) is in tools/imports.ts.
  if (!remote) server.registerTool(
    'ga_import',
    {
      description: 'Import resources extracted from one local PDF/image: stores the file, links resources to it, dedups. Call once per document.',
      inputSchema: { resources: z.array(z.record(z.string(), z.unknown())), sourceFile: z.string(), documentDate: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    async ({ resources, sourceFile, documentDate }) => {
      try {
        return text(await importExtracted(client, cfg, resources as unknown as Resource[], sourceFile, documentDate, patientId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  if (remote) {
    registerShareTools(server, deps);
    registerHospitalTools(server, deps);
    registerImportTools(server, deps);
    if (remote.disconnect) registerAppTools(server, deps); // the gateway supplies it
  }
  return server;
}

export async function runMcp(cfg: GaConfig): Promise<void> {
  // stdout is the MCP channel: send anything chatty to stderr.
  console.log = console.info = console.error;
  const client = await getClient(cfg);
  const patientId = process.env.GA_PATIENT_ID || cfg.patientId; // env override is for tests only
  await buildMcpServer({ client, cfg, patientId }).connect(new StdioServerTransport());
}
