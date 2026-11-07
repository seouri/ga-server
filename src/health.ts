// health_summary: a one-call snapshot of the record, built from the other read tools' code; each section fails on its own.
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Encounter, Endpoint, Patient } from '@medplum/fhirtypes';
import { TAG } from './identity.ts';
import { collect, fit, labResults } from './labs.ts';
import { concept, type Kind, listRows, loadLists } from './lists.ts';
import { endpointStatus } from './smart/sync.ts';
import { ageOn, vaccineGaps } from './vaccines.ts';
import { vitalRow } from './vitals.ts';

const SOURCES: [string, string][] = [['src-ccda', 'C-CDA'], ['src-ehi', 'Epic EHI export'], ['src-apple-health', 'Apple Health'], ['src-pdf', 'PDF or photo']];
const VITALS = ['weight', 'bmi', 'blood pressure', 'resting heart rate'];
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
  // shortcut: a source counts only when it left an Observation (a medication-only PDF is not listed); check DocumentReferences too if that matters.
  const imported = async ([tag, source]: [string, string]) => {
    const o = await client.searchOne('Observation', { subject, _tag: `${TAG}|${tag}`, _sort: '-_lastUpdated', _elements: 'meta' }, opts);
    return o ? [{ source, lastImport: o.meta?.lastUpdated?.slice(0, 10) }] : [];
  };
  const [patient, lists, labs, vitals, vaccines, lastVisit, imports] = await Promise.all([
    part(client.readResource('Patient', patientId, opts).then((p: Patient) => ({ age: p.birthDate ? ageOn(p.birthDate, asOf) : undefined, sex: p.gender }))),
    part(eps.then((e) => loadLists(client, patientId, e))),
    part(labResults(client, patientId, { summary: true, keyOnly: true, limit: 1000 })),
    part(Promise.all(VITALS.flatMap((n) => [vital(n, false), vital(n, true)])).then((r) => r.flat())),
    part(vaccineGaps(client, patientId, asOf).then((v) => ({
      edition: v.edition,
      dueOrOverdue: v.results.filter((r) => r.status === 'due' || r.status === 'overdue').map((r) => ({ vaccine: r.vaccine, status: r.status, reason: r.reason?.split(/(?<=\.) /).at(-1) })),
      notEvaluated: v.results.filter((r) => r.status === 'not-evaluated').length,
      unmatched: v.unmatched.length,
      possibleDuplicates: v.possibleDuplicates.length,
      note: 'call vaccine_gaps before telling the user a vaccine is due',
    }))),
    // date lt tomorrow: Medplum sorts undated encounters first on -date, and a future one is not a visit yet.
    part(client.searchOne('Encounter', new URLSearchParams([['subject', subject], ['date', `lt${tomorrow}`], ['status:not', 'cancelled'], ['status:not', 'entered-in-error'], ['_sort', '-date']]), opts).then((e?: Encounter) =>
      e && { date: (e.period?.start ?? e.period?.end)?.slice(0, 10), type: concept(e.type?.[0]), class: e.class?.display ?? e.class?.code, source: e.meta?.source && basename(e.meta.source), id: e.id })),
    part(Promise.all([...SOURCES.map(imported), eps.then((e) => e.map(endpointStatus).map((s) => ({ source: `hospital portal ${s.name || s.source}`, lastImport: s.lastSuccess?.slice(0, 10) })))]).then((r) => {
      const sources = r.flat();
      return { newest: sources.map((s) => s.lastImport ?? '').sort().at(-1) || undefined, sources };
    })),
  ]);
  // At most 200 each, so the remote 150k cut can't drop the sections after them.
  const list = (kind: Kind) => ('error' in lists ? lists : fit(listRows(lists.all, lists.ctx, kind).map(({ name, currency, since, source, flags }) => ({ name, currency, since, source, flags })), 200));
  return { asOf, patient, problems: list('problems'), medications: list('medications'), allergies: list('allergies'), keyLabs: labs, vitals, vaccines, lastVisit: lastVisit ?? null, imports };
}
