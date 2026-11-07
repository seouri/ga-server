import type { Condition, ConceptMap, Immunization, Observation, Resource } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { addUnmapped, carryConcept, CONCEPT_SRC, codeRecord, learnable, stripConcept, type Unmapped } from '../src/concept-apply.ts';
import type { Maps } from '../src/conceptmap.ts';
import { decide, fillFrom } from '../src/engine.ts';
import { stamp, type SourceInfo } from '../src/identity.ts';

const TAG = 'urn:ga-server:tag';
const LOINC = 'http://loinc.org';
const lab = (code: Observation['code'], extra: Partial<Observation> = {}): Observation => ({
  resourceType: 'Observation', status: 'final',
  category: [{ coding: [{ code: 'laboratory' }] }],
  code, valueQuantity: { value: 99, unit: 'mg/dL' }, ...extra,
});
const EHI: SourceInfo = ({ kind: 'ehi', file: '/x', date: '2026-01-01', writer: 'importer' });
const pdf: SourceInfo = { kind: 'pdf', file: '/x/r.pdf', date: '2026-01-01', writer: 'agent', llm: true };
const withId = <T extends Resource>(r: T, org = 'syn'): T => ({ ...r, identifier: [{ system: `urn:ga-server:id:ehi:${org}`, value: 'X|1' }] });
const map = (source: string, key: string, code: string, equivalence: string, confident = true, by = 'source'): Maps =>
  new Map([[source, {
    resourceType: 'ConceptMap', status: 'active', url: `urn:ga-server:conceptmap:${source}`,
    group: [{ source: 'urn:ga-server:termkey', target: LOINC, element: [{ code: key, target: [{ code, equivalence, ...(equivalence !== 'equivalent' && { comment: 'x' }), extension: [{ url: 'urn:ga-server:ext:concept-by', valueCode: by }, { url: 'urn:ga-server:ext:concept-confident', valueBoolean: confident }] }] }] }],
  } as ConceptMap]]);
const none: Maps = new Map();
const tags = (r: Resource) => (r.meta?.tag ?? []).filter((t) => t.system === TAG).map((t) => t.code);
const codings = (r: Resource) => (r as Observation).code?.coding ?? [];

test('a coded hospital LDL is source and teaches its map an equivalent entry; nothing is added', () => {
  const r = withId(lab({ coding: [{ system: LOINC, code: '13457-7', display: 'LDL calc' }], text: 'LOW DENSITY LIPOPROTEIN CHOL' }));
  const out = codeRecord(r, EHI, none);
  expect(out.status).toBe('source');
  expect(out.resource).toEqual(r);
  expect(out.learn).toEqual({ source: 'ehi:syn', entry: { key: 'low density lipoprotein chol|mg/dl', target: { system: LOINC, code: '13457-7', display: 'LDL calc' }, equivalence: 'equivalent', confident: true, by: 'source' } });
});

test('pdf and Apple codes teach nothing (one install-wide map each; pdf codes are extraction guesses)', () => {
  const r = { ...lab({ coding: [{ system: LOINC, code: '13457-7' }], text: 'LDL' }), meta: { tag: [{ system: TAG, code: 'extracted-by-llm' }] } };
  expect(codeRecord(r, pdf, none)).toEqual({ resource: r, status: 'source' });
  expect(codeRecord(r, { ...pdf, kind: 'apple-health' }, none).learn).toBeUndefined();
});

test('an uncoded PDF LDL with no map is unmapped and tagged', () => {
  const r = { ...lab({ text: 'LDL cholesterol' }), category: undefined, meta: { tag: [{ system: TAG, code: 'extracted-by-llm' }] } };
  const out = codeRecord(r, pdf, none);
  expect(out.status).toBe('unmapped');
  expect(tags(out.resource)).toEqual(['extracted-by-llm', 'concept-unmapped']);
  expect(codings(out.resource)).toEqual([]);
});

test('an equivalent confident map entry adds the coding after the source coding, marked source-map; the source coding is unchanged', () => {
  const own = { system: 'urn:oid:1.2.840.114350.1', code: 'LAB123', display: 'LDL' };
  const r = withId(lab({ coding: [own], text: 'LDL' }));
  const out = codeRecord(r, EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'equivalent'));
  expect(out.status).toBe('source-map');
  expect(codings(out.resource)).toEqual([own, { system: LOINC, code: '13457-7', extension: [{ url: CONCEPT_SRC, valueCode: 'source-map' }] }]);
  expect(codings(out.resource)[0]).toBe(own);
  expect(tags(out.resource)).toEqual([]);
  expect(codeRecord(out.resource, EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'equivalent')).resource).toEqual(out.resource); // idempotent
});

test('inexact, or not confident, is suggested; an agent entry is marked agent; unmatched adds nothing and is not unmapped', () => {
  const r = withId(lab({ text: 'LDL' }));
  const inexact = codeRecord(r, EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'inexact'));
  expect(inexact.status).toBe('suggested');
  expect(tags(inexact.resource)).toEqual(['concept-suggested']);
  const agent = codeRecord(r, EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'equivalent', false, 'agent'));
  expect(agent.status).toBe('suggested');
  expect(codings(agent.resource)[0].extension).toEqual([{ url: CONCEPT_SRC, valueCode: 'agent' }]);
  const unmatched = codeRecord(r, EHI, new Map([['ehi:syn', { resourceType: 'ConceptMap', status: 'active', url: 'u', group: [{ source: 'urn:ga-server:termkey', target: 'urn:ga-server:unmatched', element: [{ code: 'ldl|mg/dl', target: [{ equivalence: 'unmatched' }] }] }] } as ConceptMap]]));
  expect(unmatched).toEqual({ resource: r, status: 'excluded' });
});

test('spec tables: clinic vitals and vaccine names', () => {
  const weight = withId({ resourceType: 'Observation', status: 'final', category: [{ coding: [{ code: 'vital-signs' }] }], code: { text: 'Weight' }, valueQuantity: { value: 70, unit: 'kg' } } as Observation);
  const w = codeRecord(weight, EHI, none);
  expect(w.status).toBe('spec');
  expect(codings(w.resource)).toEqual([{ system: LOINC, code: '29463-7', extension: [{ url: CONCEPT_SRC, valueCode: 'spec' }] }]);
  const flu = withId({ resourceType: 'Immunization', status: 'completed', patient: {}, vaccineCode: { text: 'Zoster recombinant' } } as Immunization);
  const out = codeRecord(flu, EHI, none);
  expect(out.status).toBe('spec');
  expect((out.resource as Immunization).vaccineCode.coding?.[0]).toMatchObject({ system: 'http://hl7.org/fhir/sid/cvx', code: '187' });
});

test('an excluded Apple summary, a record without a source key, and a reference-only medication are returned unchanged', () => {
  const summary = lab({ text: 'Heart rate, daily mean (Apple Health)' }, { category: [{ coding: [{ code: 'vital-signs' }] }] });
  expect(codeRecord(summary, { ...pdf, kind: 'apple-health' }, none)).toEqual({ resource: summary, status: 'excluded' });
  const noKey = lab({ text: 'LDL' }); // EHI record without its urn:ga-server:id:ehi:<org> identifier: sourceKey throws
  expect(codeRecord(noKey, EHI, none)).toEqual({ resource: noKey, status: 'excluded' });
  const ref = withId({ resourceType: 'MedicationStatement', status: 'active', subject: {}, medicationReference: { reference: 'Medication/1', display: 'x' } } as Resource);
  expect(codeRecord(ref, EHI, none).status).toBe('excluded');
});

test('stripConcept removes GA codings (and an emptied coding array) and concept tags only', () => {
  const r = { ...withId(lab({ text: 'LDL' })), meta: { tag: [{ system: TAG, code: 'writer-importer' }] } };
  const coded = codeRecord(r, EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'inexact')).resource;
  expect(stripConcept(coded)).toEqual(r);
  const own = withId(lab({ coding: [{ system: 'urn:x', code: '1' }], text: 'LDL' }));
  expect(stripConcept(codeRecord(own, EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'equivalent')).resource)).toEqual(own);
});

test('decide: an existing record with a GA coding vs the same source content skips', () => {
  const s = EHI;
  const id = { system: 'urn:ga-server:id:ehi:syn', value: 'X|1' };
  const r = withId(lab({ text: 'LDL' }));
  const coded = codeRecord(stamp(r, s, id), s, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'equivalent')).resource;
  const existing = { ...coded, id: 'e1' };
  expect(decide(existing, stamp(r, s, id))).toBe('skip'); // incoming not coded (no map yet)
  expect(decide(existing, codeRecord(stamp(r, s, id), s, none).resource)).toBe('skip'); // incoming tagged unmapped
  expect(decide(existing, coded)).toBe('skip');
});

test('EHI fill: a text-only problem with a GA coding never replaces the C-CDA SNOMED coding, and skips', () => {
  const snomed = { system: 'http://snomed.info/sct', code: '38341003' };
  const existing = { ...withId({ resourceType: 'Condition', subject: { reference: 'Patient/p' }, code: { coding: [snomed], text: 'Hypertension' } } as Condition), id: 'e1' };
  const incoming = codeRecord(withId({ resourceType: 'Condition', subject: { reference: 'Patient/p' }, code: { text: 'Hypertension' } } as Condition), EHI,
    new Map([['ehi:syn', { resourceType: 'ConceptMap', status: 'active', url: 'u', group: [{ source: 'urn:ga-server:termkey', target: 'http://hl7.org/fhir/sid/icd-10-cm', element: [{ code: 'hypertension', target: [{ code: 'I10', equivalence: 'equivalent' }] }] }] } as ConceptMap]])).resource;
  const filled = fillFrom(existing, incoming, EHI) as Condition;
  expect(filled.code?.coding).toEqual([snomed]); // a source code kept: no GA coding, no concept tag
  expect(filled.meta?.tag ?? []).toEqual([]);
  expect(decide(existing, filled)).toBe('skip');
});

test('carryConcept keeps the existing GA coding when the incoming record has none', () => {
  const r = withId(lab({ text: 'LDL' }));
  const existing = codeRecord(r, EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'inexact')).resource;
  const incoming = codeRecord({ ...r, valueQuantity: { value: 100, unit: 'mg/dL' } }, EHI, none).resource; // unmapped
  const out = carryConcept(existing, incoming) as Observation;
  expect(out.code.coding).toEqual(codings(existing));
  expect(tags(out)).toEqual(['concept-suggested']);
  expect(out.valueQuantity?.value).toBe(100);
  const own = withId(lab({ coding: [{ system: LOINC, code: '2089-1' }], text: 'LDL' }));
  expect(carryConcept(existing, own)).toBe(own); // a source code now: nothing carried
});

test('learnable: one code per new term, grouped by source; a term coded two ways, or already mapped, is not learned', () => {
  const ldl = (code: string, org = 'syn') => withId(lab({ coding: [{ system: LOINC, code }], text: 'LDL' }), org);
  const hdl = withId(lab({ coding: [{ system: LOINC, code: '2085-9' }], text: 'HDL' }));
  const got = learnable([ldl('13457-7'), ldl('13457-7'), hdl, ldl('13457-7', 'other')], EHI, none);
  expect([...got.keys()]).toEqual(['ehi:syn', 'ehi:other']);
  expect(got.get('ehi:syn')?.map((e) => [e.key, e.target?.code, e.equivalence, e.confident])).toEqual([['ldl|mg/dl', '13457-7', 'equivalent', true], ['hdl|mg/dl', '2085-9', 'equivalent', true]]);
  expect(learnable([ldl('13457-7'), ldl('18262-6')], EHI, none).size).toBe(0); // two codes under one name: no confident entry
  expect(learnable([ldl('18262-6')], EHI, map('ehi:syn', 'ldl|mg/dl', '13457-7', 'equivalent', true, 'agent')).size).toBe(0);
  expect(learnable([{ ...ldl('13457-7'), meta: { tag: [{ system: TAG, code: 'extracted-by-llm' }] } }], pdf, none).size).toBe(0);
});

test('addUnmapped merges review lines on source, type and term key', () => {
  const u = (name: string, key: string, count = 1): Unmapped => ({ source: 'pdf', type: 'Observation', key, name, unit: 'mg/dL', count });
  const list: Unmapped[] = [];
  addUnmapped(list, [u('LDL chol.', 'ldl chol|mg/dl'), u('ldl  chol', 'ldl chol|mg/dl', 2), u('LDL chol', 'ldl chol|mg/dl|urine')]);
  expect(list).toEqual([u('LDL chol.', 'ldl chol|mg/dl', 3), u('LDL chol', 'ldl chol|mg/dl|urine')]);
});
