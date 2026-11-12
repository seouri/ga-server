import type { Observation } from '@medplum/fhirtypes';
import { APPLE, sha256 as sha } from '../identity.ts';
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

export const short = (t: string) => t.replace(/^HK(?:Quantity|Category)TypeIdentifier/, '');
export const SUBJECT = { reference: 'Patient/apple-patient' };
export const UCUM = 'http://unitsofmeasure.org';

export const OFFSET = /[+-]\d\d:\d\d$/;
const minutes = (off: string) => (off[0] === '-' ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
// An instant as Apple writes it (appleDate's text, whole seconds) in the offset `off`.
export const written = (ms: number, off: string) => `${new Date(ms + minutes(off) * 60000).toISOString().slice(0, 19)}${off}`;
export const zone = (m: number) => `${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
// The text rewritten by `to(ms, its offset)`; kept as written when it is no instant Apple's text rebuilds (an impossible date such as Feb 30).
const recast = (text: string, to: (ms: number, off: string) => string) => {
  const ms = Date.parse(text), off = OFFSET.exec(text)?.[0];
  return Number.isFinite(ms) && off && written(ms, off) === text ? to(ms, off) : text;
};

// Identifier values older imports gave a record: they keyed it on its time as written. The offset Apple writes is not tied to the
// reading (one export mixes -05:00 and -04:00 on summer dates), so a later export may write the same reading in another one. The importer looks these up when the instant key misses.
export const LEGACY = new WeakMap<object, string[]>();
// Keys o on its instants (UTC) and records the keys older imports may hold it under: its time as this export writes it, and an hour
// either side (the same reading written in the other DST offset). `text(at)` builds the key text, passing each timestamp through `at`.
// shortcut: older exports taken in another zone (abroad) or a DST step other than an hour are not matched; their readings come in once more.
export function keyed<T extends { identifier?: Observation['identifier'] }>(o: T, text: (at: (t: string) => string) => string): string {
  const value = sha(text((t) => recast(t, (ms) => new Date(ms).toISOString())));
  const shifted = (d: number) => text((t) => recast(t, (ms, off) => written(ms, zone(minutes(off) + d))));
  LEGACY.set(o, [text((t) => t), shifted(-60), shifted(60)].map(sha).filter((v) => v !== value));
  o.identifier = [{ system: APPLE, value }];
  return value;
}

function base(rec: AhRecord, code: Observation['code'], category: string): Observation {
  const o: Observation = {
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: category }] }],
    code,
    subject: SUBJECT,
    device: { display: rec.sourceName },
  };
  if (rec.startDate === rec.endDate) o.effectiveDateTime = rec.startDate;
  else o.effectivePeriod = { start: rec.startDate, end: rec.endDate };
  return o;
}

// Each reading goes to `emit` as soon as it is read (first source wins), blood pressure at result(): a later half of the
// same reading replaces an earlier one, so a pair is only final once the export is read. Without `emit`, result() returns them all.
export class Readings {
  private out: Observation[] = [];
  private seen = new Set<string>();
  private bpHalves = new Map<string, { sys?: AhRecord; dia?: AhRecord }>();
  private skips = { sameReadingTwoSources: 0, bpUnpaired: 0, unexpectedUnit: 0 };
  private emit: (o: Observation) => void;
  constructor(emit?: (o: Observation) => void) { this.emit = emit ?? ((o) => this.out.push(o)); }

  private put(key: string, o: Observation) {
    if (this.seen.has(key)) this.skips.sameReadingTwoSources++;
    else { this.seen.add(key); this.emit(o); }
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
      const o = base(rec, { text: EVENTS[t] }, vs);
      if (rec.value !== undefined) o.valueString = rec.value;
      this.put(keyed(o, (at) => `${t}|${at(rec.startDate)}|${at(rec.endDate)}|${rec.value ?? ''}|`), o);
      return true;
    }
    const def = READINGS[t];
    if (!def) return false;
    const conv = rec.unit ? def.conv[rec.unit] : undefined;
    const raw = Number(rec.value);
    if (!conv || rec.value === undefined || rec.value === '' || !Number.isFinite(raw)) { this.skips.unexpectedUnit++; return true; }
    const code: Observation['code'] = { text: def.text };
    if (def.loinc) code.coding = [{ system: 'http://loinc.org', code: def.loinc }];
    const o = base(rec, code, def.category);
    o.valueQuantity = { value: conv(raw), unit: def.ucum, system: UCUM, code: def.ucum };
    this.put(keyed(o, (at) => `${t}|${at(rec.startDate)}|${at(rec.endDate)}|${rec.value}|${rec.unit}`), o);
    return true;
  }

  result(): { resources: Observation[]; skips: { sameReadingTwoSources: number; bpUnpaired: number; unexpectedUnit: number } } {
    for (const { sys, dia } of this.bpHalves.values()) {
      if (!sys || !dia) { this.skips.bpUnpaired++; continue; }
      const o = base(sys, { coding: [{ system: 'http://loinc.org', code: '85354-9' }], text: 'Blood pressure panel' }, vs);
      const comp = (code: string, text: string, v: string) => ({ code: { coding: [{ system: 'http://loinc.org', code }], text }, valueQuantity: { value: Number(v), unit: 'mm[Hg]', system: UCUM, code: 'mm[Hg]' } });
      o.component = [comp('8480-6', 'Systolic blood pressure', sys.value!), comp('8462-4', 'Diastolic blood pressure', dia.value!)];
      this.put(keyed(o, (at) => `BP|${at(sys.startDate)}|${at(sys.endDate)}|${sys.value}|${dia.value}`), o);
    }
    this.bpHalves.clear();
    return { resources: this.out, skips: { ...this.skips } };
  }
}
