// Concept-layer agent tools, both transports (spec "Agent tools"): the review list, and map_concept, which validates a code,
// writes the source map entry (by agent: it replaces any earlier one, which is how corrections work), re-applies it and records Provenance.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provenance, Resource } from '@medplum/fhirtypes';
import { z } from 'zod';
import { TARGET } from '../concept-apply.ts';
import { validate } from '../concept-validate.ts';
import { applyAll, reviewList } from '../concepts-cli.ts';
import { inScope, termKey, upsertEntry } from '../conceptmap.ts';
import { GaError } from '../config.ts';
import { fail, text, type ToolDeps } from '../mcp.ts';

const TYPES = Object.keys(TARGET) as [string, ...string[]];

// A stand-in record carrying only what the term key and scope read; category laboratory so that, for Observations,
// only the name rules (Apple summaries, health maintenance, ECG) decide scope.
// shortcut: no specimen input, so a lab term whose records carry specimen.display (key name|unit|specimen) can't be mapped; add one if such terms show up.
const termOf = (type: string, name: string, unit?: string): Resource => {
  const cc = { text: name };
  if (type === 'Observation') return { resourceType: 'Observation', status: 'final', code: cc, category: [{ coding: [{ code: 'laboratory' }] }], ...(unit && { valueQuantity: { unit } }) };
  const field = type === 'Immunization' ? 'vaccineCode' : type.startsWith('Medication') ? 'medicationCodeableConcept' : 'code';
  return { resourceType: type, [field]: cc } as unknown as Resource;
};

export function registerConceptTools(server: McpServer, deps: ToolDeps): void {
  const { client, patientId, remote } = deps;
  server.registerTool(
    'concepts_to_review',
    {
      description:
        'Source terms in GA with no standard code (status "unmapped", default) or only a suggested one ("suggested"): source, name, unit, record type, ' +
        'how many records and up to three example dates, most frequent first. No values. Map one with map_concept. type: a record type to narrow to.',
      inputSchema: { status: z.enum(['unmapped', 'suggested']).default('unmapped'), type: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status, type }) => {
      try {
        return text({ terms: await reviewList(client, patientId, status, type) });
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'map_concept',
    {
      description:
        "Map one source term (source, name, unit and type exactly as concepts_to_review or ga_import's unmapped list gives them) to a standard code: " +
        'LOINC for labs and vitals, CVX for vaccines, RxNorm for medications (clinical drug when strength and form are given, else ingredient), SNOMED CT or ICD-10-CM for conditions, ' +
        'SNOMED CT, CPT or HCPCS for procedures. GA checks LOINC, RxNorm and CVX codes exist, then codes every record of that term from that source. ' +
        'confident: true only when name, unit and specimen all agree with the code (for LOINC, its long name); otherwise false, and the code is applied as suggested. ' +
        'equivalence: "equivalent" when the code means exactly the term; wider/narrower/inexact are applied as suggested; "unmatched" when no standard code exists ' +
        '(adds none and clears the term from review). A second call for the same term replaces the mapping (corrections). ' +
        'Returns changed (records recoded), status mapped or suggested, and reason (e.g. validation unavailable, not validated).',
      inputSchema: {
        source: z.string().regex(/^((ehi|ccda|smart):.+|apple-health|pdf)$/),
        name: z.string().min(1),
        unit: z.string().optional(),
        type: z.enum(TYPES),
        system: z.string(),
        code: z.string().min(1),
        display: z.string(),
        equivalence: z.enum(['equivalent', 'wider', 'narrower', 'inexact', 'unmatched']),
        confident: z.boolean(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ source, name, unit, type, system, code, display, equivalence, confident }) => {
      try {
        // Refusals first: nothing is sent or written for them.
        const term = termOf(type, name, unit);
        const key = termKey(term);
        if (!key || !inScope(term)) throw new GaError(`${type} "${name}" is not in the concept layer's scope (GA's own Apple Health summaries, health maintenance and the ECG are never mapped)`);
        const unmatched = equivalence === 'unmatched';
        if (!unmatched && !TARGET[type].includes(system)) throw new GaError(`${type} takes ${TARGET[type].join(', ')}, not ${system}`);
        const v = unmatched ? { ok: true } : await validate(system, code, name, { fetch: deps.fetch });
        const sure = confident && v.ok && !v.reason; // a failed or skipped validation is applied as suggested
        const map = await upsertEntry(client, source, {
          key, equivalence, confident: sure, by: 'agent',
          ...(!unmatched && { target: { system, code, display: v.display ?? display } }),
        });
        const { changed } = await applyAll(client, patientId, { source, key });
        await client.createResource<Provenance>({
          resourceType: 'Provenance',
          target: [{ reference: `ConceptMap/${map?.id}` }],
          recorded: new Date().toISOString(),
          activity: { coding: [{ system: 'urn:ga-server:activity', code: 'map_concept' }] },
          agent: [{ who: { display: remote?.clientName ?? 'Claude Code' } }],
          reason: [{ text: `${source} "${key}" (${type}): ${unmatched ? 'unmatched' : `${system}|${code} ${equivalence}${sure ? '' : ', suggested'}`}` }],
        });
        return text({ changed, status: unmatched || (sure && equivalence === 'equivalent') ? 'mapped' : 'suggested', ...(v.reason && { reason: v.reason }) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
