// Synthetic Apple Health export (no real data): ~1560 Records/day, so 3,650 days come to about 2.2 GB like a real export.xml.
import { cpSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dev = 'device="&lt;&lt;HKDevice: 0x000000000000&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:10.1&gt;"';
const pad = (n: number) => String(n).padStart(2, '0');
const ts = (d: number, m: number) => { const t = new Date(Date.UTC(2016, 0, 1) + d * 864e5 + m * 6e4); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00 -0500`; };
const rec = (type: string, unit: string, value: string | number, d: number, m: number, len = 1) =>
  `  <Record type="${type}" sourceName="Synthetic Watch" sourceVersion="10.1" ${dev} unit="${unit}" creationDate="${ts(d, m + len)}" startDate="${ts(d, m)}" endDate="${ts(d, m + len)}" value="${value}"/>\n`;
const Q = 'HKQuantityTypeIdentifier';

export async function writeAppleExport(dir: string, days: number): Promise<{ records: number; bytes: number }> {
  mkdirSync(dir, { recursive: true });
  const out = createWriteStream(`${dir}/export.xml`);
  const w = (s: string) => out.write(s) || new Promise((r) => out.once('drain', r));
  let records = 0;
  await w('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord)*)>\n]>\n<HealthData locale="en_US">\n');
  await w(` <ExportDate value="${ts(days, 0)}"/>\n <Me HKCharacteristicTypeIdentifierDateOfBirth="1980-01-01"/>\n`);
  for (let d = 0; d < days; d++) {
    let s = '';
    const add = (n: number, f: (i: number) => string) => { for (let i = 0; i < n; i++) s += f(i); records += n; };
    add(700, (i) => rec(`${Q}HeartRate`, 'count/min', 60 + (i % 40), d, 360 + i));
    add(500, (i) => rec(`${Q}ActiveEnergyBurned`, 'kcal', (0.5 + (i % 7) / 10).toFixed(3), d, 360 + i * 2));
    add(150, (i) => rec(`${Q}StepCount`, 'count', 20 + (i % 50), d, 360 + i * 6, 5));
    add(150, (i) => rec(`${Q}DistanceWalkingRunning`, 'mi', (0.01 + (i % 5) / 100).toFixed(4), d, 360 + i * 6, 5));
    add(20, (i) => rec(`${Q}HeartRateVariabilitySDNN`, 'ms', 30 + i, d, 120 + i * 60));
    add(10, (i) => rec(`${Q}OxygenSaturation`, '%', (0.95 + (i % 4) / 100).toFixed(2), d, 60 + i * 30));
    add(1, () => rec(`${Q}BodyMass`, 'lb', (180 + (d % 10) / 2).toFixed(1), d, 420));
    add(1, () => rec(`${Q}BodyFatPercentage`, '%', '0.21', d, 421));
    add(1, () => rec(`${Q}RestingHeartRate`, 'count/min', 58 + (d % 6), d, 1200));
    add(1, () => rec(`${Q}WalkingHeartRateAverage`, 'count/min', 95, d, 1201));
    add(4, (i) => { const [k, v] = [['Core', 120], ['Deep', 60], ['REM', 90], ['Core', 100]][i] as [string, number]; return rec('HKCategoryTypeIdentifierSleepAnalysis', '', `HKCategoryValueSleepAnalysisAsleep${k}`, d, -300 + v, v); });
    s += ` <ActivitySummary dateComponents="${ts(d, 0).slice(0, 10)}" activeEnergyBurned="450" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="Cal" appleExerciseTime="30" appleStandHours="10"/>\n`;
    await w(s);
  }
  await w('</HealthData>\n');
  out.end();
  await new Promise((r) => out.on('finish', r));
  return { records, bytes: out.bytesWritten };
}

// writeAppleExport plus what batching must keep: tests/fixtures/apple's body (BP, a Correlation, a Workout, sleep, rings,
// clinical records) and its ECG, a second ECG with the same Recorded Date, a second steps source, a second ring for day 0
// at the end, and (twoSources) one weight from two sources.
export async function writeAppleTestExport(dir: string, days: number, opts: { twoSources?: boolean } = {}): Promise<void> {
  const fx = `${import.meta.dirname}/../fixtures/apple`;
  await writeAppleExport(dir, days);
  const x = readFileSync(`${fx}/export.xml`, 'utf8');
  const body = x.slice(x.indexOf('\n', x.indexOf('<Me ')) + 1, x.indexOf('</HealthData>'));
  const extra = [
    rec(`${Q}StepCount`, 'count', 9000, 1, 600, 30).replace('Synthetic Watch', 'Synthetic Phone'),
    ...(opts.twoSources ? [rec(`${Q}BodyMass`, 'lb', '180.0', 0, 420).replace('Synthetic Watch', 'Synthetic Scale')] : []),
    ` <ActivitySummary dateComponents="${ts(0, 0).slice(0, 10)}" activeEnergyBurned="300" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="Cal" appleExerciseTime="20" appleStandHours="9"/>\n`,
  ].join('');
  const file = `${dir}/export.xml`;
  writeFileSync(file, readFileSync(file, 'utf8').replace('</HealthData>', `${body}${extra}</HealthData>`));
  cpSync(`${fx}/clinical-records`, `${dir}/clinical-records`, { recursive: true });
  mkdirSync(`${dir}/electrocardiograms`, { recursive: true });
  const ecg = readFileSync(`${fx}/electrocardiograms/ecg_2024-02-11.csv`, 'utf8');
  writeFileSync(`${dir}/electrocardiograms/ecg_2024-02-11.csv`, ecg);
  writeFileSync(`${dir}/electrocardiograms/ecg_2024-02-11_1.csv`, `${ecg}9\n`);
}
