import { readFileSync } from 'node:fs';
import type { Coding } from '@medplum/fhirtypes';

export type Concept = { name: string; kind: 'lab' | 'vital' | 'vaccine' | 'procedure' | 'medication' | 'condition'; members: { system: string; code: string; label?: string }[] };

const load = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8')) as T;
const list = load<Concept[]>('concepts.json');
const cvx = load<{ vaccines: { code: string; short: string }[] }>('cvx.json').vaccines;
const byCode = new Map(list.flatMap((concept) => concept.members.map((m) => [`${m.system}|${m.code}`, { concept, label: m.label }] as const)));
const byName = new Map(list.map((c) => [c.name.toLowerCase(), c]));

export const concepts = (): Concept[] => list;

// The first coding that is a member of a concept. Whether a coding is GA-suggested is the caller's call.
export const conceptOf = (codings: Coding[] | undefined): { concept: Concept; label?: string } | undefined =>
  codings?.map((c) => byCode.get(`${c.system}|${c.code}`)).find(Boolean);

export const codesFor = (name: string): Coding[] => byName.get(name.toLowerCase())?.members.map(({ system, code }) => ({ system, code })) ?? [];

// FHIR Vital Signs profile: the first member of the vital concept is the profile's code.
const ALIAS: Record<string, string> = { weight: 'body weight', height: 'body height', bmi: 'body mass index', 'body mass index (bmi)': 'body mass index', pulse: 'heart rate', spo2: 'oxygen saturation', temperature: 'body temperature', 'blood pressure': 'blood pressure panel', 'head circumference': 'head circumference' };
// `unit` is accepted for callers and unused: the profile fixes one code per vital whatever the unit.
export const vitalSpecCode = (name: string, _unit?: string): Coding | undefined => {
  const n = name.trim().toLowerCase();
  const c = byName.get(ALIAS[n] ?? n);
  return c?.kind === 'vital' ? codesFor(c.name)[0] : undefined;
};

export const cvxFor = (name: string): Coding | undefined => {
  const v = cvx.find((x) => x.short.toLowerCase() === name.trim().toLowerCase());
  return v && { system: 'http://hl7.org/fhir/sid/cvx', code: v.code, display: v.short };
};
