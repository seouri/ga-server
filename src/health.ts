// health_summary: a one-call snapshot of the record, built from the other read tools' code; each section fails on its own.
import { basename } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Encounter, Endpoint, Observation, Patient } from '@medplum/fhirtypes';
import { TAG } from './identity.ts';
import { collect, fit, labResults } from './labs.ts';
import { concept, type Kind, listsByKind } from './lists.ts';
import { part, SOURCES } from './whats-new.ts';
import { endpointStatus } from './smart/sync.ts';
import { healthMaintenance, raiseNow } from './maintenance.ts';
import { ageOn } from './vaccines.ts';
import { newestFirst, pairBloodPressure, readingRows, vitalSearches } from './vitals.ts';

const VITALS = ['weight', 'bmi', 'blood pressure', 'resting heart rate'];

export async function healthSummary(client: MedplumClient, patientId: string, eps: Promise<Endpoint[]>) {
  const asOf = new Date().toLocaleDateString('en-CA');
  const tomorrow = new Date(Date.parse(asOf) + 864e5).toISOString().slice(0, 10);
  const opts = { cache: 'no-cache' as const };
  const subject = `Patient/${patientId}`;
  // Newest reading per setting, by name and by concept code; one row per reading (a separate systolic and diastolic pair up, and the same
  // reading from a document and another source is one: readingRows). BP is found by text: "blood pressure" as a concept is only the panel.
  const vital = async (name: string) => {
    const found = await Promise.all(vitalSearches(name).flatMap((p) => [true, false].map((home) => collect(client, 'Observation', new URLSearchParams([
      ['subject', subject], ['category', 'vital-signs'], p, [home ? '_tag' : '_tag:not', `${TAG}|src-apple-health`], ['_sort', '-date,_id'], ['_count', '2'],
    ]), (o: Observation) => o, Infinity, 1))));
    const rows = newestFirst(readingRows(pairBloodPressure([...new Map(found.flatMap((f) => f.rows).map((o) => [o.id, o])).values()])));
    return [rows.find((r) => r.setting === 'home'), rows.find((r) => r.setting !== 'home')].filter((r) => !!r);
  };
  // shortcut: a source counts only when it left an Observation (a medication-only PDF is not listed); check DocumentReferences too if that matters.
  const imported = async ([tag, source]: [string, string]) => {
    const o = await client.searchOne('Observation', { subject, _tag: `${TAG}|${tag}`, _sort: '-_lastUpdated', _elements: 'meta' }, opts);
    return o ? [{ source, lastImport: o.meta?.lastUpdated?.slice(0, 10) }] : [];
  };
  const [patient, lists, labs, vitals, maintenance, lastVisit, imports] = await Promise.all([
    part(client.readResource('Patient', patientId, opts).then((p: Patient) => ({ age: p.birthDate ? ageOn(p.birthDate, asOf) : undefined, sex: p.gender }))),
    part(eps.then((e) => listsByKind(client, patientId, e))),
    part(labResults(client, patientId, { summary: true, keyOnly: true, limit: 1000 })),
    part(Promise.all(VITALS.map(vital)).then((r) => r.flat())),
    // The engine's short view, so a chat app whose tool list predates health_maintenance still answers "what's due" from it.
    part(healthMaintenance(client, patientId, asOf).then((m) => ({
      due: m.items.filter((i) => raiseNow(i, asOf)).map(({ name, kind, status, dueDate, importance }) => ({ name, kind, status, dueDate, importance })),
      upcoming: m.upcoming, byTheWay: m.byTheWay,
      note: 'call health_maintenance for the full list: guideline and doctor\'s-plan dates, why it matters and the citation',
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
  const list = (kind: Kind) => ('error' in lists ? lists : fit(lists[kind].map(({ name, currency, since, source, flags }) => ({ name, currency, since, source, flags })), 200));
  return { asOf, patient, problems: list('problems'), medications: list('medications'), allergies: list('allergies'), keyLabs: labs, vitals, maintenance, lastVisit: lastVisit ?? null, imports };
}
