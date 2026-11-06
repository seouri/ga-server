import type { Observation, ObservationComponent } from '@medplum/fhirtypes';
import { APPLE } from '../identity.ts';
import type { AhRecord, AhSummary } from './read.ts';
import { SUBJECT, UCUM, sha, short } from './readings.ts';

const r = (n: number, d: number) => Number(n.toFixed(d));
const q = (value: number, code: string) => ({ value, unit: code, system: UCUM, code });
const MI = 1.609344;
const id = (v: number) => v;
const comp = (text: string, v: number, u: string): ObservationComponent => ({ code: { text }, valueQuantity: q(v, u) });

const RATES: Record<string, { text: string; ucum: string; unit: string }> = {
  HeartRate: { text: 'Heart rate, daily mean (Apple Health)', ucum: '/min', unit: 'count/min' },
  HeartRateVariabilitySDNN: { text: 'Heart rate variability SDNN, daily mean (Apple Health)', ucum: 'ms', unit: 'ms' },
  RespiratoryRate: { text: 'Respiratory rate, daily mean (Apple Health)', ucum: '/min', unit: 'count/min' },
};
const TOTALS: Record<string, { text: string; loinc?: string; ucum: string; conv: Record<string, (v: number) => number> }> = {
  StepCount: { text: 'Steps, daily total (Apple Health)', loinc: '41950-7', ucum: '{steps}', conv: { count: id } },
  DistanceWalkingRunning: { text: 'Walking + running distance, daily total (Apple Health)', ucum: 'km', conv: { mi: (v) => v * MI, km: id } },
  DistanceCycling: { text: 'Cycling distance, daily total (Apple Health)', ucum: 'km', conv: { mi: (v) => v * MI, km: id } },
  FlightsClimbed: { text: 'Flights climbed, daily total (Apple Health)', ucum: '{flights}', conv: { count: id } },
};
const STAGES: Record<string, string> = { Core: 'Core sleep', Deep: 'Deep sleep', REM: 'REM sleep', Unspecified: 'Unspecified sleep', '': 'Unspecified sleep' };
const GAP = 3 * 3600e3;

type Iv = { s: number; e: number; sStr: string; eStr: string; src: string; stage: string };
const merge = (ivs: { s: number; e: number }[]) => {
  const out: { s: number; e: number }[] = [];
  for (const i of [...ivs].sort((a, b) => a.s - b.s)) {
    const l = out[out.length - 1];
    if (l && i.s <= l.e) l.e = Math.max(l.e, i.e); else out.push({ s: i.s, e: i.e });
  }
  return out;
};
const minutes = (ivs: { s: number; e: number }[]) => merge(ivs).reduce((a, i) => a + (i.e - i.s), 0) / 60000;
const offsetOf = (iso: string) => iso.slice(-6);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);

export class Daily {
  private rates = new Map<string, { kind: string; day: string; off: string; sum: number; min: number; max: number; n: number }>();
  // shortcut: largest single source per day approximates Apple's source-priority merge; upgrade to interval merge if totals look wrong
  private totals = new Map<string, { kind: string; day: string; off: string; bySrc: Map<string, number> }>();
  private asleep: Iv[] = [];
  private inBed: Iv[] = [];
  private rings: Observation[] = [];
  private skips = { activityEmptyDays: 0, unexpectedUnit: 0, badValue: 0 };

  private obs(key: string, code: Observation['code'], day: string, off: string): Observation {
    return {
      resourceType: 'Observation', status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'activity' }] }],
      code, subject: SUBJECT, identifier: [{ system: APPLE, value: sha(`daily|${key}|${day}`) }],
      effectivePeriod: { start: `${day}T00:00:00${off}`, end: `${nextDay(day)}T00:00:00${off}` },
    };
  }

  add(rec: AhRecord): boolean {
    const t = short(rec.type);
    const day = rec.startDate.slice(0, 10);
    if (t === 'SleepAnalysis') {
      const m = /SleepAnalysis(InBed|Awake|Asleep)(\w*)$/.exec(rec.value ?? '');
      if (!m || m[1] === 'Awake') return true;
      const iv = { s: Date.parse(rec.startDate), e: Date.parse(rec.endDate), sStr: rec.startDate, eStr: rec.endDate, src: rec.sourceName, stage: m[2] };
      (m[1] === 'InBed' ? this.inBed : this.asleep).push(iv);
      return true;
    }
    const rate = RATES[t], tot = TOTALS[t];
    if (!rate && !tot) return false;
    const v = Number(rec.value);
    if (rec.value === undefined || rec.value === '' || !Number.isFinite(v)) { this.skips.badValue++; return true; }
    const k = `${t}|${day}`;
    if (rate) {
      if (rec.unit !== rate.unit) { this.skips.unexpectedUnit++; return true; }
      const a = this.rates.get(k);
      if (a) { a.sum += v; a.n++; a.min = Math.min(a.min, v); a.max = Math.max(a.max, v); }
      else this.rates.set(k, { kind: t, day, off: offsetOf(rec.startDate), sum: v, min: v, max: v, n: 1 });
    } else {
      const conv = rec.unit ? tot.conv[rec.unit] : undefined;
      if (!conv) { this.skips.unexpectedUnit++; return true; }
      const a = this.totals.get(k) ?? { kind: t, day, off: offsetOf(rec.startDate), bySrc: new Map() };
      a.bySrc.set(rec.sourceName, (a.bySrc.get(rec.sourceName) ?? 0) + conv(v));
      this.totals.set(k, a);
    }
    return true;
  }

  summary(s: AhSummary): void {
    const kcal = s.activeEnergyBurned ?? 0, ex = s.appleExerciseTime ?? 0, st = s.appleStandHours ?? 0;
    if (kcal === 0 && ex === 0 && st === 0 && (s.activeEnergyBurnedGoal ?? 0) === 0) { this.skips.activityEmptyDays++; return; }
    if (s.activeEnergyBurnedUnit !== 'Cal' && s.activeEnergyBurnedUnit !== 'kcal') { this.skips.unexpectedUnit++; return; }
    const o = this.obs('activity', { text: 'Activity rings, daily (Apple Health)' }, s.date, '');
    delete o.effectivePeriod; // ActivitySummary carries no offset
    o.effectiveDateTime = s.date;
    o.component = [comp('Active energy burned', kcal, 'kcal'), comp('Exercise minutes', ex, 'min'), comp('Stand hours', st, 'h')];
    this.rings.push(o);
  }

  private sleep(): Observation[] {
    const out: Observation[] = [];
    const sorted = [...this.asleep].sort((a, b) => a.s - b.s);
    const clusters: Iv[][] = [];
    let end = -Infinity;
    for (const i of sorted) {
      if (clusters.length && i.s - end < GAP) clusters[clusters.length - 1].push(i); else clusters.push([i]);
      end = Math.max(end, i.e);
    }
    const ends = clusters.map((c) => Math.max(...c.map((i) => i.e)));
    for (const [n, c] of clusters.entries()) {
      const first = c[0], last = c.reduce((a, b) => (b.e > a.e ? b : a));
      const wake = last.eStr.slice(0, 10);
      const o = this.obs('sleep', { text: 'Sleep, nightly (Apple Health)' }, wake, '');
      o.identifier = [{ system: APPLE, value: sha(`daily|sleep|${first.sStr}`) }]; // wake day can repeat (naps)
      o.effectivePeriod = { start: first.sStr, end: last.eStr };
      o.valueQuantity = q(r(minutes(c), 1), 'min');
      const bySrc = new Map<string, number>();
      for (const i of c) bySrc.set(i.src, (bySrc.get(i.src) ?? 0) + (i.e - i.s));
      const dom = [...bySrc.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const comps: ObservationComponent[] = [];
      for (const [stage, text] of Object.entries(STAGES)) {
        if (stage === '') continue;
        const mins = minutes(c.filter((i) => i.src === dom && (i.stage === stage || (stage === 'Unspecified' && i.stage === ''))));
        if (mins) comps.push({ code: { text }, valueQuantity: q(r(mins, 1), 'min') });
      }
      const cs = Math.min(...c.map((i) => i.s)), ce = last.e;
      // clip InBed to this cluster's share: out to the midpoint of the gap to each neighbouring cluster, so an InBed spanning a night keeps its full length but is never counted twice
      const lo = n ? (ends[n - 1] + cs) / 2 : -Infinity, hi = n < clusters.length - 1 ? (ce + clusters[n + 1][0].s) / 2 : Infinity;
      const bed = this.inBed.filter((i) => i.s < hi && i.e > lo && i.s < ce && i.e > cs).map((i) => ({ s: Math.max(i.s, lo), e: Math.min(i.e, hi) }));
      if (bed.length) comps.push({ code: { text: 'In bed' }, valueQuantity: q(r(minutes(bed), 1), 'min') });
      if (comps.length) o.component = comps;
      out.push(o);
    }
    return out;
  }

  result(): { resources: Observation[]; skips: { activityEmptyDays: number; unexpectedUnit: number; badValue: number } } {
    const out: Observation[] = [];
    for (const a of this.rates.values()) {
      const d = RATES[a.kind];
      const o = this.obs(a.kind, { text: d.text }, a.day, a.off);
      o.valueQuantity = q(r(a.sum / a.n, 1), d.ucum);
      o.component = [comp('Minimum', a.min, d.ucum), comp('Maximum', a.max, d.ucum), comp('Sample count', a.n, '1')];
      out.push(o);
    }
    for (const a of this.totals.values()) {
      const d = TOTALS[a.kind];
      const code: Observation['code'] = { text: d.text };
      if (d.loinc) code.coding = [{ system: 'http://loinc.org', code: d.loinc }];
      const o = this.obs(a.kind, code, a.day, a.off);
      o.valueQuantity = q(r(Math.max(...a.bySrc.values()), 3), d.ucum);
      out.push(o);
    }
    return { resources: [...out, ...this.rings, ...this.sleep()], skips: { ...this.skips } };
  }
}
