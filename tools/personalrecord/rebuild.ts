import type { Bundle, CodeableConcept, Resource } from '@medplum/fhirtypes';

export type RebuildReport = { emitted: Record<string, number>; alreadyKnown: number; beforeCutoff: number; notEpic: number; otherSource: number; cutoff: string };

export const NOTE = { text: 'Reconstructed from a personalrecord export; original structure lost.' };

const EPIC_ID = /^e[A-Za-z0-9.\-]{15,}$/;
const PREFIXES = ['condition-', 'medrx-', 'docref-', 'dr-', 'imm-', 'proc-'];
const APP_FIELDS = ['subject', 'meta', 'extension', 'source', 'data_type', 'element_id'];
const DATE_FIELDS = ['effectiveDateTime', 'recordedDate', 'authoredOn', 'date', 'occurrenceDateTime', 'performedDateTime', 'issued', 'onsetDateTime'];

type Obs = Record<string, unknown> & { id?: string; code?: CodeableConcept; valueString?: string; effectiveDateTime?: string; extension?: { url?: string; valueString?: string }[] };

const day = (s: unknown): string => (typeof s === 'string' ? s.slice(0, 10) : '');
// An instant for a date string; undefined when it does not parse (the date is left out, never invented).
const instant = (s: string | undefined): string | undefined => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

// The newest clinical date (YYYY-MM-DD) among the known resources; '' when none has one.
function newestDate(known: Record<string, Resource[]>): string {
  let max = '';
  for (const list of Object.values(known)) {
    for (const r of list) {
      for (const f of DATE_FIELDS) {
        const d = day((r as unknown as Record<string, unknown>)[f]);
        if (d > max) max = d;
      }
    }
  }
  return max;
}

const sourceOf = (o: Obs): string | undefined => o.extension?.find((e) => e.url?.endsWith('/source'))?.valueString ?? (typeof o.source === 'string' ? o.source : undefined);
const hasCode = (c?: CodeableConcept) => !!c && (!!c.text || !!c.coding?.length);

function build(prefix: string, id: string, o: Obs): Resource | undefined {
  const date = o.effectiveDateTime;
  const code = o.code;
  const v = o.valueString;
  switch (prefix) {
    case '': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) if (!APP_FIELDS.includes(k)) out[k] = val;
      out.id = id;
      out.note = [...((o.note as unknown[] | undefined) ?? []), NOTE];
      return out as unknown as Resource;
    }
    case 'condition-':
      return { resourceType: 'Condition', id, code, recordedDate: date, ...(v !== undefined && v !== code?.text && { note: [NOTE, { text: v }] }) } as Resource;
    case 'medrx-':
      return { resourceType: 'MedicationRequest', id, status: 'unknown', intent: 'order', medicationCodeableConcept: hasCode(code) ? code : { text: v }, authoredOn: date, note: [NOTE] } as Resource;
    case 'docref-':
      return {
        resourceType: 'DocumentReference', id, status: 'current', type: code, date: instant(date),
        content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: Buffer.from(v ?? '').toString('base64'), title: code?.text } }],
      } as Resource;
    case 'dr-':
      return { resourceType: 'DiagnosticReport', id, status: 'final', code, effectiveDateTime: date, conclusion: v } as Resource;
    case 'imm-':
      return { resourceType: 'Immunization', id, status: 'completed', vaccineCode: code, occurrenceDateTime: date } as Resource;
    case 'proc-':
      return { resourceType: 'Procedure', id, status: 'completed', code, performedDateTime: date } as Resource;
  }
}

export function rebuild(bundle: Bundle, known: Record<string, Resource[]>, opts: { includeBeforeCutoff?: boolean }): { resources: Resource[]; report: RebuildReport } {
  const knownIds = new Set(Object.values(known).flatMap((l) => l.map((r) => r.id)));
  const cutoff = newestDate(known);
  const report: RebuildReport = { emitted: {}, alreadyKnown: 0, beforeCutoff: 0, notEpic: 0, otherSource: 0, cutoff };
  const resources: Resource[] = [];
  for (const e of bundle.entry ?? []) {
    const o = e.resource as Obs | undefined;
    if (!o || o.resourceType !== 'Observation' || !o.id) continue;
    if (sourceOf(o) !== 'ehr_data') { report.otherSource++; continue; }
    const prefix = PREFIXES.find((p) => o.id!.startsWith(p)) ?? '';
    const id = o.id.slice(prefix.length);
    if (!EPIC_ID.test(id)) { report.notEpic++; continue; }
    if (knownIds.has(id)) { report.alreadyKnown++; continue; }
    if (!opts.includeBeforeCutoff && cutoff && day(o.effectiveDateTime) && day(o.effectiveDateTime) <= cutoff) { report.beforeCutoff++; continue; }
    const r = build(prefix, id, o);
    if (!r) continue;
    resources.push(r);
    report.emitted[r.resourceType] = (report.emitted[r.resourceType] ?? 0) + 1;
  }
  return { resources, report };
}
