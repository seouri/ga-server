import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { type MedplumClient, OperationOutcomeError } from '@medplum/core';
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
const slim = (r: Resource) => {
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
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

export async function runMcp(cfg: GaConfig): Promise<void> {
  // stdout is the MCP channel: send anything chatty to stderr.
  console.log = console.info = console.error;
  const client = await getClient(cfg);
  const patientId = process.env.GA_PATIENT_ID || cfg.patientId; // env override is for tests only
  const server = new McpServer(
    { name: 'ga-server', version: '0.1.0' },
    {
      instructions:
        "GA (Guardian Angel) is the user's personal health record: labs, vitals, medications, problems and documents from their hospitals. " +
        "For any question about the user's own health, look here first and cite the records you use.",
    },
  );
  server.registerTool(
    'fhir_search',
    { description: "Search the user's personal health record (GA) by FHIR resource type and search params.", inputSchema: { resourceType: z.string().regex(TYPE_RE), params: z.record(z.string(), z.string()).default({}) } },
    async ({ resourceType, params }) => {
      try {
        const b = await client.search(resourceType as 'Observation', { ...params, _count: String(Math.min(Number(params._count) || 20, 1000)) }, { cache: 'no-cache' });
        for (const e of b.entry ?? []) if (e.resource) e.resource = slim(e.resource) as typeof e.resource;
        return text(readable(b));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'fhir_read',
    { description: "Read one resource from the user's personal health record (GA).", inputSchema: { resourceType: z.string().regex(TYPE_RE), id: z.string() } },
    async ({ resourceType, id }) => {
      try {
        return text(readable(await client.readResource(resourceType as 'Observation', id, { cache: 'no-cache' })));
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
    },
    async ({ asOf }) => {
      try {
        return text(await vaccineGaps(client, patientId, asOf));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'ga_import',
    {
      description: 'Import resources extracted from one local PDF/image: stores the file, links resources to it, dedups. Call once per document.',
      inputSchema: { resources: z.array(z.record(z.string(), z.unknown())), sourceFile: z.string(), documentDate: z.string().optional() },
    },
    async ({ resources, sourceFile, documentDate }) => {
      try {
        return text(await importExtracted(client, cfg, resources as unknown as Resource[], sourceFile, documentDate, patientId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  await server.connect(new StdioServerTransport());
}
