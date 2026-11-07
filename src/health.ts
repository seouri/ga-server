// health_summary: a one-call snapshot of the record, built from the other read tools' code; each section fails on its own.
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Encounter, Endpoint, Observation, Patient } from '@medplum/fhirtypes';
import { TAG } from './identity.ts';
import { collect, labResults, type LabTrend } from './labs.ts';
import { type Kind, listRows, loadLists } from './lists.ts';
import { endpointStatus } from './smart/sync.ts';
import { ageOn, vaccineGaps } from './vaccines.ts';
import { vitalRow } from './vitals.ts';

// [label, LOINC codes, name pattern for results without one]; NOT keeps urine, ratio and particle tests out of the name match.
const KEY_LABS: [string, string[], RegExp][] = [
  ['A1c', ['4548-4', '17856-6'], /a1c|glycated h/],
  ['Glucose', ['2345-7', '2339-0', '1558-6'], /^glucose\b/],
  ['LDL', ['13457-7', '18262-6', '2089-1'], /\bldl\b/],
  ['HDL', ['2085-9'], /\bhdl\b/],
  ['Total cholesterol', ['2093-3'], /^(total )?cholesterol(,? total)?$/],
  ['Triglycerides', ['2571-8'], /^triglyceride/],
  ['Creatinine', ['2160-0'], /^creatinine\b/],
  ['eGFR', ['33914-3', '48642-3', '48643-1', '62238-1', '98979-8'], /egfr|glomerular/],
  ['ALT', ['1742-6', '1743-4'], /^alt\b|alanine amino/],
  ['AST', ['1920-8'], /^ast\b|aspartate amino/],
  ['Hemoglobin', ['718-7'], /^(h(a)?emoglobin|hgb)\b(?!.*(a1c|glyc))/],
  ['Platelets', ['777-3', '26515-7'], /^(platelets?|plt)( count)?$/],
  ['Potassium', ['2823-3', '6298-4'], /^potassium\b/],
  ['Sodium', ['2951-2', '2947-0'], /^sodium\b/],
  ['TSH', ['3016-3', '11580-8'], /\btsh\b|thyrotropin|thyroid stimulating/],
];
const NOT = /urine|\bur\b|ratio|non[- ]?hdl|particle|clearance/;

// The newest matching trend per key lab.
export function keyLabs(trends: LabTrend[]): (LabTrend & { test: string })[] {
  return KEY_LABS.flatMap(([test, codes, re]) => {
    const n = (t: LabTrend) => (t.name ?? '').toLowerCase();
    const t = trends.filter((x) => (x.loinc && codes.includes(x.loinc)) || (re.test(n(x)) && !NOT.test(n(x))))
      .sort((a, b) => (b.latest.date ?? '').localeCompare(a.latest.date ?? ''))[0];
    return t ? [{ test, ...t }] : [];
  });
}

const SOURCES: [string, string][] = [['src-ccda', 'C-CDA'], ['src-ehi', 'Epic EHI export'], ['src-apple-health', 'Apple Health'], ['src-pdf', 'PDF or photo']];
const VITALS = ['weight', 'bmi', 'blood pressure', 'resting heart rate'];
const concept = (c?: { text?: string; coding?: { display?: string; code?: string }[] }) => c?.text ?? c?.coding?.find((x) => x.display)?.display ?? c?.coding?.[0]?.code;
const part = <T,>(p: Promise<T>): Promise<T | { error: string }> => p.catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

export async function healthSummary(client: MedplumClient, patientId: string, eps: Promise<Endpoint[]>) {
  const asOf = new Date().toLocaleDateString('en-CA');
  const tomorrow = new Date(Date.parse(asOf) + 864e5).toISOString().slice(0, 10);
  const opts = { cache: 'no-cache' as const };
  const subject = `Patient/${patientId}`;
  // Newest reading per setting; a second one the same day under another name pairs a separate systolic and diastolic.
  const vital = async (name: string, home: boolean) => {
    const q = new URLSearchParams([['subject', subject], ['category', 'vital-signs'], ['code:text', name], [home ? '_tag' : '_tag:not', `${TAG}|src-apple-health`], ['_sort', '-date,_id'], ['_count', '2']]);
    const { rows } = await collect(client, 'Observation', q, vitalRow, Infinity, 1);
    return rows.filter((r, i) => i === 0 || (r.date === rows[0].date && r.name !== rows[0].name));
  };
  // shortcut: a source counts when it left an Observation; a source with none (e.g. a medication-only PDF) is not listed.
  const imported = async ([tag, source]: [string, string]) => {
    const o = await client.searchOne('Observation', { subject, _tag: `${TAG}|${tag}`, _sort: '-_lastUpdated', _elements: 'meta' }, opts);
    return o ? [{ source, lastImport: o.meta?.lastUpdated?.slice(0, 10) }] : [];
  };
  const [patient, lists, labs, vitals, vaccines, lastVisit, imports] = await Promise.all([
    part(client.readResource('Patient', patientId, opts).then((p: Patient) => ({ age: p.birthDate ? ageOn(p.birthDate, asOf) : undefined, sex: p.gender }))),
    part(eps.then((e) => loadLists(client, patientId, e))),
    part(labResults(client, patientId, { summary: true, limit: 1000 }).then((r) => keyLabs(r.rows as LabTrend[]))),
    part(Promise.all(VITALS.flatMap((n) => [vital(n, false), vital(n, true)])).then((r) => r.flat())),
    part(vaccineGaps(client, patientId, asOf).then((v) => ({
      edition: v.edition,
      dueOrOverdue: v.results.filter((r) => r.status === 'due' || r.status === 'overdue').map((r) => ({ vaccine: r.vaccine, status: r.status, reason: r.reason.split(/(?<=\.) /).at(-1) })),
      notEvaluated: v.results.filter((r) => r.status === 'not-evaluated').length,
    }))),
    // date lt tomorrow: Medplum sorts undated encounters first on -date, and a future one is not a visit yet.
    part(client.searchOne('Encounter', new URLSearchParams([['subject', subject], ['date', `lt${tomorrow}`], ['_sort', '-date']]), opts).then((e?: Encounter) =>
      e && { date: (e.period?.start ?? e.period?.end)?.slice(0, 10), type: concept(e.type?.[0]), class: e.class?.display ?? e.class?.code, source: e.meta?.source && basename(e.meta.source), id: e.id })),
    part(Promise.all([...SOURCES.map(imported), eps.then((e) => e.map(endpointStatus).map((s) => ({ source: `hospital portal ${s.name || s.source}`, lastImport: s.lastSuccess?.slice(0, 10) })))]).then((r) => {
      const sources = r.flat();
      return { newest: sources.map((s) => s.lastImport ?? '').sort().at(-1) || undefined, sources };
    })),
  ]);
  const list = (kind: Kind) => ('error' in lists ? lists : listRows(lists.all, lists.ctx, kind).map(({ name, currency, since, source, flags }) => ({ name, currency, since, source, flags })));
  return { asOf, patient, problems: list('problems'), medications: list('medications'), allergies: list('allergies'), keyLabs: labs, vitals, vaccines, lastVisit: lastVisit ?? null, imports };
}
