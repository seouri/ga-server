import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Readings } from '../src/apple/readings.ts';
import type { AhClinical, AhRecord } from '../src/apple/read.ts';
import { mapClinical, mapEcgs } from '../src/apple/clinical.ts';
import { APPLE, sha256 } from '../src/identity.ts';

const q = (t: string) => `HKQuantityTypeIdentifier${t}`;
const rec = (type: string, value: string, unit: string, sourceName = 'Phone', d = '2026-01-02T08:00:00-05:00'): AhRecord => ({ type: q(type), value, unit, sourceName, startDate: d, endDate: d });
const run = (...rs: AhRecord[]) => { const r = new Readings(); for (const x of rs) r.add(x); return r.result(); };

describe('Apple readings', () => {
  it('maps weight', () => {
    const { resources: [o] } = run(rec('BodyMass', '79', 'kg'));
    expect(o.code.coding![0].code).toBe('29463-7');
    expect(o.valueQuantity).toMatchObject({ value: 79, code: 'kg' });
    expect(o.device!.display).toBe('Phone');
    expect(o.identifier![0].system).toBe(APPLE);
    expect(o.identifier![0].value).toMatch(/^[0-9a-f]{64}$/);
  });
  it('converts units', () => {
    expect(run(rec('BodyMass', '174', 'lb')).resources[0].valueQuantity!.value).toBe(78.925);
    expect(run(rec('BodyFatPercentage', '0.21', '%')).resources[0].valueQuantity).toMatchObject({ value: 21, code: '%' });
    expect(run(rec('AppleSleepingWristTemperature', '95', 'degF')).resources[0].valueQuantity!.value).toBe(35);
    expect(run(rec('BodyMassIndex', '24', 'count')).resources[0].valueQuantity!.code).toBe('kg/m2');
    expect(run(rec('Height', '1.8', 'm')).resources[0].valueQuantity!.value).toBe(180);
  });
  it('skips unexpected units', () => {
    const r = run(rec('BodyMass', '79', 'stone'));
    expect(r.resources).toHaveLength(0);
    expect(r.skips.unexpectedUnit).toBe(1);
  });
  it('merges same reading from two sources; rename keeps key', () => {
    const r = run(rec('BodyMass', '79', 'kg', 'A'), rec('BodyMass', '79', 'kg', 'B'));
    expect(r.resources).toHaveLength(1);
    expect(r.skips.sameReadingTwoSources).toBe(1);
    expect(run(rec('BodyMass', '79', 'kg', 'A')).resources[0].identifier).toEqual(run(rec('BodyMass', '79', 'kg', 'Z')).resources[0].identifier);
  });
  it('pairs blood pressure', () => {
    const r = run(rec('BloodPressureSystolic', '120', 'mmHg'), rec('BloodPressureDiastolic', '80', 'mmHg'), rec('BloodPressureSystolic', '130', 'mmHg', 'Phone', '2026-01-03T08:00:00-05:00'));
    expect(r.resources).toHaveLength(1);
    expect(r.resources[0].component!.map((c) => c.valueQuantity!.value)).toEqual([120, 80]);
    expect(r.skips.bpUnpaired).toBe(1);
  });
  it('maps events and rejects unknown types', () => {
    const r = new Readings();
    expect(r.add(rec('Nope', '1', 'x'))).toBe(false);
    expect(r.add({ type: 'HKCategoryTypeIdentifierHighHeartRateEvent', value: 'HKCategoryValueNotApplicable', sourceName: 'W', startDate: '2026-01-02T08:00:00-05:00', endDate: '2026-01-02T08:00:00-05:00' })).toBe(true);
    expect(r.result().resources[0].valueString).toBe('HKCategoryValueNotApplicable');
  });
});

import { Daily } from '../src/apple/daily.ts';
import { readExport } from '../src/apple/read.ts';

const hk = (t: string, value: string, unit: string | undefined, sourceName: string, s: string, e = s): AhRecord => ({ type: `HKQuantityTypeIdentifier${t}`, value, unit, sourceName, startDate: s, endDate: e });
const sl = (v: string, sourceName: string, s: string, e: string): AhRecord => ({ type: 'HKCategoryTypeIdentifierSleepAnalysis', value: `HKCategoryValueSleepAnalysis${v}`, sourceName, startDate: s, endDate: e });
const daily = (rs: AhRecord[], sums: Parameters<Daily['summary']>[0][] = []) => { const d = new Daily('America/New_York'); for (const x of rs) d.add(x); for (const s of sums) d.summary(s); return d.result(); };
const comp = (o: { component?: { code: { text?: string }; valueQuantity?: { value?: number } }[] }, t: string) => o.component!.find((c) => c.code.text === t)?.valueQuantity?.value;

describe('Apple daily', () => {
  it('heart rate daily mean', () => {
    const { resources: [o] } = daily(['08', '09', '10'].map((h, i) => hk('HeartRate', String(60 + 20 * i), 'count/min', 'W', `2026-03-01T${h}:00:00-05:00`)));
    expect(o.valueQuantity).toMatchObject({ value: 80, code: '/min' });
    expect(comp(o, 'Minimum')).toBe(60); expect(comp(o, 'Maximum')).toBe(100); expect(comp(o, 'Sample count')).toBe(3);
    expect(o.effectivePeriod).toEqual({ start: '2026-03-01T00:00:00-05:00', end: '2026-03-02T00:00:00-05:00' });
    expect(o.code.coding).toBeUndefined();
    expect(o.device).toBeUndefined();
  });
  it('steps use the largest source; two offsets make one day', () => {
    const { resources: [o], skips } = daily([
      hk('StepCount', '4000', 'count', 'Watch', '2026-03-01T09:00:00-05:00'),
      hk('StepCount', '3000', 'count', 'Watch', '2026-03-01T20:00:00-08:00'),
      hk('StepCount', '5000', 'count', 'Phone', '2026-03-01T12:00:00-05:00'),
    ]);
    expect(o.valueQuantity).toMatchObject({ value: 7000, code: '{steps}' });
    expect(o.code.coding![0].code).toBe('41950-7');
    expect(skips.activityEmptyDays).toBe(0);
  });
  it('days follow the user time zone, DST included, not the export offset', () => {
    // Apple writes -05:00 all year: 23:30-05:00 on Jul 4 is 00:30 EDT on Jul 5.
    const [j] = daily([hk('HeartRate', '60', 'count/min', 'W', '2026-07-04T23:30:00-05:00')]).resources;
    expect(j.effectivePeriod).toEqual({ start: '2026-07-05T00:00:00-04:00', end: '2026-07-06T00:00:00-04:00' });
    // US fall back, 2026-11-01: the day starts in EDT and ends in EST.
    const [o] = daily([
      hk('HeartRate', '70', 'count/min', 'W', '2026-11-01T22:00:00-05:00'),
      hk('HeartRate', '60', 'count/min', 'W', '2026-11-01T00:30:00-04:00'),
    ]).resources;
    expect(o.effectivePeriod).toEqual({ start: '2026-11-01T00:00:00-04:00', end: '2026-11-02T00:00:00-05:00' });
    const [s] = daily([hk('StepCount', '10', 'count', 'W', '2026-03-08T09:00:00-04:00'), hk('StepCount', '10', 'count', 'W', '2026-03-08T01:00:00-05:00')]).resources;
    expect(s.effectivePeriod).toEqual({ start: '2026-03-08T00:00:00-05:00', end: '2026-03-09T00:00:00-04:00' });
  });
  it('converts miles and skips bad units', () => {
    const r = daily([hk('DistanceWalkingRunning', '1', 'mi', 'W', '2026-03-01T09:00:00-05:00'), hk('FlightsClimbed', '3', 'furlong', 'W', '2026-03-01T09:00:00-05:00')]);
    expect(r.resources).toHaveLength(1);
    expect(r.resources[0].valueQuantity).toMatchObject({ value: 1.609, code: 'km' });
    expect(r.skips.unexpectedUnit).toBe(1);
  });
  it('fixture sleep and rings', async () => {
    const d = new Daily('America/New_York');
    await readExport('tests/fixtures/apple', { record: (r) => { d.add(r); }, summary: (s) => d.summary(s), clinical: () => {} });
    const { resources, skips } = d.result();
    const sleep = resources.find((o) => o.code.text === 'Sleep, nightly (Apple Health)')!;
    expect(sleep.valueQuantity).toMatchObject({ value: 240, code: 'min' });
    expect(comp(sleep, 'Deep sleep')).toBe(60);
    expect(comp(sleep, 'In bed')).toBe(480);
    expect(sleep.effectivePeriod!.start).toBe('2026-03-01T23:00:00-05:00');
    const rings = resources.filter((o) => o.code.text === 'Activity rings, daily (Apple Health)');
    expect(rings).toHaveLength(1);
    expect(rings[0].component).toHaveLength(3);
    expect(skips.activityEmptyDays).toBe(1);
    expect(resources.filter((o) => o.code.text === 'Sleep, nightly (Apple Health)')[0].effectivePeriod!.end).toBe('2026-03-02T03:00:00-05:00');
  });
  // An impossible date (a hand-edited export) keeps the text and identifier the importer wrote before sleep times became instants.
  it('an impossible sleep date keeps its written text and identifier', () => {
    const [o] = daily([sl('AsleepCore', 'W', '2020-02-30T23:00:00-05:00', '2020-02-31T06:00:00-05:00')]).resources;
    expect(o.identifier![0].value).toBe(sha256('daily|sleep|2020-02-30T23:00:00-05:00'));
    expect(o.effectivePeriod).toEqual({ start: '2020-02-30T23:00:00-05:00', end: '2020-02-31T06:00:00-05:00' });
  });
  it('is deterministic and splits nights by 3h gap', () => {
    const rs = [sl('AsleepCore', 'W', '2026-03-01T23:00:00-05:00', '2026-03-02T02:00:00-05:00'), sl('AsleepREM', 'W', '2026-03-02T06:00:00-05:00', '2026-03-02T07:00:00-05:00')];
    const a = daily(rs).resources, b = daily(rs).resources;
    expect(a.map((o) => o.identifier![0].value)).toEqual(b.map((o) => o.identifier![0].value));
    expect(a).toHaveLength(2);
    expect(new Set(a.map((o) => o.identifier![0].value)).size).toBe(2);
  });
  it('splits one InBed spanning a nap and a night without double counting', () => {
    const { resources } = daily([
      hk('x', '', undefined, 'P', '2026-03-01T00:00:00-05:00'), // ignored type
      sl('InBed', 'P', '2026-03-01T13:00:00-05:00', '2026-03-02T07:00:00-05:00'),
      sl('AsleepCore', 'W', '2026-03-01T13:00:00-05:00', '2026-03-01T14:00:00-05:00'),
      sl('AsleepCore', 'W', '2026-03-01T23:00:00-05:00', '2026-03-02T06:00:00-05:00'),
    ]);
    const beds = resources.map((o) => comp(o, 'In bed'));
    expect(beds.reduce((a, b) => a! + b!, 0)).toBe(18 * 60);
    expect(beds.every((b) => b! < 18 * 60)).toBe(true);
  });
  it('counts a missing value as badValue', () => {
    expect(daily([hk('StepCount', '', 'count', 'W', '2026-03-01T09:00:00-05:00')]).skips).toMatchObject({ badValue: 1, unexpectedUnit: 0 });
  });
});

describe('Apple clinical records and ECG', () => {
  const dir = new URL('./fixtures/apple', import.meta.url).pathname;
  const ref = (_type: string, file: string, fhirVersion: string, sourceURL = ''): AhClinical => ({ sourceURL, fhirVersion, resourceFilePath: `/clinical-records/${file}` });
  const refs = [
    ref('Patient', 'Patient-A.json', '4.0.1'),
    ref('AllergyIntolerance', 'AllergyIntolerance-B.json', '4.0.1', 'https://fhir.example.org/R4/AllergyIntolerance/a1'),
    ref('Observation', 'Observation-C.json', '1.0.2'),
  ];
  it('maps patient, allergy, counts unsupported', () => {
    const { resources: [p, a], skips } = mapClinical(dir, refs);
    expect(p).toEqual({ resourceType: 'Patient', id: 'apple-patient', identifier: expect.any(Array) });
    expect((p as any).identifier).toHaveLength(2);
    expect(a.id).toBeUndefined();
    expect((a as any).patient).toEqual({ reference: 'Patient/apple-patient', display: 'Test Person' });
    expect((a as any).recorder).toEqual({ display: 'Dr. Example' });
    expect((a as any).identifier[0]).toEqual({ system: APPLE, value: 'https://fhir.example.org/R4/AllergyIntolerance/a1' });
    expect(skips).toEqual({ clinicalTypeUnsupported: 1, clinicalUnreadable: 0 });
  });
  it('maps ECG without PHI', () => {
    const [d, o] = mapEcgs(dir).resources as any[];
    expect(o.valueString).toBe('Sinus Rhythm');
    expect(o.effectiveDateTime).toBe('2024-02-11T14:48:35-05:00');
    expect(o.derivedFrom[0].reference).toBe(`DocumentReference/${d.id}`);
    expect(Buffer.from(d.content[0].attachment.data, 'base64').toString()).toBe(readFileSync(`${dir}/electrocardiograms/ecg_2024-02-11.csv`, 'utf8'));
    expect(d.identifier[0].system).toBe(APPLE);
    expect(JSON.stringify(o)).not.toMatch(/Test Person|Jan 1, 1970/);
  });
  it('counts unreadable files, merges patients, drops display-less refs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ah-'));
    mkdirSync(join(tmp, 'clinical-records'));
    const w = (f: string, o: unknown) => writeFileSync(join(tmp, 'clinical-records', f), typeof o === 'string' ? o : JSON.stringify(o));
    w('p1.json', { resourceType: 'Patient', identifier: [{ system: 's', value: '1' }] });
    w('p2.json', { resourceType: 'Patient', identifier: [{ system: 's', value: '1' }, { system: 's', value: '2' }] });
    w('bad.json', '{nope');
    w('al.json', { resourceType: 'AllergyIntolerance', recorder: { reference: 'Practitioner/x' }, patient: { reference: 'Patient/p' } });
    const { resources, skips } = mapClinical(tmp, [ref('Patient', 'p1.json', '4.0.1'), ref('Patient', 'p2.json', '4.0.1'), ref('X', 'bad.json', '4.0.1'), ref('X', 'missing.json', '4.0.1'), ref('AllergyIntolerance', 'al.json', '4.0.1', 'u')]);
    expect(resources.filter((r) => r.resourceType === 'Patient')).toEqual([{ resourceType: 'Patient', id: 'apple-patient', identifier: [{ system: 's', value: '1' }, { system: 's', value: '2' }] }]);
    expect(skips.clinicalUnreadable).toBe(2);
    expect('recorder' in (resources[1] as any)).toBe(false);
    expect(mapClinical(tmp, []).resources).toEqual([]);
  });
  it('counts malformed ECG, tolerates missing folder', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ah-'));
    expect(mapEcgs(tmp)).toEqual({ resources: [], skips: { ecgUnparsed: 0 } });
    mkdirSync(join(tmp, 'electrocardiograms'));
    writeFileSync(join(tmp, 'electrocardiograms', 'x.csv'), 'Name,A\nClassification,Sinus Rhythm\n\n1\n');
    expect(mapEcgs(tmp)).toEqual({ resources: [], skips: { ecgUnparsed: 1 } });
  });
});
