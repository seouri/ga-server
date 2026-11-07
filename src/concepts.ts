import { readFileSync } from 'node:fs';
import type { Coding } from '@medplum/fhirtypes';

export const LOINC = 'http://loinc.org';
export const CVX = 'http://hl7.org/fhir/sid/cvx';
export const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
export const SNOMED = 'http://snomed.info/sct';
export const ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm';
export const CPT = 'http://www.ama-assn.org/go/cpt';
export const HCPCS = 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets';

export type Concept = { name: string; kind: 'lab' | 'vital' | 'vaccine' | 'procedure' | 'medication' | 'condition'; synonyms?: string[]; members: { system: string; code: string; label?: string }[] };

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
const ALIAS: Record<string, string> = { weight: 'body weight', height: 'body height', bmi: 'body mass index', 'body mass index (bmi)': 'body mass index', pulse: 'heart rate', spo2: 'oxygen saturation', temperature: 'body temperature', 'blood pressure': 'blood pressure panel' };
// `unit` is accepted for callers and unused: the profile fixes one code per vital whatever the unit.
export const vitalSpecCode = (name: string, _unit?: string): Coding | undefined => {
  const n = name.trim().toLowerCase();
  const c = byName.get(ALIAS[n] ?? n);
  return c?.kind === 'vital' ? codesFor(c.name)[0] : undefined;
};

// The concept a tool query asks for: a name, vital alias or synonym, alone or with filler words ("my ldl level", "blood glucose").
// Any other word ("ldl p", "urine glucose", "tsh receptor antibody") keeps the query literal. The longest term wins; a tie between concepts resolves nothing.
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const FILLER = new Set(['my', 'the', 'blood', 'serum', 'plasma', 'level', 'levels', 'test', 'result', 'results', 'value', 'values', 'cholesterol']);
const TERMS = [...list.map((c) => [words(c.name), c] as const), ...list.flatMap((c) => (c.synonyms ?? []).map((t) => [words(t), c] as const)),
  ...Object.entries(ALIAS).map(([a, n]) => [words(a), byName.get(n)!] as const)];
export const conceptNamed = (query: string): Concept | undefined => {
  const q = ` ${words(query)} `;
  const hits = TERMS.filter(([t]) => q.includes(` ${t} `) && q.replace(` ${t} `, ' ').trim().split(' ').every((w) => !w || FILLER.has(w)))
    .sort(([a], [b]) => b.length - a.length);
  return hits.length && !hits.some(([t, c]) => t.length === hits[0][0].length && c !== hits[0][1]) ? hits[0][1] : undefined;
};

export const cvxFor = (name: string): Coding | undefined => {
  const v = cvx.find((x) => x.short.toLowerCase() === name.trim().toLowerCase());
  return v && { system: CVX, code: v.code, display: v.short };
};
export const cvxShort = (code: string): string | undefined => cvx.find((x) => x.code === code)?.short;
