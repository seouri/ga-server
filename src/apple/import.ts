import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { archiveFolder } from '../archive.ts';
import { GaError, type GaConfig } from '../config.ts';
import { importResources, type ImportReport } from '../engine.ts';
import { withImportLock } from '../lock.ts';
import { mapClinical, mapEcgs } from './clinical.ts';
import { Daily } from './daily.ts';
import { type AhClinical, readExport } from './read.ts';
import { Readings, short } from './readings.ts';

const TAGGED = 'urn:ga-server:tag|src-apple-health';
// Types the unchanged filter covers (AllergyIntolerance always goes to the engine: its status/reaction can change under one id) and the search param naming the patient.
const TYPES: [string, string][] = [['Observation', 'subject'], ['DocumentReference', 'subject']];

const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v;
const projection = (r: Record<string, unknown>) =>
  JSON.stringify(canon({ status: r.status, code: r.code, valueQuantity: r.valueQuantity, valueString: r.valueString, component: r.component, effectiveDateTime: r.effectiveDateTime, effectivePeriod: r.effectivePeriod }));
const firstId = (r: { identifier?: { system?: string; value?: string }[] }) => `${r.identifier?.[0]?.system}|${r.identifier?.[0]?.value}`;

// Medplum refuses search offsets past 10000 ("Search offset exceeds maximum", measured), and a real export is far larger,
// so a type is fetched in _lastUpdated windows, halved until each holds at most `max` resources.
const MAX_OFFSET = 10000;

async function fetchWindow(client: MedplumClient, type: string, q: Record<string, string>, lo: number, hi: number, max: number, out: Map<string, string>): Promise<number> {
  // URLSearchParams: _lastUpdated twice (an object would join the values with a comma)
  const w = (extra: Record<string, string>) => new URLSearchParams({ ...q, ...extra, _lastUpdated: `ge${new Date(lo).toISOString()}` }).toString() + `&_lastUpdated=lt${new Date(hi).toISOString()}`;
  const total = (await client.search(type as 'Observation', w({ _summary: 'count' }), { cache: 'no-cache' })).total ?? 0;
  if (total === 0) return 0;
  if (total > max) {
    if (hi - lo <= 1) throw new GaError(`more than ${max} existing ${type} records share one timestamp; cannot page`);
    const mid = Math.floor((lo + hi) / 2);
    return (await fetchWindow(client, type, q, lo, mid, max, out)) + (await fetchWindow(client, type, q, mid, hi, max, out));
  }
  let n = 0;
  for await (const page of client.searchResourcePages(type as 'Observation', w({
    _count: '1000', _elements: 'identifier,status,code,valueQuantity,valueString,component,effectiveDateTime,effectivePeriod',
  }), { cache: 'no-cache' })) {
    for (const r of page) { n++; out.set(firstId(r as never), projection(r as never)); }
  }
  if (n !== total) throw new GaError(`paging returned ${n} of ${total} existing ${type} records; refusing to import`);
  return n;
}

// What GA already holds from Apple Health for this patient: first identifier -> projection. Counts are checked against
// the server's own totals, so a short result throws instead of silently re-importing everything.
export async function existing(client: MedplumClient, patientId: string, max = MAX_OFFSET): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [type, param] of TYPES) {
    const q = { [param]: `Patient/${patientId}`, _tag: TAGGED };
    const n = await fetchWindow(client, type, q, 0, Date.now() + 86400e3, max, out);
    const total = (await client.search(type as 'Observation', { ...q, _summary: 'count' }, { cache: 'no-cache' })).total;
    if (total !== n) throw new GaError(`paging returned ${n} of ${total} existing ${type} records; refusing to import`);
  }
  return out;
}

export async function importAppleHealth(
  client: MedplumClient,
  cfg: GaConfig,
  dir: string,
  patientId = cfg.patientId,
): Promise<ImportReport & { archived: 'stored' | 'already-present'; unchanged: number; seconds: number; skips: Record<string, unknown> }> {
  const t0 = Date.now();
  const archived = await archiveFolder(client, dir, patientId, 'urn:ga-server:id:apple-health-archive');
  const readings = new Readings();
  const daily = new Daily();
  const refs: AhClinical[] = [];
  const archiveOnly: Record<string, number> = {};
  const { exportDate, nested } = await readExport(dir, {
    record(r) {
      const a = readings.add(r);
      const b = daily.add(r);
      if (!a && !b) archiveOnly[short(r.type)] = (archiveOnly[short(r.type)] ?? 0) + 1;
    },
    summary: (s) => daily.summary(s),
    clinical: (c) => refs.push(c),
  });
  const rd = readings.result(), dl = daily.result(), cl = mapClinical(dir, refs), ecg = mapEcgs(dir);
  const all: Resource[] = [{ resourceType: 'Patient', id: 'apple-patient' }, ...rd.resources, ...dl.resources, ...cl.resources, ...ecg.resources];
  const have = await existing(client, patientId);
  let unchanged = 0;
  const rest = all.filter((r) => {
    if (r.resourceType === 'Patient' || r.resourceType === 'AllergyIntolerance') return true;
    const same = have.get(firstId(r as never)) === projection(r as never);
    if (same) unchanged++;
    return !same;
  });
  const report = await withImportLock(() => importResources(client, rest, { kind: 'apple-health', file: dir, date: exportDate, writer: 'importer' }, patientId, ''));
  const skips = { nested, archiveOnly, ...rd.skips, ...dl.skips, ...cl.skips, ...ecg.skips };
  return { ...report, archived, unchanged, seconds: (Date.now() - t0) / 1000, skips };
}
