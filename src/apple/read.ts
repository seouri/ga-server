import { closeSync, createReadStream, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { GaError } from '../config.ts';

export type AhRecord = { type: string; unit?: string; value?: string; sourceName: string; startDate: string; endDate: string };
export type AhSummary = { date: string; activeEnergyBurned?: number; activeEnergyBurnedUnit?: string; appleExerciseTime?: number; appleStandHours?: number; activeEnergyBurnedGoal?: number };
export type AhClinical = { sourceURL: string; fhirVersion: string; resourceFilePath: string; receivedDate?: string; sourceName?: string };

export function isAppleHealthExport(dir: string): boolean {
  const file = join(dir, 'export.xml');
  if (!existsSync(file)) return false;
  const buf = Buffer.alloc(4096);
  const fd = openSync(file, 'r');
  try { return buf.toString('utf8', 0, readSync(fd, buf, 0, 4096, 0)).includes('<!DOCTYPE HealthData'); } finally { closeSync(fd); }
}

// '2017-11-03 10:13:05 -0500' -> '2017-11-03T10:13:05-05:00'
export function appleDate(s: string): string {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(s?.trim() ?? ''); // undefined: a line cut short
  if (!m) throw new GaError(`bad Apple Health date: ${s}`);
  return `${m[1]}T${m[2]}${m[3]}:${m[4]}`;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (m, h, d, n) => (n ? (ENT[n] ?? m) : String.fromCodePoint(h ? parseInt(h, 16) : Number(d))));
}
// Values are copied: a substring of a line keeps its whole 64 KiB read chunk alive (heap profile, spike 2026-11-09).
const own = (s: string) => (' ' + s).slice(1);
function attrs(line: string): Record<string, string> {
  const a: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) a[m[1]] = own(decode(m[2]));
  return a;
}
const num = (s?: string) => (s === undefined || s === '' ? undefined : Number(s));

export type AhItem = { record: AhRecord } | { summary: AhSummary } | { clinical: AhClinical } | { exportDate: string };

// export.xml in file order, one item per Record (outside Correlation/Workout), ActivitySummary, ClinicalRecord and ExportDate.
export async function* readItems(dir: string): AsyncGenerator<AhItem, { exportDate: string; nested: number }> {
  const file = join(dir, 'export.xml');
  if (!existsSync(file)) throw new GaError(`not an Apple Health export: ${dir}`);
  let exportDate: string | undefined;
  let nested = 0;
  let inside = false; // within <Correlation>/<Workout>, whose Records also appear at top level
  const input = createReadStream(file, 'utf8');
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const tag = /^\s*<(\/?)(\w+)/.exec(line);
      if (!tag) continue;
      const [, close, name] = tag;
      if (name === 'Correlation' || name === 'Workout') {
        inside = !close && !/\/>\s*$/.test(line);
      } else if (close) continue;
      else if (name === 'Record') {
        if (inside) { nested++; continue; }
        const a = attrs(line);
        yield { record: { type: a.type, unit: a.unit, value: a.value, sourceName: a.sourceName, startDate: appleDate(a.startDate), endDate: appleDate(a.endDate) } };
      } else if (name === 'ExportDate') {
        exportDate = appleDate(attrs(line).value);
        yield { exportDate };
      } else if (name === 'ActivitySummary') {
        const a = attrs(line);
        yield { summary: {
          date: a.dateComponents,
          activeEnergyBurned: num(a.activeEnergyBurned), activeEnergyBurnedUnit: a.activeEnergyBurnedUnit,
          appleExerciseTime: num(a.appleExerciseTime), appleStandHours: num(a.appleStandHours),
          activeEnergyBurnedGoal: num(a.activeEnergyBurnedGoal),
        } };
      } else if (name === 'ClinicalRecord') {
        const a = attrs(line);
        yield { clinical: { sourceURL: a.sourceURL, fhirVersion: a.fhirVersion, resourceFilePath: a.resourceFilePath, ...(a.receivedDate && { receivedDate: appleDate(a.receivedDate) }), ...(a.sourceName && { sourceName: a.sourceName }) } };
      }
    }
  } finally { input.destroy(); } // a caller that stops early (exportDateOf) or a throw: close the file
  if (!exportDate) throw new GaError(`not an Apple Health export: ${dir}`);
  return { exportDate, nested };
}

// The export's date, read before any record is written (it heads export.xml).
export async function exportDateOf(dir: string): Promise<string> {
  for await (const x of readItems(dir)) if ('exportDate' in x) return x.exportDate;
  throw new GaError(`not an Apple Health export: ${dir}`);
}

export async function readExport(
  dir: string,
  on: { record(r: AhRecord): void; summary(s: AhSummary): void; clinical(c: AhClinical): void },
): Promise<{ exportDate: string; nested: number }> {
  const it = readItems(dir);
  for (let n = await it.next(); ; n = await it.next()) {
    if (n.done) return n.value;
    const x = n.value;
    if ('record' in x) on.record(x.record);
    else if ('summary' in x) on.summary(x.summary);
    else if ('clinical' in x) on.clinical(x.clinical);
  }
}
