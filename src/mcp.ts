import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { type GaConfig, GaError, getClient } from './config.ts';
import { storeDocument } from './document.ts';
import { importResources, type ImportReport } from './engine.ts';

// Allow-list of types; the patient element is always set (and overridden) so an agent can't write to another patient.
const PATIENT_FIELD: Record<string, string> = { AllergyIntolerance: 'patient', Immunization: 'patient' };
const SUBJECT_TYPES = ['Observation', 'Condition', 'MedicationStatement', 'MedicationRequest', 'DiagnosticReport', 'Procedure', 'Encounter'];
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
      const withPatient = { ...r, [PATIENT_FIELD[r.resourceType] ?? 'subject']: who };
      return r.resourceType === 'Observation'
        ? { ...withPatient, derivedFrom: [...(r.derivedFrom ?? []), { reference: ref }] }
        : { ...withPatient, note: [...((r as { note?: unknown[] }).note ?? []), { text: `Extracted from ${ref}` }] };
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
  const { docRef, fileHash } = await storeDocument(client, sourceFile, patientId, contentType);
  const linked = link(`DocumentReference/${docRef.id}`);
  const date = documentDate ?? statSync(sourceFile).mtime.toISOString();
  return importResources(client, linked, { kind: 'pdf', file: sourceFile, date, writer: 'agent', llm: true }, patientId, fileHash);
}

const TYPE_RE = /^[A-Z][A-Za-z]+$/;
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

export async function runMcp(cfg: GaConfig): Promise<void> {
  // stdout is the MCP channel: send anything chatty to stderr.
  console.log = console.info = console.error;
  const client = await getClient(cfg);
  const patientId = process.env.GA_PATIENT_ID || cfg.patientId; // env override is for tests only
  const server = new McpServer({ name: 'ga-server', version: '0.1.0' });
  server.registerTool(
    'fhir_search',
    { description: 'Search GA FHIR resources.', inputSchema: { resourceType: z.string().regex(TYPE_RE), params: z.record(z.string(), z.string()).default({}) } },
    async ({ resourceType, params }) => {
      try {
        return text(await client.search(resourceType as 'Observation', { ...params, _count: String(Math.min(Number(params._count) || 100, 1000)) }, { cache: 'no-cache' }));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'fhir_read',
    { description: 'Read one GA FHIR resource.', inputSchema: { resourceType: z.string().regex(TYPE_RE), id: z.string() } },
    async ({ resourceType, id }) => {
      try {
        return text(await client.readResource(resourceType as 'Observation', id, { cache: 'no-cache' }));
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
