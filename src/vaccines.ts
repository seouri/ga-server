// Adult vaccination gaps against a shipped, versioned CDC schedule (src/schedules/cdc-adult-immunization-<year>.json).
// Routine age/sex/birth-year rules only; anything the schedule leaves to risk factors, products or shared
// clinical decision-making is reported as not-evaluated with the schedule's own words.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Immunization, Observation, Patient } from '@medplum/fhirtypes';
import { GaError } from './config.ts';

type Match = { cvx: string[]; names: string[] };
type Rule = {
  ages: [number, number | null];
  sex?: 'male' | 'female';
  born?: [number | null, number | null]; // birth-year bounds, inclusive
  doses?: number;
  intervalMonths?: number; // next dose of an unfinished series is overdue after this
  repeatYears?: number; // booster interval (Td/Tdap)
  seasonal?: boolean; // one dose per Aug 1 - Jul 31 season
  status?: 'not-evaluated' | 'not-recommended'; // forced, with the schedule's quote in reason
  dueIfNone?: boolean; // a forced not-evaluated rule is still due when no dose is recorded
  completeIf?: Match & { reason: string }; // any such dose completes it (PCV20/PCV21)
  altDoses?: Match & { doses: number }; // dose count when every dose is this product (Heplisav-B)
  requireOne?: Match & { reason: string }; // at least one dose must be this product (Tdap), else due
  reason?: string;
};
export type Schedule = {
  edition: string;
  sourceUrl: string;
  notEvaluated: string[];
  vaccines: { id: string; name: string; cvx: string[]; names: string[]; excludeNames?: string[]; rules: Rule[]; immuneIf?: { loinc?: string[]; names: string[]; positive: string[]; all?: boolean } }[];
};
type Dose = { date: string; cvx?: string; name?: string; source: string };
type Evidence = { name: string; value: string; date: string; source: string };
// sex is absent when GA's gender is neither male nor female: sex-specific rules (none in the 2025 schedule) then never apply.
export type VaccineInput = { birthDate: string; sex?: 'male' | 'female'; immunizations: Dose[]; immunity: Evidence[] };
type Status = 'complete' | 'due' | 'overdue' | 'not-recommended' | 'immune' | 'not-evaluated';
type Ref = { date: string; source: string };

const DIR = join(import.meta.dirname, 'schedules');
// Newest edition wins: file names carry the year.
export function loadSchedule(): Schedule {
  const file = readdirSync(DIR).filter((f) => /^cdc-adult-immunization-\d{4}\.json$/.test(f)).sort().at(-1);
  if (!file) throw new GaError('no CDC adult immunization schedule in src/schedules');
  return JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Schedule;
}

// "PCV-20", "PCV 20" and "pcv20" all become "pcv20"; aliases get the same treatment but keep their edge spaces (" td ").
const squash = (s = '') => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/([a-z]) (?=\d)/g, '$1');
const norm = (s = '') => ` ${squash(s).trim()} `;
const has = (name: string, alias: string) => name.includes(squash(alias));
const cvxNorm = (c = '') => c.trim().replace(/^0+(?=\d)/, '');
const hits = (m: Match, d: Dose) => (d.cvx !== undefined && m.cvx.some((c) => cvxNorm(c) === cvxNorm(d.cvx))) || m.names.some((n) => has(norm(d.name), n));
const NEGATED = /\bnon|\bnot\b|\bneg|\bno\b|equivocal|indeterminate|unknown|uncertain|borderline|\blow\b|insufficient/;
// A bare disease name (Measles, VZV) also names infection tests (IgM, PCR): immunity needs an antibody term; IgM never counts.
const BARE = new Set(['measles', 'mumps', 'rubella', 'varicella', 'vzv']);
const ANTIBODY = /\b(antibod\w*|ab|igg|immun\w*|titer|titre)\b/;
const addMonths = (date: string, n: number) => {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const addDays = (date: string, n: number) => new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const ageOn = (birth: string, asOf: string) => Number(asOf.slice(0, 4)) - Number(birth.slice(0, 4)) - (asOf.slice(5, 10) < birth.slice(5, 10) ? 1 : 0);

export function evaluateVaccines(schedule: Schedule, input: VaccineInput, asOf: string) {
  const day = asOf.slice(0, 10);
  const age = ageOn(input.birthDate, day);
  const born = Number(input.birthDate.slice(0, 4));
  // CVX codes are exact (a combo code counts for each of its vaccines); a name must point to exactly one vaccine.
  const byVaccine = new Map<string, Dose[]>();
  const unmatched: Dose[] = [];
  // Nothing after asOf counts: the answer is "as of" that day.
  const immunity = input.immunity.filter((e) => e.date.slice(0, 10) <= day);
  for (const d of input.immunizations.filter((x) => x.date.slice(0, 10) <= day)) {
    const byCvx = d.cvx === undefined ? [] : schedule.vaccines.filter((v) => v.cvx.some((c) => cvxNorm(c) === cvxNorm(d.cvx)));
    const n = norm(d.name);
    const byName = schedule.vaccines.filter((v) => v.names.some((a) => has(n, a)) && !v.excludeNames?.some((x) => has(n, x)));
    const vs = byCvx.length ? byCvx : byName.length === 1 && d.name ? byName : [];
    if (!vs.length || !d.date) {
      unmatched.push(d); // a dose without a date can't be placed in a series
      continue;
    }
    for (const v of vs) byVaccine.set(v.id, [...(byVaccine.get(v.id) ?? []), d]);
  }
  const results = schedule.vaccines.map((v) => {
    const recs = (byVaccine.get(v.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const records: Ref[] = recs.map((d) => ({ date: d.date, source: d.source }));
    // A dose under 28 days after the previous counted one is the same dose (C-CDA/EHI copies a day apart, possible
    // duplicates); 4 weeks is the CDC minimum interval for RZV, HepB and HPV. shortcut: undercounts Twinrix 0/7/21-day.
    const doses: Dose[] = [];
    for (const d of recs) if (!doses.length || d.date.slice(0, 10) >= addDays(doses.at(-1)!.date, 28)) doses.push(d);
    const last = doses.at(-1)?.date.slice(0, 10);
    const out = (status: Status, reason: string, used: Ref[] = records) => ({ vaccine: v.id, status, records: used, reason });

    // The value must start with a positive word ("Positive (immune)"), not merely contain one ("Immune status unknown").
    const pos = (e: Evidence) => v.immuneIf!.positive.some((p) => new RegExp(`^${p}\\b`).test(e.value.trim().toLowerCase())) && !NEGATED.test(norm(e.value));
    const named = (e: Evidence, n: string) => { const nm = norm(e.name); return has(nm, n) && !/\bigm\b/.test(nm) && (!BARE.has(n) || ANTIBODY.test(nm)); };
    const ev = (n: string) => immunity.filter((e) => named(e, n) && pos(e));
    if (v.immuneIf) {
      const groups = v.immuneIf.names.map(ev);
      const ok = v.immuneIf.all ? groups.every((g) => g.length) : groups.some((g) => g.length);
      if (ok) return out('immune', 'Laboratory evidence of immunity', [...new Set(groups.flat())].map((e) => ({ date: e.date, source: e.source })));
    }
    const rule = v.rules.find((r) => age >= r.ages[0] && (r.ages[1] === null || age <= r.ages[1]) && (!r.sex || r.sex === input.sex)
      && (!r.born || ((r.born[0] === null || born >= r.born[0]) && (r.born[1] === null || born <= r.born[1]))));
    if (!rule) return out('not-recommended', `No routine recommendation at age ${age} in this schedule`);
    const why = rule.reason ?? '';
    if (rule.status === 'not-recommended') return out('not-recommended', why);
    if (rule.completeIf && doses.some((d) => hits(rule.completeIf!, d))) return out('complete', rule.completeIf.reason);
    if (rule.seasonal) {
      const start = `${Number(day.slice(0, 4)) - (day.slice(5) < '08-01' ? 1 : 0)}-08-01`;
      return doses.some((d) => d.date.slice(0, 10) >= start) ? out('complete', `${why} Dose recorded this season (from ${start}).`) : out('due', `${why} No dose this season (from ${start}).`);
    }
    if (rule.repeatYears) {
      if (!last) return out('due', `${why} No dose recorded.`);
      if (rule.requireOne && !doses.some((d) => hits(rule.requireOne!, d))) return out('due', `${why} ${rule.requireOne.reason}`);
      const next = addMonths(last, rule.repeatYears * 12);
      return next > day ? out('complete', `${why} Next booster ${next}.`) : out('overdue', `${why} Last dose ${last}; booster was due ${next}.`);
    }
    const need = rule.altDoses && doses.length && doses.every((d) => hits(rule.altDoses!, d)) ? rule.altDoses.doses : rule.doses;
    if (need && doses.length >= need) return out('complete', `${why} ${doses.length} of ${need} doses recorded.`);
    if (rule.status === 'not-evaluated' && !(rule.dueIfNone && !doses.length)) return out('not-evaluated', why);
    if (!doses.length) return out('due', `${why} No dose recorded.`);
    const next = rule.intervalMonths ? addMonths(last as string, rule.intervalMonths) : undefined;
    if (next && next <= day) return out('overdue', `${why} ${doses.length} of ${need} doses; next dose was due by ${next}.`);
    return out('due', `${why} ${doses.length} of ${need} doses recorded.`);
  });
  return { edition: schedule.edition, results, unmatched };
}

const TAG = 'urn:ga-server:tag';
const CVX = ['http://hl7.org/fhir/sid/cvx', 'urn:oid:2.16.840.1.113883.12.292'];
const src = (r: { meta?: { source?: string } }) => (r.meta?.source ? basename(r.meta.source) : '');

// Reads the patient's own GA data so values never pass through the agent.
export async function vaccineGaps(client: MedplumClient, patientId: string, asOf = new Date().toLocaleDateString('en-CA')) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf)) || !new Date(asOf).toISOString().startsWith(asOf)) throw new GaError('asOf must be a date (YYYY-MM-DD)');
  const p = await client.readResource('Patient', patientId, { cache: 'no-cache' }) as Patient;
  if (!p.birthDate) throw new GaError('Patient has no birthDate in GA');
  const sex = p.gender === 'male' || p.gender === 'female' ? p.gender : undefined;
  // Every page: a patient can hold more than one page of Observations.
  const all = async (type: 'Immunization' | 'Observation', q: Record<string, string>) => {
    const out: unknown[] = [];
    for await (const page of client.searchResourcePages(type, { ...q, _count: '1000' }, { cache: 'no-cache' })) out.push(...page);
    return out;
  };
  const imms = ((await all('Immunization', { patient: `Patient/${patientId}` })) as Immunization[]).filter((i) => i.status === 'completed');
  const obs = ((await all('Observation', { subject: `Patient/${patientId}` })) as Observation[]).filter((o) => !['entered-in-error', 'cancelled', 'preliminary'].includes(o.status));
  const immunizations = imms.map((i) => {
    const cvx = i.vaccineCode?.coding?.find((c) => CVX.includes(c.system ?? ''))?.code; // NDC codings are ignored
    const name = i.vaccineCode?.text ?? i.vaccineCode?.coding?.find((c) => c.display)?.display;
    return { date: (i.occurrenceDateTime ?? '').slice(0, 10), ...(cvx && { cvx }), ...(name && { name }), source: src(i) };
  });
  const immunity = obs.flatMap((o) => {
    const name = o.code?.text ?? o.code?.coding?.find((c) => c.display)?.display;
    const value = o.valueString ?? o.valueCodeableConcept?.text ?? o.valueCodeableConcept?.coding?.find((c) => c.display)?.display;
    return name && value ? [{ name, value, date: (o.effectiveDateTime ?? '').slice(0, 10), source: src(o) }] : [];
  });
  const possibleDuplicates = imms
    .filter((i) => i.meta?.tag?.some((t) => t.system === TAG && t.code === 'possible-duplicate'))
    .map((i) => ({ date: (i.occurrenceDateTime ?? '').slice(0, 10), name: i.vaccineCode?.text, source: src(i) }));
  return { ...evaluateVaccines(loadSchedule(), { birthDate: p.birthDate, sex, immunizations, immunity }, asOf), asOf, possibleDuplicates,
    ...(!sex && { note: `Patient gender in GA is ${p.gender ?? 'missing'}: sex-specific rules not applied (the schedule has none).` }) };
}
