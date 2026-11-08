import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { afterEach, expect, test, vi } from 'vitest';
import { convertCcdaLocal, convertCcdaMs } from '../src/ccda.ts';
import { ccdaCompare, compareCcda, matchEntries } from '../src/ccda-compare.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const SYNTHETIC = readFileSync(join(FIXTURES, 'ccda-synthetic.xml'), 'utf8');
const EPIC = readFileSync(join(FIXTURES, 'ccda-epic-style.xml'), 'utf8');
// Real Microsoft converter output (convertCcdaMs, GA's repair included) for the two fixtures: invented data.
const ms = (f: string): Resource[] => JSON.parse(readFileSync(join(FIXTURES, `${f}.ms.json`), 'utf8'));
const MS_SYNTHETIC = () => ms('ccda-synthetic');
const MS_EPIC = () => ms('ccda-epic-style');
const run = (xml: string, old: Resource[], neu?: Resource[]) => {
  const local = convertCcdaLocal(xml);
  return compareCcda(xml, old, neu ?? local.resources, local.notImported);
};
// A pair of single records (no document context needed beyond the XML's sections).
const pairLosses = (old: unknown[], neu: unknown[]) => compareCcda(SYNTHETIC, old as Resource[], neu as Resource[], []).losses;
const id = (v: string) => [{ system: 'urn:oid:2.25.1', value: v }];
const subject = { reference: 'Patient/ms-p' };

test('a field present in the old record and missing in the new is a loss with its element path', () => {
  const r = run(SYNTHETIC, MS_SYNTHETIC());
  // Against the real converter: nothing lost. LOINC/SNOMED/RxNorm, values, dates, the medication (a statement on both paths), the
  // result panel (a report on both paths, Task 7), the document id and the Composition's subject and section mode agree.
  expect(r.losses).toEqual([]);
  // A field only the old record holds.
  const old = MS_SYNTHETIC().map((x) => (JSON.stringify(x).includes('syn-ldl-1') ? { ...x, interpretation: [{ coding: [{ system: 'urn:oid:2.16.840.1.113883.5.83', code: 'H' }] }] } : x));
  expect(run(SYNTHETIC, old).losses).toContainEqual({ type: 'Observation', path: 'interpretation.coding', count: 1 });
  // Never values: no identifier, name, code or quantity reaches the report.
  expect(JSON.stringify(r)).not.toMatch(/FAKE-MRN|syn-|atorvastatin|Hyperlipidemia|mg\/dL|55822004|617310/);
});

test('an empty old placeholder (no value, no code beyond text) is explained, not a loss', () => {
  const empty = { resourceType: 'Observation', id: 'e', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], code: { text: 'Lipid panel' }, subject };
  const noted = { ...empty, id: 'n', note: [{ text: 'critical' }], interpretation: [{ coding: [{ system: 'urn:oid:2.16.840.1.113883.5.83', code: 'HH' }] }], referenceRange: [{ text: '3.5-5.1' }] };
  const valued = { ...empty, id: 'v', valueString: 'never' };
  const records = run(SYNTHETIC, [...MS_SYNTHETIC(), empty, noted, valued] as Resource[]).losses.filter((l) => l.path === '(record)');
  expect(records).toEqual([
    { type: 'Observation', path: '(record)', count: 1, explained: 'no value and no code beyond text' },
    { type: 'Observation', path: '(record)', count: 2 }, // a note, interpretation, range or value is information
  ]);
  // A matched placeholder's lost fields are losses, never explained.
  expect(pairLosses([{ ...noted, identifier: id('a') }], [{ ...empty, identifier: id('a') }])).toEqual([
    { type: 'Observation', path: 'note.text', count: 1 },
    { type: 'Observation', path: 'interpretation.coding', count: 1 },
    { type: 'Observation', path: 'referenceRange.text', count: 1 },
  ]);
});

test('a record holding no information never matches (even by a shared id); a reference to it is explained, a reference to a record with information is not', () => {
  const cat = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];
  const ph = { resourceType: 'Observation', id: 'ph', identifier: id('org'), status: 'final', category: cat, subject }; // shares the organizer's id
  const val = (i: string, v: string) => ({ resourceType: 'Observation', id: i, identifier: id(v), status: 'final', category: cat, code: { text: 'K' }, valueString: v, subject });
  const report = (...refs: string[]) => ({ resourceType: 'DiagnosticReport', identifier: id('org'), status: 'final', subject, result: refs.map((reference) => ({ reference })) });
  const neu = [report('Observation/n1'), val('n1', 'a')];
  expect(compareCcda(SYNTHETIC, [report('Observation/ph', 'Observation/o1'), ph, val('o1', 'a')] as Resource[], neu as Resource[], []).losses).toEqual([
    { type: 'DiagnosticReport', path: 'result.reference', count: 1, explained: 'reference to a record holding no information' },
    { type: 'Observation', path: '(record)', count: 1, explained: 'no value and no code beyond text' },
  ]);
  // An id-only record (a facility the Microsoft path read nothing from), and the reference to it.
  const enc = (ref: string) => ({ resourceType: 'Encounter', identifier: id('e'), status: 'finished', location: [{ location: { reference: ref } }] });
  expect(pairLosses([enc('Location/L'), { resourceType: 'Location', id: 'L' }], [{ ...enc('Location/x'), location: undefined }])).toEqual([
    { type: 'Encounter', path: 'location.location.reference', count: 1, explained: 'reference to a record holding no information' },
    { type: 'Location', path: '(record)', count: 1, explained: 'nothing but its id' },
  ]);
  // A reference to an unmatched record that holds information stays a loss, and so does the record.
  expect(compareCcda(SYNTHETIC, [report('Observation/o2', 'Observation/o1'), val('o2', 'b'), val('o1', 'a')] as Resource[], neu as Resource[], []).losses).toEqual([
    { type: 'DiagnosticReport', path: 'result.reference', count: 1 },
    { type: 'Observation', path: '(record)', count: 1 },
  ]);
});

test('an entry only the new path produces is a gain', () => {
  const r = run(SYNTHETIC, MS_SYNTHETIC());
  expect(r.gains).toEqual({ Observation: 1 }); // the vital signs organizer
  expect(r.unaccounted).toEqual([]);
});

test('an entry neither imported nor named is unaccounted', () => {
  const local = convertCcdaLocal(SYNTHETIC);
  const neu = local.resources.filter((r) => !(r.resourceType === 'Observation' && JSON.stringify(r).includes('syn-smoking-1')));
  expect(compareCcda(SYNTHETIC, MS_SYNTHETIC(), neu, local.notImported).unaccounted).toEqual([
    { section: 'Social History', templateId: '2.16.840.1.113883.10.20.22.2.17', entries: 1, reason: 'not imported and not named' },
  ]);
});

test('the Epic-style fixture against the real Microsoft output: every loss by path, all accounted', () => {
  const r = run(EPIC, MS_EPIC());
  // Every loss fixed (Tasks 4-8); the Microsoft path's other spellings of the same information are compare equivalences.
  expect(r.losses).toEqual([]);
  expect(r.unaccounted).toEqual([]);
});

test('matchEntries: the document Compositions pair; by source id (the copy it loses least to); id-less by class and code, one to one', () => {
  const ob = (i: string | undefined, code: string, x: object = {}): Resource => ({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code }] }, ...(i && { identifier: id(i) }), ...x }) as Resource;
  const [a, b, c] = [ob('a', '1'), ob(undefined, '2'), ob(undefined, '2')];
  const [na, nb, nOther] = [ob('a', '9'), ob(undefined, '2'), ob('z', '2')];
  const m = matchEntries([a, b, c], [nOther, na, nb]);
  expect(m.get(a)).toBe(na); // by id, even with another code
  expect(m.get(b)).toBe(nb); // id-less: same class and code; a record with its own id is never taken
  expect(m.get(c)).toBeUndefined(); // one to one
  // The real converter's Composition identifier has no system: the one Composition of each side pairs anyway.
  const [msComp] = MS_SYNTHETIC().filter((r) => r.resourceType === 'Composition');
  const [newComp] = convertCcdaLocal(SYNTHETIC).resources.filter((r) => r.resourceType === 'Composition');
  expect(matchEntries([msComp], [newComp]).get(msComp)).toBe(newComp);
  // Repeated practitioner copies: the one holding the old record's fields.
  const pr = (x: object) => ({ resourceType: 'Practitioner', identifier: id('p'), ...x }) as Resource;
  const full = pr({ name: [{ family: 'F' }], telecom: [{ system: 'phone', value: '1' }] });
  expect(matchEntries([full], [pr({ name: [{ family: 'F' }] }), full]).get(full)).toBe(full);
});

test('a Medication holding more than its code stays a record of its own', () => {
  const rx = { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1' }] };
  const losses = pairLosses(
    [{ resourceType: 'MedicationStatement', id: 's', identifier: id('m'), status: 'active', medicationReference: { reference: 'Medication/m' }, subject },
      { resourceType: 'Medication', id: 'm', code: rx, form: { coding: [{ system: 'http://snomed.info/sct', code: '385055001' }] }, batch: { lotNumber: 'L1' } }],
    [{ resourceType: 'MedicationStatement', identifier: id('m'), status: 'active', medicationCodeableConcept: rx, subject }],
  );
  expect(losses).toContainEqual({ type: 'Medication', path: '(record)', count: 1 });
});

test('array elements pair one to one: swapped components, regrouped ranges, a dropped duplicate, codings with extensions', () => {
  const comp = (s: number, d: number) => [{ code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: s } }, { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: d } }];
  expect(pairLosses([{ resourceType: 'Observation', identifier: id('bp'), component: comp(120, 80) }], [{ resourceType: 'Observation', identifier: id('bp'), component: comp(80, 120) }]))
    .toEqual([{ type: 'Observation', path: 'component.value[x].value', count: 1 }]);
  expect(pairLosses(
    [{ resourceType: 'Observation', identifier: id('r'), referenceRange: [{ low: { value: 1 }, high: { value: 5 } }, { low: { value: 2 }, high: { value: 9 }, text: 'child' }] }],
    [{ resourceType: 'Observation', identifier: id('r'), referenceRange: [{ low: { value: 2 }, high: { value: 5 } }, { low: { value: 1 }, high: { value: 9 }, text: 'child' }] }],
  )).toEqual([{ type: 'Observation', path: 'referenceRange.low.value', count: 1 }]);
  expect(pairLosses([{ resourceType: 'Condition', identifier: id('c'), note: [{ text: 'same' }, { text: 'same' }] }], [{ resourceType: 'Condition', identifier: id('c'), note: [{ text: 'same' }] }]))
    .toEqual([{ type: 'Condition', path: 'note.text', count: 1 }]);
  const cc = (a: string, b: string) => ({ coding: [{ system: 'http://loinc.org', code: a, extension: [{ url: 'u', valueString: 'q' }] }, { system: 'http://snomed.info/sct', code: b, extension: [{ url: 'u', valueString: 'q' }] }] });
  expect(pairLosses([{ resourceType: 'Condition', identifier: id('c'), code: cc('1', '2') }], [{ resourceType: 'Condition', identifier: id('c'), code: cc('2', '1') }]))
    .toEqual([{ type: 'Condition', path: 'code.coding', count: 1 }]);
});

test('a reference must point at the new counterpart of its old target', () => {
  const loc = (i: string, v: string) => ({ resourceType: 'Location', id: i, identifier: id(v) });
  const enc = (ref: string) => ({ resourceType: 'Encounter', identifier: id('e'), location: [{ location: { reference: ref } }] });
  expect(pairLosses([enc('Location/A'), loc('A', 'la'), loc('B', 'lb')], [enc('Location/nb'), loc('na', 'la'), loc('nb', 'lb')]))
    .toEqual([{ type: 'Encounter', path: 'location.location.reference', count: 1 }]);
  expect(pairLosses([enc('Location/A'), loc('A', 'la')], [enc('Location/na'), loc('na', 'la')])).toEqual([]);
});

test('an old reference to a Practitioner holds through a new PractitionerRole of its counterpart; a role of another practitioner is a loss', () => {
  const doc = (i: string, v: string) => ({ resourceType: 'Practitioner', id: i, identifier: id(v) });
  const enc = (ref: string) => ({ resourceType: 'Encounter', identifier: id('e'), participant: [{ individual: { reference: ref } }] });
  const role = (i: string, p: string) => ({ resourceType: 'PractitionerRole', id: i, practitioner: { reference: `Practitioner/${p}` } });
  const old = [enc('Practitioner/A'), doc('A', 'pa'), doc('B', 'pb')];
  expect(pairLosses(old, [enc('PractitionerRole/r'), role('r', 'na'), doc('na', 'pa'), doc('nb', 'pb')])).toEqual([]);
  expect(pairLosses(old, [enc('PractitionerRole/r'), role('r', 'nb'), doc('na', 'pa'), doc('nb', 'pb')]))
    .toEqual([{ type: 'Encounter', path: 'participant.individual.reference', count: 1 }]);
});

test('a coding display repeating its CodeableConcept text is that text; a different display, or a text the new record lacks, is a loss', () => {
  const med = (code: unknown) => ({ resourceType: 'MedicationStatement', identifier: id('m'), status: 'active', subject, medicationCodeableConcept: code });
  const rx = (display?: string) => ({ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1', ...(display && { display }) });
  expect(pairLosses([med({ coding: [rx('drug A')], text: 'drug A' })], [med({ coding: [rx()], text: 'drug A' })])).toEqual([]);
  expect(pairLosses([med({ coding: [rx('drug B')], text: 'drug A' })], [med({ coding: [rx()], text: 'drug A' })]))
    .toEqual([{ type: 'MedicationStatement', path: 'medication[x].coding.display', count: 1 }]);
  expect(pairLosses([med({ coding: [rx('drug A')], text: 'drug A' })], [med({ coding: [rx()] })]))
    .toEqual([{ type: 'MedicationStatement', path: 'medication[x].text', count: 1 }]);
});

test('a leading-dot PQ value the Microsoft path read without its dot is a correction; any other number difference is a loss', () => {
  const xml = (v: string) => `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody/></component><value xsi:type="PQ" value="${v}" unit="/d"/></ClinicalDocument>`;
  const obs = (value: number) => ({ resourceType: 'Observation', identifier: id('q'), status: 'final', subject, code: { text: 'K' }, valueQuantity: { value, unit: '/d' } });
  const losses = (v: string, a: number, b: number) => compareCcda(xml(v), [obs(a)] as Resource[], [obs(b)] as Resource[], []).losses;
  expect(losses('.25', 25, 0.25)).toEqual([]);
  expect(losses('.25', 25, 2.5)).toEqual([{ type: 'Observation', path: 'value[x].value', count: 1 }]);
  expect(losses('0.25', 25, 0.25)).toEqual([{ type: 'Observation', path: 'value[x].value', count: 1 }]);
});

test('an old coding with no system is held by a new coding adding a system to the same code and display; another code or display is a loss', () => {
  const pt = (coding: unknown) => ({ resourceType: 'Patient', identifier: id('p'), maritalStatus: { coding: [coding] } });
  const sys = { system: 'urn:oid:2.25.9' };
  expect(pairLosses([pt({ code: 'A', display: 'Alpha' })], [pt({ ...sys, code: 'A', display: 'Alpha' })])).toEqual([]);
  expect(pairLosses([pt({ code: 'A', display: 'Alpha' })], [pt({ ...sys, code: 'B', display: 'Alpha' })])).toEqual([{ type: 'Patient', path: 'maritalStatus.coding', count: 1 }]);
  expect(pairLosses([pt({ code: 'A', display: 'Alpha' })], [pt({ ...sys, code: 'A', display: 'Beta' })])).toEqual([{ type: 'Patient', path: 'maritalStatus.coding', count: 1 }]);
  expect(pairLosses([pt({ code: 'A' })], [pt({ ...sys, code: 'A' })])).toEqual([{ type: 'Patient', path: 'maritalStatus.coding', count: 1 }]);
});

test('an identifier value is compared without surrounding whitespace; another value is a loss', () => {
  const doc = (value: string) => ({ resourceType: 'Practitioner', identifier: [{ system: 'urn:oid:2.25.3', value }], gender: 'other' });
  expect(pairLosses([doc('  42')], [doc('42')])).toEqual([]);
  expect(pairLosses([doc('  42')], [doc('4 2')])).toEqual([{ type: 'Practitioner', path: '(record)', count: 1 }]);
});

test('an old record with no identifier pairs with a keyed new one of its type by name, or as the only one; else it is lost', () => {
  const org = (name: string, identifier?: unknown) => ({ resourceType: 'Organization', name, ...(identifier ? { identifier } : {}), address: [{ city: 'T' }] });
  expect(pairLosses([org('Payer A')], [org('Payer B', id('b')), org('Payer A', id('a'))])).toEqual([]);
  expect(pairLosses([org('Payer A')], [org('Payer B', id('b'))])).toEqual([{ type: 'Organization', path: '(record)', count: 1 }]);
  const cov = (identifier?: unknown) => ({ resourceType: 'Coverage', status: 'active', ...(identifier ? { identifier } : {}), order: 1 });
  expect(pairLosses([cov()], [cov(id('c'))])).toEqual([]);
  expect(pairLosses([cov()], [cov(id('c')), cov(id('d'))])).toEqual([{ type: 'Coverage', path: '(record)', count: 1 }]);
  expect(pairLosses([cov(), cov(id('d'))], [cov(id('c')), cov(id('d'))])).toEqual([{ type: 'Coverage', path: '(record)', count: 1 }]);
  // A keyed old record never takes this path.
  expect(pairLosses([org('Payer A', id('x'))], [org('Payer A', id('a'))])).toEqual([{ type: 'Organization', path: '(record)', count: 1 }]);
});

test('an old qualification code is covered by the specialty of a new role of the same practitioner; another code or practitioner is a loss', () => {
  const nucc = (code: string) => ({ coding: [{ system: 'http://nucc.org/provider-taxonomy', code }] });
  const old = [{ resourceType: 'Practitioner', id: 'o', identifier: id('p'), qualification: [{ code: nucc('207R00000X') }] }];
  const neu = (code: string, who = 'n') => [{ resourceType: 'Practitioner', id: 'n', identifier: id('p') },
    { resourceType: 'PractitionerRole', id: 'r', practitioner: { reference: `Practitioner/${who}` }, specialty: [nucc(code)] }];
  expect(pairLosses(old, neu('207R00000X'))).toEqual([]);
  expect(pairLosses(old, neu('208D00000X'))).toEqual([{ type: 'Practitioner', path: 'qualification.code.coding', count: 1 }]);
  expect(pairLosses(old, neu('207R00000X', 'other'))).toEqual([{ type: 'Practitioner', path: 'qualification.code.coding', count: 1 }]);
});

test('numbers and strings compare as written', () => {
  const pt = (x: object) => ({ resourceType: 'Patient', identifier: id('p'), ...x });
  expect(pairLosses([pt({ address: [{ postalCode: '01234', line: ['10'] }] })], [pt({ address: [{ postalCode: '1234', line: ['10.0'] }] })]))
    .toEqual([{ type: 'Patient', path: 'address.postalCode', count: 1 }, { type: 'Patient', path: 'address.line', count: 1 }]);
  expect(pairLosses([{ resourceType: 'Observation', identifier: id('z'), valueInteger: 0 }], [{ resourceType: 'Observation', identifier: id('z'), valueString: ' ' }]))
    .toEqual([{ type: 'Observation', path: 'value[x]', count: 1 }]);
  expect(pairLosses([{ resourceType: 'Observation', identifier: id('z'), valueQuantity: { value: 10 } }], [{ resourceType: 'Observation', identifier: id('z'), valueQuantity: { value: 10.0 } }])).toEqual([]);
});

afterEach(() => vi.unstubAllGlobals());
test('a converter answer that is not JSON fails with its status only', async () => {
  vi.stubGlobal('fetch', async () => new Response('<html>patient SECRET</html>', { status: 200 }));
  await expect(convertCcdaMs(SYNTHETIC, 'http://converter/')).rejects.toThrow(/^converter failed: HTTP 200, unexpected response$/);
});

const reader = (docs: object[], files: Record<string, string>) => {
  const reads = {
    async *searchResourcePages(type: string, q: Record<string, string>) {
      expect([type, q.identifier, q.subject]).toEqual(['DocumentReference', 'urn:ga-server:id:file|', 'Patient/p1']);
      yield docs;
    },
    download: async (url: string) => new Blob([files[url]]),
  };
  // Every other client method (create, update, delete, patch, upload, ...) throws.
  return new Proxy(reads, { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => { throw new Error(`write attempted: ${String(k)}`); }) }) as unknown as MedplumClient;
};
const doc = (url?: string) => ({ resourceType: 'DocumentReference', content: [{ attachment: { contentType: 'application/xml', ...(url && { url }) } }] });

test('compare never writes', async () => {
  const client = reader([doc('Binary/b1'), doc('Binary/b2'), doc()], { 'Binary/b1': SYNTHETIC, 'Binary/b2': '<?xml version="1.0"?><SubmitObjectsRequest/>' });
  const report = await ccdaCompare(client, 'p1', 'http://converter/', async (xml) => (xml === SYNTHETIC ? MS_SYNTHETIC() : []));
  expect(report).toMatchObject({ documents: 1, skipped: 2, failed: 0, gains: { Observation: 1 }, unaccounted: [], losses: [] });
});

test('a document the new path cannot convert is counted and fails the gate', async () => {
  // A custodian without assignedCustodian still crashes the library (mapCustodianToReference dereferences it unguarded).
  const crash = SYNTHETIC.replace(/<custodian>[\s\S]*?<\/custodian>/, '<custodian><x/></custodian>');
  expect(() => convertCcdaLocal(crash)).toThrow();
  const report = await ccdaCompare(reader([doc('Binary/b1')], { 'Binary/b1': crash }), 'p1', 'http://converter/', async () => MS_SYNTHETIC());
  expect(report).toMatchObject({ documents: 1, failed: 1, unaccounted: [{ section: '(document)', entries: 1, reason: 'document could not be converted or compared' }] });
  expect(report.losses).toContainEqual({ type: 'Observation', path: '(record)', count: 3 });
});

test('a display is compared as text when it is the only content, by presence beside a code or reference', () => {
  const al = (d: string) => ({ resourceType: 'AllergyIntolerance', identifier: id('a'), reaction: [{ manifestation: [{ coding: [{ display: d }] }] }] });
  expect(pairLosses([al('Hives')], [al('Anaphylaxis')])).toEqual([{ type: 'AllergyIntolerance', path: 'reaction.manifestation.coding.display', count: 1 }]);
  const cond = (d: string) => ({ resourceType: 'Condition', identifier: id('c'), code: { coding: [{ system: 'http://snomed.info/sct', display: d }] } });
  expect(pairLosses([cond('Asthma')], [cond('COPD')])).toEqual([{ type: 'Condition', path: 'code.coding.display', count: 1 }]);
  const imm = (d: string) => ({ resourceType: 'Immunization', identifier: id('i'), performer: [{ actor: { display: d } }] });
  expect(pairLosses([imm('Dr Alice')], [imm('Dr Bob')])).toEqual([{ type: 'Immunization', path: 'performer.actor.display', count: 1 }]);
  const ob = (d: string) => ({ resourceType: 'Observation', identifier: id('o'), code: { coding: [{ system: 'http://loinc.org', code: '13457-7', display: d }] } });
  expect(pairLosses([ob('LDL')], [ob('LDL cholesterol')])).toEqual([]); // same code: the label may differ
});

test('Coverage: the policy type the Microsoft path filed under relationship is covered by the same coding under type, nothing else', () => {
  const ppo = { system: 'urn:oid:2.16.840.1.113883.5.4', code: 'PPO', display: 'Preferred provider organization policy' };
  const hmo = { ...ppo, code: 'HMO' };
  const old = { resourceType: 'Coverage', identifier: id('c'), relationship: { coding: [ppo] } };
  expect(pairLosses([old], [{ resourceType: 'Coverage', identifier: id('c'), type: { coding: [ppo] } }])).toEqual([]);
  expect(pairLosses([old], [{ resourceType: 'Coverage', identifier: id('c'), type: { coding: [hmo] } }])).toEqual([{ type: 'Coverage', path: 'relationship.coding', count: 1 }]);
  // Every old relationship coding must be in the new type.
  const x = { system: 'urn:oid:2.25.9', code: 'X' };
  expect(pairLosses([{ ...old, relationship: { coding: [ppo, x] } }], [{ resourceType: 'Coverage', identifier: id('c'), type: { coding: [ppo] } }]))
    .toEqual([{ type: 'Coverage', path: 'relationship.coding', count: 1 }]);
  // Only Coverage, only relationship -> type.
  const ob = { resourceType: 'Observation', identifier: id('o'), relationship: { coding: [ppo] } };
  expect(pairLosses([ob], [{ resourceType: 'Observation', identifier: id('o'), type: { coding: [ppo] } }])).toEqual([{ type: 'Observation', path: 'relationship.coding', count: 1 }]);
});

test('placeholder, root-id, status and date rules stay narrow', () => {
  // An unmatched cancelled test is information.
  const cancelled = { resourceType: 'Observation', identifier: id('x'), status: 'cancelled', code: { text: 'K' } };
  expect(pairLosses([cancelled], [])).toEqual([{ type: 'Observation', path: '(record)', count: 1 }]);
  // The root-id rule: a root with no extension is the new path's URI value; another root is a loss.
  const comp = (identifier: unknown) => ({ resourceType: 'Composition', status: 'final', identifier });
  expect(pairLosses([comp({ value: '2.25.7' })], [comp({ system: 'urn:ietf:rfc:3986', value: 'urn:oid:2.25.7' })])).toEqual([]);
  expect(pairLosses([comp({ value: '2.25.7' })], [comp({ system: 'urn:ietf:rfc:3986', value: 'urn:oid:2.25.8' })])).toEqual([{ type: 'Composition', path: 'identifier', count: 1 }]);
  // The root-id rule is for the document Compositions only.
  expect(pairLosses([{ resourceType: 'Observation', identifier: [...id('o'), { value: '2.25.7' }], valueString: 'v' }], [{ resourceType: 'Observation', identifier: [...id('o'), { system: 'urn:oid:2.25.7', value: 'z' }], valueString: 'v' }]))
    .toEqual([{ type: 'Observation', path: 'identifier', count: 1 }]);
  // 'unknown' -> entered-in-error changes the meaning.
  expect(pairLosses([{ resourceType: 'Observation', identifier: id('u'), status: 'unknown', valueString: 'v' }], [{ resourceType: 'Observation', identifier: id('u'), status: 'entered-in-error', valueString: 'v' }]))
    .toEqual([{ type: 'Observation', path: 'status', count: 1 }]);
  // Date precision only for date elements: a string that looks like a year is not covered by one that looks like a month.
  expect(pairLosses([{ resourceType: 'Observation', identifier: id('s'), valueString: '1000' }], [{ resourceType: 'Observation', identifier: id('s'), valueString: '1000-12' }]))
    .toEqual([{ type: 'Observation', path: 'value[x]', count: 1 }]);
  expect(pairLosses([{ resourceType: 'Patient', identifier: id('p'), birthDate: '1970' }], [{ resourceType: 'Patient', identifier: id('p'), birthDate: '1970-01-01' }])).toEqual([]);
});

test('a converter answer that is not a Bundle fails the document', async () => {
  for (const body of [{}, { result: { resourceType: 'OperationOutcome' } }]) {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(convertCcdaMs(SYNTHETIC, 'http://converter/')).rejects.toThrow(/^converter failed: HTTP 200, unexpected response$/);
  }
});

test('a Microsoft MedicationRequest made from a dispense pairs with the new MedicationDispense of the same source id, by meaning', () => {
  const rx = (code: string) => ({ coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code }] });
  const msOrder = (status: string, code = '314076') => ({ resourceType: 'MedicationRequest', identifier: id('fill'), intent: 'order', status, medicationCodeableConcept: rx(code), subject,
    dispenseRequest: { quantity: { value: 90 }, validityPeriod: { start: '2023-01-10' } } });
  const dispense = (o: Record<string, unknown> = {}) => ({ resourceType: 'MedicationDispense', identifier: id('fill'), status: 'completed', medicationCodeableConcept: rx('314076'), subject,
    quantity: { value: 90 }, whenHandedOver: '2023-01-10', ...o });
  expect(pairLosses([msOrder('completed')], [dispense()])).toEqual([]);
  expect(pairLosses([msOrder('active')], [dispense({ status: 'in-progress' })])).toEqual([]); // the same statusCode, each type's word
  // Still losses: another drug, status, quantity or day; another source id is no pair at all.
  expect(pairLosses([msOrder('completed', '197361')], [dispense()])).toEqual([{ type: 'MedicationRequest', path: 'medication[x].coding', count: 1 }]);
  expect(pairLosses([msOrder('stopped')], [dispense()])).toEqual([{ type: 'MedicationRequest', path: 'status', count: 1 }]);
  expect(pairLosses([msOrder('completed')], [dispense({ quantity: { value: 30 }, whenHandedOver: '2023-02-01' })]))
    .toEqual([{ type: 'MedicationRequest', path: 'quantity.value', count: 1 }, { type: 'MedicationRequest', path: 'whenHandedOver', count: 1 }]);
  expect(pairLosses([msOrder('completed')], [dispense({ identifier: id('other') })])).toEqual([{ type: 'MedicationRequest', path: '(record)', count: 1 }]);
  // A validity end has no dispense field: compared as is, so it shows as a loss.
  const ended = { ...msOrder('completed'), dispenseRequest: { quantity: { value: 90 }, validityPeriod: { start: '2023-01-10', end: '2024-01-10' } } };
  expect(pairLosses([ended], [dispense()])).toEqual([{ type: 'MedicationRequest', path: 'dispenseRequest.validityPeriod.end', count: 1 }]);
  // Only a dispense: a new MedicationStatement with that id is not paired by this rule.
  expect(pairLosses([msOrder('completed')], [{ ...dispense(), resourceType: 'MedicationStatement', status: 'completed' }]))
    .toContainEqual({ type: 'MedicationRequest', path: 'resourceType', count: 1 });
});

test('the Microsoft requester of a dispense pairs with the dispense\'s dataenterer performer (the same practitioner only)', () => {
  const fn = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationdispense-performer-function', code: 'dataenterer' }] };
  const doc = (npi: string, id: string) => ({ resourceType: 'Practitioner', id, identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: npi }] });
  const old = [{ resourceType: 'MedicationRequest', identifier: id('fill'), intent: 'order', status: 'completed', subject, requester: { reference: 'Practitioner/ms-a' } }, doc('1', 'ms-a')];
  const neu = (npi: string, withFunction = true) => [{ resourceType: 'MedicationDispense', identifier: id('fill'), status: 'completed', subject,
    performer: [{ ...(withFunction && { function: fn }), actor: { reference: 'Practitioner/n' } }] }, doc(npi, 'n')];
  expect(pairLosses(old, neu('1'))).toEqual([]);
  expect(pairLosses(old, neu('2'))).toContainEqual({ type: 'MedicationRequest', path: 'performer.actor.reference', count: 1 });
  // The dispenser (a performer with no function) is not who the Microsoft path calls the requester.
  expect(pairLosses(old, neu('1', false))).toContainEqual({ type: 'MedicationRequest', path: 'performer.function.coding', count: 1 });
});

test('administrative gender: the v3 code (M, F, UN) and the FHIR code (male, female, unknown) are one coding; another gender is a loss', () => {
  const fh = (system: string, code: string) => ({ resourceType: 'FamilyMemberHistory', identifier: id('f'), sex: { coding: [{ system, code }] } });
  expect(pairLosses([fh('urn:oid:2.16.840.1.113883.5.1', 'M')], [fh('http://hl7.org/fhir/administrative-gender', 'male')])).toEqual([]);
  expect(pairLosses([fh('urn:oid:2.16.840.1.113883.5.1', 'UN')], [fh('http://hl7.org/fhir/administrative-gender', 'unknown')])).toEqual([]);
  expect(pairLosses([fh('urn:oid:2.16.840.1.113883.5.1', 'M')], [fh('http://hl7.org/fhir/administrative-gender', 'female')])).toEqual([{ type: 'FamilyMemberHistory', path: 'sex.coding', count: 1 }]);
  // Only that system: M in another code system is not male.
  expect(pairLosses([fh('urn:oid:2.25.1', 'M')], [fh('urn:oid:2.25.1', 'male')])).toEqual([{ type: 'FamilyMemberHistory', path: 'sex.coding', count: 1 }]);
});

test('a period that is one moment (end = start) is covered by a dateTime of that moment; a different end is a loss', () => {
  const dr = (x: object) => ({ resourceType: 'DiagnosticReport', identifier: id('d'), ...x });
  const t = '2024-02-10T09:10:00-05:00';
  expect(pairLosses([dr({ effectivePeriod: { start: t, end: t } })], [dr({ effectiveDateTime: t })])).toEqual([]);
  expect(pairLosses([dr({ effectivePeriod: { start: t, end: '2024-02-10T11:00:00-05:00' } })], [dr({ effectiveDateTime: t })]))
    .toEqual([{ type: 'DiagnosticReport', path: 'effective[x].end', count: 1 }]);
  // Only a choice element's Period: an ordinary Period keeps its end.
  const cov = (x: object) => ({ resourceType: 'Coverage', identifier: id('c'), ...x });
  expect(pairLosses([cov({ period: { start: '2024-01-01', end: '2024-01-01' } })], [cov({ period: { start: '2024-01-01' } })]))
    .toEqual([{ type: 'Coverage', path: 'period.end', count: 1 }]);
});

test('an unset choice key never hides a set one; the Microsoft path\'s raw CDA birth time (bornString) is the date the new path gives', () => {
  const fh = (x: object) => ({ resourceType: 'FamilyMemberHistory', identifier: id('f'), ...x });
  const age = { value: 60, system: 'http://unitsofmeasure.org', code: 'a' };
  expect(pairLosses([fh({ condition: [{ onsetAge: age }] })], [fh({ condition: [{ onsetAge: age, onsetPeriod: undefined }] })])).toEqual([]);
  expect(pairLosses([fh({ bornString: '19400315' })], [fh({ bornDate: '1940-03-15' })])).toEqual([]);
  expect(pairLosses([fh({ bornString: '19400315' })], [fh({ bornDate: '1941-03-15' })])).toEqual([{ type: 'FamilyMemberHistory', path: 'born[x].start', count: 1 }]);
  // Only digits that are a CDA date: other text stays text.
  expect(pairLosses([fh({ bornString: 'about 1940' })], [fh({ bornDate: '1940' })])).toEqual([{ type: 'FamilyMemberHistory', path: 'born[x]', count: 1 }]);
});

test('an encounter class of another system (a CPT visit code) is covered by the new type carrying it; an ActCode class or an uncarried code stays compared', () => {
  const cpt = { system: 'http://www.ama-assn.org/go/cpt', code: '99213' };
  const act = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' };
  const enc = (x: object) => ({ resourceType: 'Encounter', identifier: id('e'), ...x });
  const absent = { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }] };
  expect(pairLosses([enc({ class: cpt })], [enc({ class: absent, type: [{ coding: [cpt] }] })])).toEqual([]);
  expect(pairLosses([enc({ class: cpt })], [enc({ class: absent, type: [{ coding: [{ ...cpt, code: '99214' }] }] })])).toEqual([{ type: 'Encounter', path: 'class', count: 1 }]);
  expect(pairLosses([enc({ class: act })], [enc({ class: absent, type: [{ coding: [act] }] })])).toEqual([{ type: 'Encounter', path: 'class', count: 1 }]);
});

test('an authoring device: the old manufacturer and bare type display are covered by a new model-name deviceName of the same name, else losses', () => {
  const dev = (x: object) => ({ resourceType: 'Device', ...x });
  const old = dev({ type: { coding: [{ display: 'Example EHR' }] }, manufacturer: 'Example EHR', version: [{ value: 'v10' }] });
  expect(pairLosses([old], [dev({ deviceName: [{ name: 'Example EHR', type: 'model-name' }], version: [{ value: 'v10' }] })])).toEqual([]);
  expect(pairLosses([old], [dev({ deviceName: [{ name: 'Other EHR', type: 'model-name' }], version: [{ value: 'v10' }] })])).toEqual([
    { type: 'Device', path: 'type.coding.display', count: 1 },
    { type: 'Device', path: 'manufacturer', count: 1 },
  ]);
  expect(pairLosses([dev({ manufacturer: 'Example EHR' })], [dev({ deviceName: [{ name: 'Example EHR', type: 'user-friendly-name' }] })])).toEqual([{ type: 'Device', path: 'manufacturer', count: 1 }]);
});

test('a legal name: the old usual and the new official are one name use when the source name is use="L"; otherwise a loss', () => {
  const pt = (use: string, family = 'Epicstyle', more: object[] = []) => ({ resourceType: 'Patient', identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.5.737384.14', value: 'EXAMPLE-MRN-42' }], name: [{ use, family, given: ['Sample'] }, ...more] });
  const losses = (xml: string, o: object, n: object) => compareCcda(xml, [o as Resource], [n as Resource], []).losses;
  expect(losses(EPIC, pt('usual'), pt('official'))).toEqual([]);
  expect(losses(EPIC.replace('<name use="L">', '<name use="C">'), pt('usual'), pt('official'))).toEqual([{ type: 'Patient', path: 'name.use', count: 1 }]);
  expect(losses(EPIC, pt('usual', 'Other'), pt('official', 'Other'))).toEqual([{ type: 'Patient', path: 'name.use', count: 1 }]);
  // L "Smith John" and C "Smith Johnny": only the L name is official; the C name is usual on both paths (no false loss).
  const two = EPIC.replace('<name use="L"><given>Sample</given><family>Epicstyle</family></name>', '<name use="L"><given>John</given><family>Smith</family></name><name use="C"><given>Johnny</given><family>Smith</family></name>');
  const smith = (l: string) => ({ ...pt(l), name: [{ use: l, family: 'Smith', given: ['John'] }, { use: 'usual', family: 'Smith', given: ['Johnny'] }] });
  expect(losses(two, smith('usual'), smith('official'))).toEqual([]);
  // The C name read as official by the new path would be a loss.
  expect(losses(two, smith('usual'), { ...smith('official'), name: [{ use: 'official', family: 'Smith', given: ['John'] }, { use: 'official', family: 'Smith', given: ['Johnny'] }] }))
    .toEqual([{ type: 'Patient', path: 'name.use', count: 1 }]);
});

test('a vaccine not given: the Microsoft path\'s completed and the new not-done are a correction for a negated source entry; otherwise a loss', () => {
  const imm = (status: string) => ({ resourceType: 'Immunization', identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.768179', value: 'EX-IMM-1' }], status });
  const losses = (xml: string) => compareCcda(xml, [imm('completed') as Resource], [imm('not-done') as Resource], []).losses;
  expect(losses(EPIC.replace('negationInd="false">', 'negationInd="true">'))).toEqual([]);
  expect(losses(EPIC)).toEqual([{ type: 'Immunization', path: 'status', count: 1 }]);
});

test('a vaccine coded in http://nucc.org/cvx (unknown to GA\'s readers) is a loss against the CVX OID; http://hl7.org/fhir/sid/cvx is not', () => {
  const imm = (system: string) => ({ resourceType: 'Immunization', identifier: id('i'), vaccineCode: { coding: [{ system, code: '140' }] } });
  expect(pairLosses([imm('urn:oid:2.16.840.1.113883.12.292')], [imm('http://nucc.org/cvx')])).toEqual([{ type: 'Immunization', path: 'vaccineCode.coding', count: 1 }]);
  expect(pairLosses([imm('urn:oid:2.16.840.1.113883.12.292')], [imm('http://hl7.org/fhir/sid/cvx')])).toEqual([]);
});
