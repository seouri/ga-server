// Concept-layer agent tools, both transports (spec "Agent tools"): the review list, and map_concept, which validates a code,
// writes the source map entry (by agent: it replaces any earlier one, which is how corrections work), re-applies it and records Provenance.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TARGET } from '../concept-apply.ts';
import { mapTerm } from '../concept-map-term.ts';
import { agentMappings, reviewList } from '../concepts-cli.ts';
import { fail, text, type ToolDeps } from '../mcp.ts';

const TYPES = Object.keys(TARGET) as [string, ...string[]];

export function registerConceptTools(server: McpServer, deps: ToolDeps): void {
  const { client, patientId, remote } = deps;
  server.registerTool(
    'concepts_to_review',
    {
      description:
        'Source terms in GA with no standard code (status "unmapped", default) or only a suggested one ("suggested"): source, name, unit, record type, ' +
        'how many records and up to three example dates, most frequent first. No values. Map one with map_concept. type: a record type to narrow to. ' +
        'status "agent": the mappings agents made (source, type, term, code, display, confident, when), newest first, for the user to review; since: YYYY-MM-DD.',
      inputSchema: { status: z.enum(['unmapped', 'suggested', 'agent']).default('unmapped'), type: z.string().optional(), since: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status, type, since }) => {
      try {
        if (status === 'agent') return text({ mappings: (await agentMappings(client, since)).filter((m) => !type || m.type === type) });
        return text({ terms: await reviewList(client, patientId, status, type, { fetch: deps.fetch, lookup: deps.cfg.terminologyLookup !== false }) });
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'map_concept',
    {
      description:
        "Map one source term (source, name, unit, type and key exactly as concepts_to_review or ga_import's unmapped list gives them; key carries the specimen when there is one) to a standard code: " +
        'LOINC for labs and vitals, CVX for vaccines, RxNorm for medications (clinical drug when strength and form are given, else ingredient), SNOMED CT or ICD-10-CM for conditions, ' +
        'SNOMED CT (or HCPCS) for procedures, never CPT (licensed: refused). GA checks LOINC, RxNorm, CVX, SNOMED CT and ICD-10-CM codes exist (a code that does not exist is refused, nothing written), then codes every record of that term from that source. ' +
        'When the source lacks a detail the exact code needs, map to the closest broader concept with equivalence "wider". ' +
        'confident: true only when name, unit and specimen all agree with the code (for LOINC, its long name); otherwise false, and the code is applied as suggested. ' +
        'equivalence: "equivalent" when the code means exactly the term; wider/narrower/inexact are applied as suggested; "unmatched" when no standard code exists ' +
        '(adds none and clears the term from review). A second call for the same term replaces the mapping (corrections). ' +
        'Returns changed (records recoded), status mapped, suggested, unmatched or "no records" (the mapping is kept for later imports), and reason (e.g. validation unavailable: applied as suggested; not validated).',
      inputSchema: {
        source: z.string().regex(/^((ehi|ccda|smart):.+|apple-health|pdf)$/),
        name: z.string().min(1).max(200),
        unit: z.string().max(50).optional(),
        key: z.string().max(300).optional(),
        type: z.enum(TYPES),
        system: z.string(),
        code: z.string().min(1),
        display: z.string().max(300),
        equivalence: z.enum(['equivalent', 'wider', 'narrower', 'inexact', 'unmatched']),
        confident: z.boolean(),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const who = remote?.clientName ?? server.server.getClientVersion()?.name ?? 'Claude Code'; // the client is known only after initialize
      try {
        return text(await mapTerm(client, patientId, args, who, { fetch: deps.fetch }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
