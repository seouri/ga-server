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
  // Shrinks as Tasks 4-8 land.
  expect(r.losses).toEqual([
    { type: 'Patient', path: 'name.use', count: 1 },
    { type: 'Encounter', path: 'class', count: 1 }, // CPT 99213 filed under v3-ActCode (Task 8)
    { type: 'Encounter', path: 'location.location.reference', count: 1 },
    { type: 'Location', path: '(record)', count: 1 },
  ]);
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
  // The root-id rule is for the document Compositions only.
  expect(pairLosses([{ resourceType: 'Observation', identifier: [...id('o'), { value: '2.25.7' }] }], [{ resourceType: 'Observation', identifier: [...id('o'), { system: 'urn:oid:2.25.7', value: 'z' }] }]))
    .toEqual([{ type: 'Observation', path: 'identifier', count: 1 }]);
  // 'unknown' -> entered-in-error changes the meaning.
  expect(pairLosses([{ resourceType: 'Observation', identifier: id('u'), status: 'unknown' }], [{ resourceType: 'Observation', identifier: id('u'), status: 'entered-in-error' }]))
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
