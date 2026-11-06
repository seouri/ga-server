import { describe, expect, it } from 'vitest';
import { Readings } from '../src/apple/readings.ts';
import type { AhRecord } from '../src/apple/read.ts';
import { APPLE } from '../src/identity.ts';

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
