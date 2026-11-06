import { createHash } from 'node:crypto';
import type { Observation } from '@medplum/fhirtypes';
import { APPLE } from '../identity.ts';
import type { AhRecord } from './read.ts';

type Def = { text: string; loinc?: string; ucum: string; category: 'vital-signs' | 'activity'; conv: Record<string, (v: number) => number> };
const r = (n: number, d: number) => Number(n.toFixed(d));
const id = (v: number) => v;
const lb = { lb: (v: number) => r(v * 0.45359237, 3), kg: id };
const pct = { '%': (v: number) => r(v * 100, 2) }; // Apple stores these percents as fractions
const bpm = { 'count/min': id };
const vs = 'vital-signs', act = 'activity';

// Keys are HK type ids without the HKQuantity/CategoryTypeIdentifier prefix.
export const READINGS: Record<string, Def> = {
  BodyMass: { text: 'Body weight', loinc: '29463-7', ucum: 'kg', category: vs, conv: lb },
  BodyMassIndex: { text: 'BMI', loinc: '39156-5', ucum: 'kg/m2', category: vs, conv: { count: id } },
  Height: { text: 'Body height', loinc: '8302-2', ucum: 'cm', category: vs, conv: { cm: id, m: (v) => r(v * 100, 2) } },
  BodyFatPercentage: { text: 'Body fat percentage', loinc: '41982-0', ucum: '%', category: vs, conv: pct },
  OxygenSaturation: { text: 'Oxygen saturation (pulse oximetry)', loinc: '59408-5', ucum: '%', category: vs, conv: pct },
  RestingHeartRate: { text: 'Resting heart rate', loinc: '40443-4', ucum: '/min', category: vs, conv: bpm },
  LeanBodyMass: { text: 'Lean body mass', ucum: 'kg', category: vs, conv: lb },
  WalkingHeartRateAverage: { text: 'Walking heart rate average', ucum: '/min', category: vs, conv: bpm },
  HeartRateRecoveryOneMinute: { text: 'Heart rate recovery, 1 minute', ucum: '/min', category: act, conv: bpm },
  SixMinuteWalkTestDistance: { text: 'Six-minute walk distance (estimated)', ucum: 'm', category: act, conv: { m: id } },
  AppleWalkingSteadiness: { text: 'Walking steadiness', ucum: '%', category: act, conv: pct },
  AppleSleepingWristTemperature: { text: 'Sleeping wrist temperature', ucum: 'Cel', category: vs, conv: { degF: (v) => r(((v - 32) * 5) / 9, 2) } },
  AppleSleepingBreathingDisturbances: { text: 'Sleeping breathing disturbances', ucum: '/h', category: vs, conv: { count: id } },
};
const EVENTS: Record<string, string> = { HighHeartRateEvent: 'High heart rate notification', LowCardioFitnessEvent: 'Low cardio fitness notification' };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (t: string) => t.replace(/^HK(?:Quantity|Category)TypeIdentifier/, '');
const SUBJECT = { reference: 'Patient/apple-patient' };
const UCUM = 'http://unitsofmeasure.org';

function base(rec: AhRecord, key: string, code: Observation['code'], category: string): Observation {
  const o: Observation = {
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: category }] }],
    code,
    subject: SUBJECT,
    device: { display: rec.sourceName },
    identifier: [{ system: APPLE, value: key }],
  };
  if (rec.startDate === rec.endDate) o.effectiveDateTime = rec.startDate;
  else o.effectivePeriod = { start: rec.startDate, end: rec.endDate };
  return o;
}

export class Readings {
  private out = new Map<string, Observation>();
  private bpHalves = new Map<string, { sys?: AhRecord; dia?: AhRecord }>();
  private skips = { sameReadingTwoSources: 0, bpUnpaired: 0, unexpectedUnit: 0 };

  private put(key: string, o: Observation) {
    if (this.out.has(key)) this.skips.sameReadingTwoSources++;
    else this.out.set(key, o);
  }

  add(rec: AhRecord): boolean {
    const t = short(rec.type);
    if (t === 'BloodPressureSystolic' || t === 'BloodPressureDiastolic') {
      if (rec.unit !== 'mmHg' || !Number.isFinite(Number(rec.value))) { this.skips.unexpectedUnit++; return true; }
      const k = `${rec.startDate}|${rec.sourceName}`;
      const h = this.bpHalves.get(k) ?? {};
      h[t === 'BloodPressureSystolic' ? 'sys' : 'dia'] = rec;
      this.bpHalves.set(k, h);
      return true;
    }
    if (EVENTS[t]) {
      const key = sha(`${t}|${rec.startDate}|${rec.endDate}|${rec.value ?? ''}|`);
      const o = base(rec, key, { text: EVENTS[t] }, vs);
      if (rec.value !== undefined) o.valueString = rec.value;
      this.put(key, o);
      return true;
    }
    const def = READINGS[t];
    if (!def) return false;
    const conv = rec.unit ? def.conv[rec.unit] : undefined;
    const raw = Number(rec.value);
    if (!conv || rec.value === undefined || rec.value === '' || !Number.isFinite(raw)) { this.skips.unexpectedUnit++; return true; }
    const key = sha(`${t}|${rec.startDate}|${rec.endDate}|${rec.value}|${rec.unit}`);
    const code: Observation['code'] = { text: def.text };
    if (def.loinc) code.coding = [{ system: 'http://loinc.org', code: def.loinc }];
    const o = base(rec, key, code, def.category);
    o.valueQuantity = { value: conv(raw), unit: def.ucum, system: UCUM, code: def.ucum };
    this.put(key, o);
    return true;
  }

  result(): { resources: Observation[]; skips: { sameReadingTwoSources: number; bpUnpaired: number; unexpectedUnit: number } } {
    for (const { sys, dia } of this.bpHalves.values()) {
      if (!sys || !dia) { this.skips.bpUnpaired++; continue; }
      const key = sha(`BP|${sys.startDate}|${sys.endDate}|${sys.value}|${dia.value}`);
      const o = base(sys, key, { coding: [{ system: 'http://loinc.org', code: '85354-9' }], text: 'Blood pressure panel' }, vs);
      const comp = (code: string, text: string, v: string) => ({ code: { coding: [{ system: 'http://loinc.org', code }], text }, valueQuantity: { value: Number(v), unit: 'mm[Hg]', system: UCUM, code: 'mm[Hg]' } });
      o.component = [comp('8480-6', 'Systolic blood pressure', sys.value!), comp('8462-4', 'Diastolic blood pressure', dia.value!)];
      this.put(key, o);
    }
    this.bpHalves.clear();
    return { resources: [...this.out.values()], skips: { ...this.skips } };
  }
}
