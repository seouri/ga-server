import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bundle, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { Store, StoreError } from '../store.ts';
import { searchTuning } from '../search.ts';

const BASE = 'http://store.local/';
const LOINC = 'http://loinc.org';
const TAG = 'urn:example:tag';
const UCUM = 'http://unitsofmeasure.org';
const cat = (code: string) => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }] }];

// Every plan on small data: default thresholds (drive from the smallest set), always walk the sort index, and the bounded walk.
const PLANS = [['driver', { driveMax: 5000, walkPerRow: 50 }], ['walk', { driveMax: 0, walkPerRow: 50 }], ['bounded walk', { driveMax: 5000, walkPerRow: 1 }]] as const;

describe.each(PLANS)('Store search (%s plan)', (_plan, tuning) => {
  let dir: string, store: Store, seq: number;
  const saved = { ...searchTuning };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-search-')); store = new Store(join(dir, 'store.db')); seq = 0; Object.assign(searchTuning, tuning); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); Object.assign(searchTuning, saved); });

  // Fixed ids and lastUpdated (put keeps them), in insertion order.
  const add = <T extends Resource>(r: T, lastUpdated?: string): T => {
    seq++;
    return store.put({ ...r, meta: { ...r.meta, versionId: `v${seq}`, lastUpdated: lastUpdated ?? `2024-01-01T00:00:${String(seq).padStart(2, '0')}.000Z` } }) as T;
  };
  const obs = (id: string, o: Partial<Observation> = {}): Observation => add({ resourceType: 'Observation', id, status: 'final', code: { text: 'x' }, ...o });
  const run = (type: string, q: string): Bundle => store.search(type, [...new URLSearchParams(q)], BASE);
  const ids = (type: string, q: string): string[] => (run(type, q).entry ?? []).filter((e) => e.search?.mode !== 'include').map((e) => e.resource!.id!);
  const fail = (type: string, q: string): StoreError => { try { run(type, q); } catch (e) { return e as StoreError; } throw new Error('did not throw'); };

  it('token: system|code, system|, |code, code alone and an OR list', () => {
    obs('o1', { code: { coding: [{ system: LOINC, code: '1' }] } });
    obs('o2', { code: { coding: [{ system: LOINC, code: '2' }] } });
    obs('o3', { code: { coding: [{ code: '3' }] } });
    obs('o4', { code: { coding: [{ system: 'http://other', code: '1' }] } });
    expect(ids('Observation', `code=${LOINC}|1`)).toEqual(['o1']);
    expect(ids('Observation', `code=${LOINC}|`)).toEqual(['o1', 'o2']);
    expect(ids('Observation', 'code=|3')).toEqual(['o3']);
    expect(ids('Observation', 'code=1')).toEqual(['o1', 'o4']);
    expect(ids('Observation', `code=${LOINC}|1,|3`)).toEqual(['o1', 'o3']);
  });

  it('token match is case-sensitive, as Medplum (status, codes, identifiers)', () => {
    obs('k1', { identifier: [{ system: 'urn:x', value: 'AbC' }], category: cat('laboratory') });
    expect(ids('Observation', 'status=final')).toEqual(['k1']);
    expect(ids('Observation', 'status=FINAL')).toEqual([]);
    expect(ids('Observation', 'category=LABORATORY')).toEqual([]);
    expect(ids('Observation', 'identifier=urn:x|AbC')).toEqual(['k1']);
    expect(ids('Observation', 'identifier=urn:x|abc')).toEqual([]);
  });

  it('_tag and _tag:not (untagged resources count as not tagged)', () => {
    obs('a', { meta: { tag: [{ system: TAG, code: 'src-apple-health' }] } });
    obs('b', { meta: { tag: [{ system: TAG, code: 'src-smart' }] } });
    obs('c');
    expect(ids('Observation', `_tag=${TAG}|src-apple-health`)).toEqual(['a']);
    expect(ids('Observation', `_tag:not=${TAG}|src-apple-health`)).toEqual(['b', 'c']);
  });

  it('code:text: case-insensitive substring of CodeableConcept.text and Coding.display, not of the code', () => {
    obs('t1', { code: { text: 'LDL Cholesterol' } });
    obs('t2', { code: { coding: [{ system: LOINC, code: '13457-7', display: 'Serum ldl-c' }] } });
    obs('t3', { code: { coding: [{ system: LOINC, code: 'ldl' }] } });
    obs('t4', { code: { text: 'HDL' } });
    expect(ids('Observation', 'code:text=lDl')).toEqual(['t1', 't2']);
    expect(ids('Observation', 'code:text=l c')).toEqual(['t1']);
    expect(ids('Observation', 'code:text=nothing')).toEqual([]);
  });

  it('string: starts-with by default (case-insensitive), :contains, :exact (case-sensitive)', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe' }] });
    add({ resourceType: 'Patient', id: 'p2', name: [{ family: 'Doering' }] });
    add({ resourceType: 'Patient', id: 'p3', name: [{ family: 'McDoe' }] });
    expect(ids('Patient', 'name=doe')).toEqual(['p1', 'p2']);
    expect(ids('Patient', 'name:contains=DOE')).toEqual(['p1', 'p2', 'p3']);
    expect(ids('Patient', 'name:exact=Doe')).toEqual(['p1']);
    expect(ids('Patient', 'name:exact=doe')).toEqual([]);
  });

  it('date: eq/ge/gt/le/lt on days and times; a Period with no end ends at its start', () => {
    obs('d1', { effectiveDateTime: '2023-12-31T12:00:00Z' });
    obs('d2', { effectiveDateTime: '2024-05-10' });
    obs('d3', { effectiveDateTime: '2024-07-01T00:00:00Z' });
    obs('d4', { effectivePeriod: { start: '2024-05-20T00:00:00Z' } });
    obs('d5', { effectivePeriod: { start: '2024-04-01T00:00:00Z', end: '2024-06-15T00:00:00Z' } });
    obs('d6', { effectiveDateTime: '2024-05-10T15:00:00Z' });
    expect(ids('Observation', 'date=2024-05-10')).toEqual(['d2', 'd6']);
    expect(ids('Observation', 'date=eq2024-05-10')).toEqual(['d2', 'd6']); // eq: the day contains the value (FHIR, Medplum), not overlap
    expect(ids('Observation', 'date=ne2024-05-10')).toEqual(['d1', 'd3', 'd4', 'd5']);
    expect(ids('Observation', 'date=ap2024-05-10')).toEqual(['d2', 'd5', 'd6']);
    expect(ids('Observation', 'date=ge2024-07-01')).toEqual(['d3']);
    expect(ids('Observation', 'date=lt2024-01-01')).toEqual(['d1']);
    expect(ids('Observation', 'date=gt2024-05-21')).toEqual(['d3', 'd5']); // d4 is not open-ended
    expect(ids('Observation', 'date=ge2024-05-01&date=lt2024-06-01')).toEqual(['d2', 'd4', 'd5', 'd6']);
    expect(ids('Observation', 'date=ge2024-05-10T12:00:00Z')).toEqual(['d2', 'd3', 'd4', 'd5', 'd6']);
  });

  it('date: a partial date (2024, 2024-05) is refused, as Medplum refuses it', () => {
    obs('p1', { effectiveDateTime: '2024-05-10' });
    for (const q of ['date=2024', 'date=ge2024-05', 'date=lt2024', '_lastUpdated=ge2024-02']) expect(fail('Observation', q).message, q).toMatch(/^Invalid date value: /);
  });

  it('_lastUpdated ranges', () => {
    obs('l1'); obs('l2'); obs('l3');
    store.put({ ...store.read('Observation', 'l2')!, meta: { versionId: 'x', lastUpdated: '2024-02-15T00:00:00.000Z' } });
    store.put({ ...store.read('Observation', 'l3')!, meta: { versionId: 'y', lastUpdated: '2024-03-01T00:00:00.000Z' } });
    expect(ids('Observation', '_lastUpdated=ge2024-02-01&_lastUpdated=lt2024-03-01')).toEqual(['l2']);
    expect(ids('Observation', '_lastUpdated=ge2024-02-01')).toEqual(['l2', 'l3']);
    expect(ids('Observation', '_lastUpdated=lt2024-02-01')).toEqual(['l1']);
  });

  it('reference: subject=Patient/x and a bare id', () => {
    obs('r1', { subject: { reference: 'Patient/x' } });
    obs('r2', { subject: { reference: 'Patient/y' } });
    obs('r3', { subject: { reference: 'Group/x' } });
    expect(ids('Observation', 'subject=Patient/x')).toEqual(['r1']);
    expect(ids('Observation', 'patient=x')).toEqual(['r1']); // one target type
  });

  it(':missing=true/false', () => {
    obs('m1', { valueQuantity: { value: 1, unit: 'mg', system: UCUM, code: 'mg' } });
    obs('m2');
    expect(ids('Observation', 'value-quantity:missing=true')).toEqual(['m2']);
    expect(ids('Observation', 'value-quantity:missing=false')).toEqual(['m1']);
  });

  it(':not', () => {
    obs('n1', { status: 'final' }); obs('n2', { status: 'amended' }); obs('n3', { status: 'cancelled' });
    expect(ids('Observation', 'status:not=final')).toEqual(['n2', 'n3']);
    expect(ids('Observation', 'status:not=final&status:not=cancelled')).toEqual(['n2']);
  });

  it('_id list', () => {
    obs('i1'); obs('i2'); obs('i3');
    expect(ids('Observation', '_id=i3,i1')).toEqual(['i1', 'i3']);
  });

  it('_filter: category eq X or _tag eq Y', () => {
    obs('f1', { category: cat('laboratory') });
    obs('f2', { category: cat('vital-signs'), meta: { tag: [{ system: TAG, code: 'extracted-by-llm' }] } });
    obs('f3', { category: cat('vital-signs') });
    expect(ids('Observation', `_filter=category eq laboratory or _tag eq ${TAG}|extracted-by-llm`)).toEqual(['f1', 'f2']);
  });

  it('_include MedicationStatement:medication', () => {
    add({ resourceType: 'Medication', id: 'med1', code: { text: 'metformin' } });
    add({ resourceType: 'MedicationStatement', id: 'ms1', status: 'active', subject: { reference: 'Patient/x' }, medicationReference: { reference: 'Medication/med1' } });
    add({ resourceType: 'MedicationStatement', id: 'ms2', status: 'active', subject: { reference: 'Patient/x' }, medicationCodeableConcept: { text: 'aspirin' } });
    const b = run('MedicationStatement', '_include=MedicationStatement:medication');
    expect(b.entry!.map((e) => [e.resource!.id, e.search!.mode])).toEqual([['ms1', 'match'], ['ms2', 'match'], ['med1', 'include']]);
  });

  it('_revinclude Provenance:target', () => {
    obs('o1'); obs('o2');
    add({ resourceType: 'Provenance', id: 'pv1', target: [{ reference: 'Observation/o2' }], recorded: '2024-01-01T00:00:00Z', agent: [{ who: { display: 'Importer' } }] });
    const b = run('Observation', '_revinclude=Provenance:target');
    expect(b.entry!.map((e) => [e.resource!.id, e.search!.mode])).toEqual([['o1', 'match'], ['o2', 'match'], ['pv1', 'include']]);
  });

  it('one-level chain: patient.name=Doe', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe' }] });
    add({ resourceType: 'Patient', id: 'p2', name: [{ family: 'Roe' }] });
    obs('c1', { subject: { reference: 'Patient/p1' } });
    obs('c2', { subject: { reference: 'Patient/p2' } });
    expect(ids('Observation', 'patient.name=Doe')).toEqual(['c1']);
    expect(ids('Observation', 'subject:Patient.name=roe')).toEqual(['c2']);
  });

  it('chain to a date parameter takes its prefix, as Medplum: patient.birthdate=lt2000-01-01', () => {
    add({ resourceType: 'Patient', id: 'p1', birthDate: '1980-05-01' });
    add({ resourceType: 'Patient', id: 'p2', birthDate: '2010-05-01' });
    obs('d1', { subject: { reference: 'Patient/p1' } });
    obs('d2', { subject: { reference: 'Patient/p2' } });
    expect(ids('Observation', 'patient.birthdate=lt2000-01-01')).toEqual(['d1']);
    expect(ids('Observation', 'patient.birthdate=lt1800-01-01')).toEqual([]);
    const e = fail('Observation', 'patient.birthdate=zz2000'); // the parser throws on the chained value: a bad request, not a 500
    expect(e).toBeInstanceOf(StoreError);
    expect(e.status).toBe(400);
  });

  it('_has:Observation:patient:code=X', () => {
    add({ resourceType: 'Patient', id: 'p1' });
    add({ resourceType: 'Patient', id: 'p2' });
    obs('h1', { subject: { reference: 'Patient/p2' }, code: { coding: [{ system: LOINC, code: 'X' }] } });
    obs('h2', { subject: { reference: 'Patient/p1' }, code: { coding: [{ system: LOINC, code: 'Y' }] } });
    expect(ids('Patient', '_has:Observation:patient:code=X')).toEqual(['p2']);
  });

  it('quantity with prefixes, system and unit', () => {
    const q = (id: string, value: number, code = 'mg/dL') => obs(id, { valueQuantity: { value, unit: code, system: UCUM, code } });
    q('q1', 4); q('q2', 5.4); q('q3', 7); q('q4', 5.4, 'mmol/L');
    expect(ids('Observation', 'value-quantity=gt5')).toEqual(['q2', 'q3', 'q4']);
    expect(ids('Observation', 'value-quantity=lt5')).toEqual(['q1']);
    expect(ids('Observation', 'value-quantity=ge5.4&value-quantity=le7')).toEqual(['q2', 'q3', 'q4']);
    expect(ids('Observation', `value-quantity=5.4|${UCUM}|mg/dL`)).toEqual(['q2']);
    expect(ids('Observation', `value-quantity=le5.4|${UCUM}|mmol/L`)).toEqual(['q4']);
  });

  it('_sort=-date,_id puts undated records first on -date and breaks ties by id', () => {
    obs('s2', { effectiveDateTime: '2024-01-01' });
    obs('s1', { effectiveDateTime: '2024-01-01' });
    obs('s3', { effectiveDateTime: '2025-01-01' });
    obs('s4');
    obs('s0', { effectiveDateTime: '2023-01-01' });
    expect(ids('Observation', '_sort=-date,_id')).toEqual(['s4', 's3', 's1', 's2', 's0']);
    expect(ids('Observation', '_sort=date,_id')).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(ids('Observation', '_sort=-_lastUpdated')).toEqual(['s0', 's4', 's3', 's1', 's2']);
  });

  it('_count with next links (cursor) returns every id exactly once, in order, for sorted and unsorted queries', () => {
    const dates = ['2024-03-01', '2024-01-01', undefined, '2024-01-01', '2024-02-01', undefined, '2024-05-01'];
    dates.forEach((d, i) => obs(`p${i}`, d ? { effectiveDateTime: d } : {}));
    for (const q of ['_sort=-date,_id&_count=2', '_count=3', '_sort=_lastUpdated&_count=2', '_sort=date&_count=1']) {
      const all = ids('Observation', q.replace(/&_count=\d+/, '&_count=100').replace(/^_count=\d+/, '_count=100'));
      const got: string[] = [];
      let b = run('Observation', q);
      for (let pages = 0; pages < 20; pages++) {
        got.push(...(b.entry ?? []).map((e) => e.resource!.id!));
        const next = b.link?.find((l) => l.relation === 'next')?.url;
        if (!next) break;
        expect(next.startsWith(`${BASE}fhir/R4/Observation?`)).toBe(true);
        const u = new URL(next);
        expect(u.searchParams.has('_cursor')).toBe(true);
        expect(u.searchParams.has('_offset')).toBe(false);
        b = store.search('Observation', [...u.searchParams], BASE);
      }
      expect(got).toEqual(all);
      expect(new Set(got).size).toBe(7);
    }
    expect(ids('Observation', '_sort=_id&_count=2&_offset=2')).toEqual(['p2', 'p3']); // _offset still accepted
  });

  it('filtered, sorted paging with tied dates returns every match once, in order', () => {
    for (let i = 0; i < 12; i++) obs(`f${String(i).padStart(2, '0')}`, { status: i % 3 ? 'final' : 'amended', ...(i % 5 ? { effectiveDateTime: `2024-0${1 + (i % 3)}-01` } : {}) });
    for (const q of ['status=final&_sort=-date,_id&_count=2', 'status=final&_sort=date&_count=3', 'status=final&_sort=-_lastUpdated&_count=2']) {
      const want = ids('Observation', q.replace(/_count=\d+/, '_count=100'));
      expect(want).toHaveLength(8);
      const got: string[] = [];
      let b = run('Observation', q);
      for (let pages = 0; pages < 20 && b; pages++) {
        got.push(...(b.entry ?? []).map((e) => e.resource!.id!));
        const next = b.link?.find((l) => l.relation === 'next')?.url;
        b = next ? store.search('Observation', [...new URL(next).searchParams], BASE) : undefined!;
      }
      expect(got).toEqual(want);
    }
    expect(ids('Observation', 'status=final&_sort=-date,_id&_count=100').slice(0, 4)).toEqual(['f05', 'f10', 'f02', 'f08']);
  });

  it('_elements keeps required fields and adds the SUBSETTED tag; next links carry it as _fields', () => {
    obs('e1', { valueQuantity: { value: 1, unit: 'mg', system: UCUM, code: 'mg' }, code: { text: 'A' } });
    obs('e2');
    const b = run('Observation', '_elements=id,code&_count=1');
    expect(b.entry![0].resource).toEqual({
      resourceType: 'Observation', id: 'e1', status: 'final', code: { text: 'A' },
      meta: { versionId: 'v1', lastUpdated: '2024-01-01T00:00:01.000Z', tag: [{ system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' }] },
    });
    const next = new URL(b.link!.find((l) => l.relation === 'next')!.url!);
    expect(next.searchParams.get('_fields')).toBe('id,code');
    expect(next.searchParams.has('_elements')).toBe(false);
    expect(store.search('Observation', [...next.searchParams], BASE).entry!.map((e) => Object.keys(e.resource!).sort())).toEqual([['code', 'id', 'meta', 'resourceType', 'status']]);
  });

  it('_summary=count and _total=accurate', () => {
    obs('a1'); obs('a2'); obs('a3', { status: 'amended' });
    const c = run('Observation', 'status=final&_summary=count');
    expect(c.total).toBe(2);
    expect(c.entry).toBeUndefined();
    const t = run('Observation', '_total=accurate&_count=1');
    expect(t.total).toBe(3);
    expect(t.entry).toHaveLength(1);
    expect(run('Observation', '_count=1').total).toBeUndefined();
    // Medplum reads params in order: a _count after _summary=count brings the entries back (a client may send _count last).
    const later = run('Observation', 'status=final&_summary=count&_count=20');
    expect(later.total).toBe(2);
    expect(later.entry).toHaveLength(2);
    expect(run('Observation', '_count=20&_summary=count').entry).toBeUndefined();
  });

  it('_compartment=Patient/x', () => {
    obs('k1', { subject: { reference: 'Patient/x' } });
    obs('k2', { subject: { reference: 'Patient/y' } });
    add({ resourceType: 'Immunization', id: 'im1', status: 'completed', vaccineCode: { text: 'flu' }, patient: { reference: 'Patient/x' }, occurrenceDateTime: '2024-01-01' });
    expect(ids('Observation', '_compartment=Patient/x')).toEqual(['k1']);
    expect(ids('Immunization', '_compartment=Patient/x')).toEqual(['im1']);
  });

  it('updates and deletes change what matches', () => {
    const o = obs('u1', { status: 'final' });
    obs('u2', { status: 'final' });
    store.update({ ...o, status: 'amended' });
    store.delete('Observation', 'u2');
    expect(ids('Observation', 'status=final')).toEqual([]);
    expect(ids('Observation', 'status=amended')).toEqual(['u1']);
  });

  it('If-None-Exist uses search', () => {
    obs('n1', { identifier: [{ system: 'urn:x', value: '1' }] });
    expect(store.create({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, identifier: [{ system: 'urn:x', value: '1' }] }, 'identifier=urn:x|1')).toMatchObject({ created: false, resource: { id: 'n1' } });
  });

  it('a reference type modifier is that type: subject:Group=a is Group/a, never Patient/a; a type that is not a target is 400', () => {
    obs('o1', { subject: { reference: 'Patient/a' } });
    obs('o2', { subject: { reference: 'Group/a' } });
    expect(ids('Observation', 'subject:Group=a')).toEqual(['o2']);
    expect(ids('Observation', 'subject:Patient=a')).toEqual(['o1']);
    expect(ids('Observation', 'subject:Patient=a,b')).toEqual(['o1']);
    expect(ids('Observation', 'subject:Group=Group/a')).toEqual(['o2']);
    expect(fail('Observation', 'subject:Medication=a').status).toBe(400);
    expect(fail('Observation', 'subject:Group=Patient/a').status).toBe(400);
  });

  it('_type on a type-level search and a non-numeric _count or _offset are 400', () => {
    obs('o1');
    expect(fail('Observation', '_type=Condition').status).toBe(400);
    expect(fail('Observation', '_count=abc').status).toBe(400);
    expect(fail('Observation', '_offset=-1').status).toBe(400);
    expect(ids('Observation', '_count=5&_offset=0')).toEqual(['o1']);
  });

  it('unsupported features are 400 naming the feature; unknown params and types are errors', () => {
    obs('x1');
    expect(fail('Observation', 'code:in=http://vs').status).toBe(400);
    expect(fail('Observation', 'code:in=http://vs').message).toMatch(/:in/);
    expect(fail('Observation', 'code:below=x').message).toMatch(/:below/);
    for (const q of ['_summary=nonsense', 'code:of-type=a|b|c', 'code:not-in=http://vs', 'code:above=x', '_contained=true', '_text=x', '_content=x']) expect(fail('Observation', q).status, q).toBe(400);
    expect(run('Observation', '_summary=false').entry).toHaveLength(1); // a no-op, as Medplum
    const u = fail('Observation', 'nonsense=1');
    expect(u.status).toBe(400);
    expect(u.message).toMatch(/Unknown search parameter/);
    expect(fail('Nonsense', 'url=x').status).toBe(400);
    expect(run('ValueSet', 'url=x').entry ?? []).toHaveLength(0); // every R4 type by default
  });

  it('links as Medplum: self always; first, next and previous only on a non-empty page; _count=0 keeps self', () => {
    obs('l1'); obs('l2'); obs('l3');
    const rels = (q: string) => run('Observation', q).link?.map((l) => l.relation);
    expect(rels('_count=1')).toEqual(['self', 'first', 'next']);
    expect(rels('_count=0')).toEqual(['self']);
    expect(rels('_count=1&_offset=1')).toEqual(['self', 'first', 'next', 'previous']);
    expect(rels('_count=5')).toEqual(['self', 'first']);
    expect(rels('status=amended')).toEqual(['self']);
    const b = run('Observation', '_count=1&_offset=2&status=final');
    expect(new URL(b.link!.find((l) => l.relation === 'previous')!.url!).search).toBe('?_count=1&status=final&_offset=1');
    expect(new URL(b.link!.find((l) => l.relation === 'first')!.url!).search).toBe('?_count=1&status=final');
  });

  it('_elements keeps the primitive extension of a kept element (_birthDate)', () => {
    add({ resourceType: 'Patient', id: 'p1', birthDate: '2000-01-01', _birthDate: { extension: [{ url: 'urn:x', valueString: 'y' }] }, gender: 'male' } as Resource);
    expect(run('Patient', '_elements=birthDate').entry![0].resource).toMatchObject({ birthDate: '2000-01-01', _birthDate: { extension: [{ url: 'urn:x', valueString: 'y' }] } });
  });

  it('a chained _id matches the reference itself, as Medplum (the target need not exist)', () => {
    add({ resourceType: 'Patient', id: 'p1', managingOrganization: { reference: 'Organization/o1' } });
    expect(ids('Patient', 'organization._id=o1')).toEqual(['p1']);
  });

  it('_has parses its inner parameter as the other type\'s own (modifier, prefix)', () => {
    add({ resourceType: 'Patient', id: 'p1' });
    add({ resourceType: 'Patient', id: 'p2' });
    obs('o1', { subject: { reference: 'Patient/p1' }, valueQuantity: { value: 101, system: UCUM, code: '[degF]' } });
    expect(ids('Patient', '_has:Observation:subject:value-quantity=gt100')).toEqual(['p1']);
    expect(ids('Patient', '_has:Observation:subject:value-quantity=gt200')).toEqual([]);
    expect(ids('Patient', '_has:Observation:subject:_id:missing=false')).toEqual(['p1']);
  });

  it('token :contains is 400: R4 defines :contains for strings only (Medplum accepts it)', () => {
    obs('t1', { code: { text: 'LDL Cholesterol' } });
    expect(fail('Observation', 'code:contains=chol').status).toBe(400);
    expect(fail('ServiceRequest', 'order-detail:contains=x').message).toMatch(/:contains/);
  });

  it('dateTime search values with minutes only are accepted (Medplum\'s date format)', () => {
    obs('d1', { effectiveDateTime: '2024-01-01T10:00:00Z' });
    expect(ids('Observation', 'date=gt2024-01-01T09:59')).toEqual(['d1']);
    expect(ids('Observation', 'date=lt2024-01-01T09:59Z')).toEqual([]);
    expect(fail('Observation', 'date=lt2024-01-01T09:59:00-15:00').status).toBe(400);
  });

  it('error texts as Medplum: unknown parameter, null bytes', () => {
    expect(fail('ServiceRequest', 'basedOn=ServiceRequest/123').message).toBe('Unknown search parameter: basedOn');
    expect(fail('Patient', '_id=foo\u0000bar').message).toBe('Search filter value cannot contain null bytes');
  });

  it('name matches from any word of a HumanName, as Medplum (given then family); :exact and _sort use the whole name', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ given: ['Alice'], family: 'Zed-Smith' }] });
    add({ resourceType: 'Patient', id: 'p2', name: [{ given: ['Bob'], family: 'Adams' }] });
    expect(ids('Patient', 'name=zed-smi')).toEqual(['p1']);
    expect(ids('Patient', 'name=alice zed')).toEqual(['p1']);
    expect(ids('Patient', 'name:exact=Zed-Smith')).toEqual([]);
    expect(ids('Patient', 'name:exact=Alice Zed-Smith')).toEqual(['p1']);
    expect(ids('Patient', '_sort=name')).toEqual(['p1', 'p2']); // "alice zed-smith" < "bob adams"
  });

  it('a name matches by the parts of a word (Zed-Smith, O\'Brien), an address by whole words only, as Medplum', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ given: ['Alice'], family: "Zed-Smith O'Brien" }], address: [{ line: ['12 Fake-Street'] }] });
    expect(ids('Patient', 'name=smith')).toEqual(['p1']);
    expect(ids('Patient', 'name=zed')).toEqual(['p1']);
    expect(ids('Patient', 'name=brien')).toEqual(['p1']);
    expect(ids('Patient', 'address=fake')).toEqual(['p1']);
    expect(ids('Patient', 'address=street')).toEqual([]);
  });

  it('ContactPoint tokens are case-insensitive (Medplum); other tokens stay case-sensitive', () => {
    add({ resourceType: 'Practitioner', id: 'r1', telecom: [{ system: 'email', value: 'UPPER@EXAMPLE.COM' }], identifier: [{ value: 'MiXeD' }] });
    expect(ids('Practitioner', 'telecom=uPpeR@ExAmPlE.CoM')).toEqual(['r1']);
    expect(ids('Practitioner', 'email=upper@example.com')).toEqual(['r1']);
    expect(ids('Practitioner', 'identifier=mixed')).toEqual([]);
  });

  it('an empty searchset has no entry, as Medplum', () => {
    expect(run('Observation', 'code=none')).not.toHaveProperty('entry');
  });

  it('system| matches an identifier with that system and no value; token values are trimmed, as Medplum', () => {
    add({ resourceType: 'Patient', id: 'p1', identifier: [{ system: 'urn:s' }] });
    add({ resourceType: 'Patient', id: 'p2', identifier: [{ system: 'urn:s', value: ' v2' }] });
    expect(ids('Patient', 'identifier=urn:s|')).toEqual(['p1', 'p2']);
    expect(ids('Patient', 'identifier=v2')).toEqual(['p2']);
    expect(ids('Patient', 'identifier=urn:s|v2')).toEqual(['p2']);
  });

  it('_revinclude with a target type follows only matches of that type', () => {
    add({ resourceType: 'Task', id: 't1', status: 'completed', intent: 'order' });
    add({ resourceType: 'AuditEvent', id: 'a1', recorded: '2026-01-01T00:00:00Z', type: { code: 'rest' }, agent: [{ requestor: true }], source: { observer: { display: 'x' } }, entity: [{ what: { reference: 'Task/t1' } }] } as Resource);
    const inc = (q: string) => (run('Task', q).entry ?? []).filter((e) => e.search?.mode === 'include').map((e) => e.resource!.id);
    expect(inc('_revinclude=AuditEvent:entity:Task')).toEqual(['a1']);
    expect(inc('_revinclude=AuditEvent:entity:Patient')).toEqual([]);
  });

  it('a Period with an end only sorts by its end, as Medplum', () => {
    add({ resourceType: 'Task', id: 't2', status: 'requested', intent: 'order', restriction: { period: { start: '2023-06-02T00:00:00Z' } } });
    add({ resourceType: 'Task', id: 't3', status: 'requested', intent: 'order', restriction: { period: { end: '2023-06-03T00:00:00Z' } } });
    expect(ids('Task', '_sort=due-date')).toEqual(['t2', 't3']);
    expect(ids('Task', '_sort=-due-date')).toEqual(['t3', 't2']);
  });

  it('link parameter names stay unencoded (code:not=x), values encoded, as Medplum', () => {
    obs('n1'); obs('n2');
    const next = run('Observation', 'code:not=x&_count=1').link!.find((l) => l.relation === 'next')!.url!;
    expect(next).toContain('code:not=x');
  });

  it('error texts as Medplum: unknown sort parameter, invalid _include', () => {
    expect(fail('Patient', '_sort=xyz').message).toBe('Unknown search parameter: xyz');
    expect(fail('ServiceRequest', '_include=ServiceRequest:xyz').message).toBe('Invalid include parameter: ServiceRequest:xyz');
    expect(fail('ServiceRequest', '_revinclude=Observation:xyz').message).toBe('Invalid include parameter: Observation:xyz');
  });

  const SUBSETTED = { system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' };
  const pt = { resourceType: 'Patient', id: 'p1', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">x</div>' }, name: [{ family: 'Doe' }],
    birthDate: '2000-01-01', multipleBirthInteger: 2, photo: [{ url: 'http://x/p.png' }] } satisfies Patient;
  const one = (type: string, q: string) => run(type, q).entry![0].resource as Resource & Record<string, unknown>;

  it('_summary=true keeps summary elements only', () => {
    add(pt);
    const r = one('Patient', '_summary=true');
    expect(Object.keys(r).sort()).toEqual(['birthDate', 'id', 'meta', 'name', 'resourceType']);
    expect(r.meta?.tag).toEqual([SUBSETTED]);
  });

  it('_summary=data drops text only', () => {
    add(pt);
    const r = one('Patient', '_summary=data');
    expect(Object.keys(r).sort()).toEqual(['birthDate', 'id', 'meta', 'multipleBirthInteger', 'name', 'photo', 'resourceType']);
    expect(r.meta?.tag).toEqual([SUBSETTED]);
  });

  it('_summary=text keeps text, id, meta and mandatory elements', () => {
    obs('o1', { text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">x</div>' }, valueString: 'v', subject: { reference: 'Patient/p1' } });
    expect(Object.keys(one('Observation', '_summary=text')).sort()).toEqual(['code', 'id', 'meta', 'resourceType', 'status', 'text']);
    expect(Object.keys(one('Observation', '_summary=text&_elements=subject')).sort()).toEqual(['code', 'id', 'meta', 'resourceType', 'status', 'subject']); // _elements wins, as Medplum
    add({ resourceType: 'Patient', id: 'p1', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">x</div>' }, multipleBirthInteger: 2 });
    // Includes are subsetted too, as Medplum (removeResourceFields on every entry).
    const inc = (q: string) => Object.keys(run('Observation', q).entry![1].resource!).sort();
    expect(inc('_summary=true&_include=Observation:subject')).toEqual(['id', 'meta', 'resourceType']);
    expect(inc('_summary=text&_include=Observation:subject')).toEqual(['id', 'meta', 'resourceType', 'text']);
    expect(inc('_elements=multipleBirth&_include=Observation:subject')).toEqual(['id', 'meta', 'multipleBirthInteger', 'resourceType']);
  });

  const chain = (n: number) => { for (let i = n; i >= 1; i--) add({ resourceType: 'Patient', id: `l${i}`, ...(i < n && { link: [{ type: 'replaces', other: { reference: `Patient/l${i + 1}` } }] }) }); };
  const incs = (type: string, q: string) => (run(type, q).entry ?? []).filter((e) => e.search?.mode === 'include').map((e) => `${e.resource!.resourceType}/${e.resource!.id}`);

  it('_include:iterate follows includes of included resources up to Medplum\'s depth', () => {
    add({ resourceType: 'Patient', id: 'p1' });
    add({ resourceType: 'Encounter', id: 'e1', status: 'finished', class: { code: 'AMB' }, subject: { reference: 'Patient/p1' } });
    obs('o1', { encounter: { reference: 'Encounter/e1' } });
    expect(incs('Observation', '_include=Observation:encounter&_include:iterate=Encounter:subject')).toEqual(['Encounter/e1', 'Patient/p1']);
    expect(incs('Observation', '_include=Observation:encounter&_include=Encounter:subject')).toEqual(['Encounter/e1']); // no :iterate, no second round
    expect(incs('Observation', '_include=Observation:encounter&_include:iterate=Observation:subject')).toEqual(['Encounter/e1']); // an Encounter has no Observation rows
    // l1 → l2 → … : five rounds that each find something is Medplum's limit.
    chain(5);
    expect(incs('Patient', '_id=l1&_include:iterate=Patient:link')).toEqual(['Patient/l2', 'Patient/l3', 'Patient/l4', 'Patient/l5']);
    chain(6);
    const e = fail('Patient', '_id=l1&_include:iterate=Patient:link');
    expect([e.status, e.message]).toEqual([400, 'Search with _(rev)include reached query scope limit: depth=5, results=6']);
  });

  it('_revinclude:iterate', () => {
    add({ resourceType: 'Patient', id: 'p1' });
    add({ resourceType: 'Patient', id: 'l1', link: [{ type: 'replaced-by', other: { reference: 'Patient/p1' } }] });
    add({ resourceType: 'Patient', id: 'l2', link: [{ type: 'replaced-by', other: { reference: 'Patient/l1' } }] }); // reached only by iterating Patient:link
    obs('o1', { subject: { reference: 'Patient/p1' } });
    obs('o2', { hasMember: [{ reference: 'Observation/o1' }] });
    obs('o3', { subject: { reference: 'Patient/l1' } });
    expect(incs('Patient', '_id=p1&_revinclude=Patient:link&_revinclude:iterate=Observation:subject&_revinclude:iterate=Observation:has-member').sort())
      .toEqual(['Observation/o1', 'Observation/o2', 'Observation/o3', 'Patient/l1']);
  });

  it('_include on a canonical reference (Questionnaire from QuestionnaireResponse), and _revinclude back', () => {
    add({ resourceType: 'Questionnaire', id: 'q1', status: 'active', url: 'http://example.com/q' });
    add({ resourceType: 'Questionnaire', id: 'q2', status: 'active', url: 'http://example.com/q-extra' });
    add({ resourceType: 'Questionnaire', id: 'q3', status: 'active', url: 'http://example.com/v', version: '2' });
    add({ resourceType: 'Questionnaire', id: 'q4', status: 'active', url: 'http://example.com/v', version: '3' });
    add({ resourceType: 'QuestionnaireResponse', id: 'r1', status: 'completed', questionnaire: 'http://example.com/q' });
    add({ resourceType: 'QuestionnaireResponse', id: 'r2', status: 'completed', questionnaire: 'http://example.com/v|2' });
    expect(incs('QuestionnaireResponse', '_id=r1&_include=QuestionnaireResponse:questionnaire')).toEqual(['Questionnaire/q1']);
    // url|version: the Questionnaire with that url and version (R4 canonical; Medplum resolves none).
    expect(incs('QuestionnaireResponse', '_id=r2&_include=QuestionnaireResponse:questionnaire')).toEqual(['Questionnaire/q3']);
    expect(incs('QuestionnaireResponse', '_id=r1&_include=QuestionnaireResponse:questionnaire:PlanDefinition')).toEqual([]);
    expect(incs('Questionnaire', '_id=q1&_revinclude=QuestionnaireResponse:questionnaire')).toEqual(['QuestionnaireResponse/r1']);
    expect(incs('Questionnaire', '_id=q3,q4&_revinclude=QuestionnaireResponse:questionnaire')).toEqual(['QuestionnaireResponse/r2']);
    add({ resourceType: 'ActivityDefinition', id: 'a1', status: 'active', url: 'http://example.com/a1' });
    add({ resourceType: 'ActivityDefinition', id: 'a2', status: 'active', url: 'http://example.com/a2' });
    add({ resourceType: 'PlanDefinition', id: 'pd', status: 'active', action: [{ definitionCanonical: 'http://example.com/a1' }, { definitionUri: 'http://example.com/a2' }] });
    expect(incs('PlanDefinition', '_include=PlanDefinition:definition')).toEqual(['ActivityDefinition/a1', 'ActivityDefinition/a2']);
  });

  it('_include=* is 400, as Medplum 5.2.14', () => {
    expect(fail('Observation', '_include=*').status).toBe(400);
    expect(fail('Observation', '_include=Observation:*').message).toBe("'*' is not supported as a value for search inclusion parameters");
  });

  it('two-level chain: Observation?subject:Patient.organization.name=…', () => {
    add({ resourceType: 'Organization', id: 'g1', name: 'Alpha Clinic' });
    add({ resourceType: 'Organization', id: 'g2', name: 'Beta Clinic' });
    add({ resourceType: 'Patient', id: 'p1', managingOrganization: { reference: 'Organization/g1' } });
    add({ resourceType: 'Patient', id: 'p2', managingOrganization: { reference: 'Organization/g2' } });
    obs('o1', { subject: { reference: 'Patient/p1' } });
    obs('o2', { subject: { reference: 'Patient/p2' } });
    expect(ids('Observation', 'subject:Patient.organization.name=alpha')).toEqual(['o1']);
    expect(ids('Observation', 'patient.organization.name:exact=Beta Clinic')).toEqual(['o2']); // a modifier on the last parameter
    expect(ids('Observation', 'patient.organization.name:exact=beta clinic')).toEqual([]);
    expect(ids('Observation', 'patient.organization.name=alpha&status=final')).toEqual(['o1']);
    // Three links answer; Medplum's limit is three.
    add({ resourceType: 'DiagnosticReport', id: 'd1', status: 'final', code: { text: 'x' }, result: [{ reference: 'Observation/o2' }] });
    expect(ids('DiagnosticReport', 'result.patient.organization.name=beta')).toEqual(['d1']);
  });

  it('nested _has: Patient?_has:Observation:subject:_has:Provenance:target:agent=…', () => {
    add({ resourceType: 'Patient', id: 'p1' });
    add({ resourceType: 'Patient', id: 'p2' });
    obs('o1', { subject: { reference: 'Patient/p1' } });
    obs('o2', { subject: { reference: 'Patient/p2' } });
    const prov = (id: string, target: string, who: string) => add({ resourceType: 'Provenance', id, target: [{ reference: target }], recorded: '2024-01-01T00:00:00Z', agent: [{ who: { reference: who } }] });
    prov('v1', 'Observation/o2', 'Practitioner/x');
    prov('v2', 'Observation/o1', 'Practitioner/y');
    expect(ids('Patient', '_has:Observation:subject:_has:Provenance:target:agent=Practitioner/x')).toEqual(['p2']);
    // _has inside a chain, and a chain inside _has.
    add({ resourceType: 'Practitioner', id: 'x' });
    add({ resourceType: 'Patient', id: 'p3', generalPractitioner: [{ reference: 'Practitioner/x' }] });
    expect(ids('Patient', 'general-practitioner:Practitioner._has:Provenance:agent:target:Observation.subject=Patient/p2')).toEqual(['p3']);
    expect(ids('Patient', '_has:Observation:subject:_has:Provenance:target:agent:Practitioner._id=x')).toEqual(['p2']);
  });

  it('a reference type modifier at the end of a chain or _has names the target type (subject:Practitioner=abc is Practitioner/abc)', () => {
    add({ resourceType: 'Patient', id: 'p1', generalPractitioner: [{ reference: 'Organization/abc' }] });
    obs('o1', { subject: { reference: 'Patient/p1' }, performer: [{ reference: 'Organization/abc' }] });
    add({ resourceType: 'Patient', id: 'p2', generalPractitioner: [{ reference: 'Practitioner/abc' }] });
    obs('o2', { subject: { reference: 'Patient/p2' }, performer: [{ reference: 'Practitioner/abc' }] });
    expect(ids('Patient', 'general-practitioner:Practitioner=abc')).toEqual(['p2']);
    expect(ids('Observation', 'subject:Patient.general-practitioner:Practitioner=abc')).toEqual(['o2']);
    expect(ids('Patient', '_has:Observation:subject:performer:Practitioner=abc')).toEqual(['p2']);
    expect(ids('Observation', 'subject:Patient._has:Observation:subject:performer:Practitioner=abc')).toEqual(['o2']);
    expect(fail('Observation', 'subject:Patient.general-practitioner:Practitioner=Organization/abc').status).toBe(400);
  });

  it('_offset above 10000 is 400 with Medplum\'s text (its default maxSearchOffset)', () => {
    expect(ids('Patient', '_offset=10000')).toEqual([]);
    const e = fail('Patient', '_offset=010001');
    expect([e.status, e.message]).toEqual([400, 'Search offset exceeds maximum (got 10001, max 10000)']);
  });

  it('chain longer than Medplum\'s maximum is 400', () => {
    add({ resourceType: 'Patient', id: 'p1' });
    const long = 'Search chains longer than three links are not currently supported';
    const e = fail('DiagnosticReport', 'result.has-member:Observation.has-member:Observation.has-member:Observation.code=x');
    expect([e.status, e.message]).toEqual([400, long]);
    expect(fail('Patient', '_has:Observation:subject:encounter:Encounter._has:DiagnosticReport:encounter:result.specimen.parent.collected=2023').message).toBe(long);
    expect(ids('DiagnosticReport', 'result.has-member:Observation.has-member:Observation.code=x')).toEqual([]); // three links
  });

  it('invalid chains are 400 with Medplum\'s texts', () => {
    for (const [q, text] of [
      ['organization.invalid.name=Kaiser', 'Invalid search parameter in chain: Organization?invalid'],
      ['organization.invalid=true', 'Invalid search parameter at end of chain: Organization?invalid'],
      ['general-practitioner.qualification-period=2023', 'Unable to identify next resource type for search parameter: Patient?general-practitioner'],
      ['general-practitioner:Medication.code=x', 'Unable to identify next resource type for search parameter: Patient?general-practitioner'],
      ['_has:Observation:invalid:status=active', 'Invalid search parameter in chain: Observation?invalid'],
      ['_has:Observation:encounter:status=active', 'Invalid reverse chain link: search parameter Observation?encounter does not refer to Patient'],
      ['_has:Observation:code:status=active', 'Invalid reverse chain link: search parameter Observation?code does not refer to Patient'], // not a reference: no target
      ['_has:Nonsense:subject:status=active', 'Invalid search parameter in chain: Nonsense?subject'],
      ['_has:Observation:status=active', 'Invalid search chain: _has:Observation:status'],
      ['_has:Observation:subject:_has:Provenance:target=x', 'Invalid search chain: _has:Provenance:target'],
      ['organization._has:Patient:organization:_has:Observation:subject=x', 'Invalid search chain: _has:Observation:subject'],
    ]) expect([fail('Patient', q).status, fail('Patient', q).message], q).toEqual([400, text]);
    // Several targets and no type: Medplum cannot tell the next type.
    expect(fail('Observation', 'subject.name=x').message).toBe('Unable to identify next resource type for search parameter: Observation?subject');
  });

  it('chains through canonical references, forward and reverse', () => {
    add({ resourceType: 'Questionnaire', id: 'q1', status: 'unknown', url: 'http://example.com/q1', identifier: [{ value: 'qi' }] });
    add({ resourceType: 'Questionnaire', id: 'q2', status: 'unknown', url: 'http://example.com/q2' });
    add({ resourceType: 'EvidenceVariable', id: 'e1', status: 'unknown', characteristic: [{ definitionReference: { reference: 'Group/g' } }], relatedArtifact: [{ type: 'derived-from', resource: 'http://example.com/q1' }], identifier: [{ value: 'ei' }] } as Resource);
    add({ resourceType: 'ResearchStudy', id: 'r1', status: 'active', protocol: [{ reference: 'PlanDefinition/x' }] });
    expect(ids('Questionnaire', '_has:EvidenceVariable:derived-from:identifier=ei')).toEqual(['q1']);
    expect(ids('EvidenceVariable', 'derived-from:Questionnaire.identifier=qi')).toEqual(['e1']);
    expect(ids('EvidenceVariable', 'derived-from:Questionnaire._id=q2')).toEqual([]);
    // url|version: the resource with that url and version, as _include resolves it.
    add({ resourceType: 'Questionnaire', id: 'q3', status: 'unknown', url: 'http://example.com/v', version: '2', identifier: [{ value: 'v2' }] });
    add({ resourceType: 'Questionnaire', id: 'q4', status: 'unknown', url: 'http://example.com/v', version: '3', identifier: [{ value: 'v3' }] });
    add({ resourceType: 'QuestionnaireResponse', id: 'r2', status: 'completed', questionnaire: 'http://example.com/v|2', identifier: { value: 'rv' } });
    add({ resourceType: 'QuestionnaireResponse', id: 'r3', status: 'completed', questionnaire: 'http://example.com/v', identifier: { value: 'rb' } });
    expect(ids('QuestionnaireResponse', 'questionnaire.identifier=v2')).toEqual(['r2', 'r3']);
    expect(ids('QuestionnaireResponse', 'questionnaire.identifier=v3')).toEqual(['r3']);
    expect(ids('Questionnaire', '_has:QuestionnaireResponse:questionnaire:identifier=rv')).toEqual(['q3']);
    expect(ids('Questionnaire', '_has:QuestionnaireResponse:questionnaire:identifier=rb')).toEqual(['q3', 'q4']);
    const text = 'ResearchStudy cannot be chained via canonical reference (EvidenceVariable:derived-from)';
    expect(fail('EvidenceVariable', 'derived-from:ResearchStudy.status=active').message).toBe(text);
    expect(fail('ResearchStudy', '_has:EvidenceVariable:derived-from:_id=foo').message).toBe(text);
  });

  it('_compartment=Patient/<id> and _compartment.name', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Alpha' }] });
    add({ resourceType: 'Patient', id: 'p2', name: [{ family: 'Beta' }] });
    obs('o1', { subject: { reference: 'Patient/p1' }, performer: [{ reference: 'Patient/p2' }] });
    obs('o2', { subject: { reference: 'Patient/p2' } });
    obs('o3');
    expect(ids('Observation', '_compartment=Patient/p2')).toEqual(['o1', 'o2']);
    expect(ids('Patient', '_compartment=p1')).toEqual(['p1']);
    expect(ids('Patient', '_compartment=x')).toEqual([]);
    expect(ids('Observation', '_compartment:missing=true')).toEqual(['o3']);
    expect(ids('Observation', '_compartment:missing=false')).toEqual(['o1', 'o2']);
    expect(ids('Observation', '_compartment:Patient.name=alpha')).toEqual(['o1']);
    expect(ids('Patient', '_has:Observation:_compartment:_id=o1')).toEqual(['p1', 'p2']);
    add({ resourceType: 'DiagnosticReport', id: 'd1', status: 'final', code: { text: 'x' }, result: [{ reference: 'Observation/o2' }] });
    expect(ids('DiagnosticReport', 'result._compartment:Patient.name=bet')).toEqual(['d1']); // _compartment as a middle link
  });
  it('subject:identifier matches a Reference.identifier (Reference identifier search [search.test.ts] reduced)', () => {
    add({ resourceType: 'Condition', id: 'c1', subject: { identifier: { system: 'mrn', value: '123456' } } } as Resource);
    add({ resourceType: 'Condition', id: 'c2', subject: { identifier: { system: 'xyz', value: '123456' } } } as Resource);
    add({ resourceType: 'Condition', id: 'c3', subject: { reference: 'Patient/123456' } } as Resource);
    expect(ids('Condition', 'subject:identifier=mrn|123456')).toEqual(['c1']);
    expect(ids('Condition', 'subject:identifier=123456')).toEqual(['c1', 'c2']);
    expect(ids('Condition', 'subject:identifier=mrn|123456,xyz|123456&_sort=-_id')).toEqual(['c2', 'c1']);
  });

  it('patient:identifier keeps the parameter\'s own filter (Reference.type), subject:identifier does not', () => {
    const t = { resourceType: 'Task', status: 'accepted', intent: 'order' } as const;
    add({ ...t, id: 't1', for: { type: 'Patient', identifier: { system: 'mrn', value: 'v1' } } } as Resource);
    add({ ...t, id: 't2', for: { identifier: { system: 'mrn', value: 'v1' } } } as Resource);
    expect(ids('Task', 'subject:identifier=mrn|v1')).toEqual(['t1', 't2']);
    expect(ids('Task', 'patient:identifier=mrn|v1')).toEqual(['t1']);
  });

  it('identifier:of-type=typeSystem|typeCode|value', () => {
    const V2 = 'http://terminology.hl7.org/CodeSystem/v2-0203';
    add({ resourceType: 'Patient', id: 'p1', identifier: [{ type: { coding: [{ system: V2, code: 'MR' }] }, system: 'http://s', value: '42' }] });
    add({ resourceType: 'Patient', id: 'p2', identifier: [{ type: { coding: [{ system: V2, code: 'SS' }] }, value: '42' }] });
    add({ resourceType: 'Patient', id: 'p3', identifier: [{ system: 'http://s', value: '42' }] });
    expect(ids('Patient', `identifier:of-type=${V2}|MR|42`)).toEqual(['p1']);
    expect(ids('Patient', `identifier:of-type=${V2}|SS|42`)).toEqual(['p2']);
    expect(ids('Patient', `identifier:of-type=${V2}|MR|43`)).toEqual([]);
    expect(fail('Patient', `identifier:of-type=${V2}|MR`).status).toBe(400);
    expect(fail('Observation', 'code:of-type=a|b|c').message).toBe('Invalid modifier :of-type for code'); // CodeableConcept: no type
  });

  it('url:below and url:above match by path segment', () => {
    const q = (id: string, url: string) => add({ resourceType: 'Questionnaire', id, status: 'active', url } as Resource);
    q('q1', 'http://ex.org/fhir/Questionnaire/a');
    q('q2', 'http://ex.org/fhir/Questionnaire/a/b');
    q('q3', 'http://ex.org/fhir/Questionnaire/ab');
    q('q4', 'http://ex.org/fhir/');
    expect(ids('Questionnaire', 'url:below=http://ex.org/fhir/Questionnaire/a')).toEqual(['q1', 'q2']);
    expect(ids('Questionnaire', 'url:below=http://ex.org/fhir/')).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(ids('Questionnaire', 'url:above=http://ex.org/fhir/Questionnaire/a/b/_history/1')).toEqual(['q1', 'q2', 'q4']);
    expect(ids('Questionnaire', 'url:above=http://ex.org/fhir/Questionnaire/a')).toEqual(['q1', 'q4']);
    expect(fail('Observation', 'code:below=x').message).toBe('Invalid modifier :below for code'); // token: terminology (plan 2)
  });

  it('Observation?code-value-quantity=http://loinc.org|2093-3$gt200 (composite)', () => {
    const v = (id: string, code: string, value: number) => obs(id, { code: { coding: [{ system: LOINC, code }] }, valueQuantity: { value, system: UCUM, code: 'mg/dL' } });
    v('o1', '2093-3', 250);
    v('o2', '2093-3', 150);
    v('o3', '2085-9', 250);
    expect(ids('Observation', `code-value-quantity=${LOINC}|2093-3$gt200`)).toEqual(['o1']);
    expect(ids('Observation', 'code-value-quantity=2093-3$150')).toEqual(['o2']);
    expect(ids('Observation', `code-value-quantity=2093-3$le250|${UCUM}|mg/dL`)).toEqual(['o1', 'o2']);
    expect(ids('Observation', 'code-value-quantity=2093-3$gt200,2085-9$gt200')).toEqual(['o1', 'o3']);
    expect(ids('Observation', 'code-value-quantity=2093-3$gt200&code=2085-9')).toEqual([]);
    expect(ids('Observation', 'code-value-quantity:missing=false&_sort=_id')).toEqual(['o1', 'o2', 'o3']);
    expect(ids('Observation', 'combo-code-value-quantity=2085-9$250')).toEqual(['o3']);
    add({ resourceType: 'Patient', id: 'p1' });
    obs('o4', { subject: { reference: 'Patient/p1' }, code: { coding: [{ code: 'x' }] }, effectiveDateTime: '2024-03-01', valueDateTime: '2024-03-02' } as Observation);
    expect(ids('Observation', 'code-value-date=x$ge2024-03-02')).toEqual(['o4']);
    expect(ids('Observation', 'code-value-date=x$lt2024-03-02')).toEqual([]);
    expect(ids('Patient', '_has:Observation:subject:code-value-date=x$2024-03-02')).toEqual(['p1']);
    expect(fail('Observation', 'code-value-quantity=2093-3').message).toMatch(/code-value-quantity.*\$/);
    expect(fail('Observation', 'code-value-quantity:exact=a$1').message).toBe('Invalid modifier :exact for code-value-quantity');
    expect(fail('Observation', '_sort=code-value-quantity').status).toBe(400);
    // A component takes its own type's prefixes: sa and eb are for dates only.
    expect(fail('Observation', 'code-value-quantity=2093-3$sa1').message).toBe('Invalid operator sa for value-quantity');
    expect(fail('Observation', 'code-value-quantity=2093-3$eb9').message).toBe('Invalid operator eb for value-quantity');
  });

  it('composite pairs components from the same repetition', () => {
    obs('o1', { component: [
      { code: { coding: [{ code: 'A' }] }, valueQuantity: { value: 1 } },
      { code: { coding: [{ code: 'B' }] }, valueQuantity: { value: 2 } },
    ] });
    expect(ids('Observation', 'component-code-value-quantity=A$1')).toEqual(['o1']);
    expect(ids('Observation', 'component-code-value-quantity=B$2')).toEqual(['o1']);
    expect(ids('Observation', 'component-code-value-quantity=A$2')).toEqual([]);
    expect(ids('Observation', 'combo-code-value-quantity=B$2')).toEqual(['o1']);
  });

  it('composites with three components, %resource, and R4\'s swapped DocumentReference.relationship', () => {
    add({ resourceType: 'MolecularSequence', id: 'm1', coordinateSystem: 0, referenceSeq: { chromosome: { coding: [{ code: '1' }] }, genomeBuild: 'GRCh38' }, variant: [{ start: 10, end: 20 }] } as Resource);
    expect(ids('MolecularSequence', 'chromosome-variant-coordinate=1$ge10$le20')).toEqual(['m1']);
    expect(ids('MolecularSequence', 'chromosome-variant-coordinate=1$gt10$le20')).toEqual([]);
    add({ resourceType: 'DocumentReference', id: 'd1', status: 'current', content: [{ attachment: { url: 'http://ex.org/d1' } }], relatesTo: [{ code: 'replaces', target: { reference: 'DocumentReference/d0' } }] } as Resource);
    expect(ids('DocumentReference', 'relationship=DocumentReference/d0$replaces')).toEqual(['d1']);
    expect(ids('DocumentReference', 'relationship=DocumentReference/d0$appends')).toEqual([]);
    // A composite shared by many types (`ActivityDefinition.useContext | … | Questionnaire.useContext | …`).
    add({ resourceType: 'Questionnaire', id: 'q1', status: 'active', useContext: [{ code: { code: 'focus' }, valueCodeableConcept: { coding: [{ code: 'x' }] } }] } as Resource);
    expect(ids('Questionnaire', 'context-type-value=focus$x')).toEqual(['q1']);
    expect(ids('Questionnaire', 'context-type-value=focus$y')).toEqual([]);
    // ResearchStudy's progress-status composites name components R4 does not define.
    expect(fail('ResearchStudy', 'progress-status-state-actual=a$true').message).toMatch(/progress-status-state-actual/);
    add({ resourceType: 'ResearchStudy', id: 'r1', status: 'active', progressStatus: [{ state: { coding: [{ code: 'a' }] } }] } as Resource);
    expect(fail('ResearchStudy', 'progress-status-state-actual:missing=true').message).toMatch(/progress-status-state-actual/);
  });

  it('error texts as Medplum for modifiers: Invalid modifier, :missing must be true or false; _id takes eq, ne, :not, :exact', () => {
    expect(fail('Patient', '_id:text=123').message).toBe('Invalid modifier :text for _id');
    expect(fail('Patient', '_id:above=123').message).toBe('Invalid modifier :above for _id');
    expect(fail('Patient', 'identifier:in=123').message).toBe('Invalid modifier :in for identifier');
    expect(fail('Patient', 'name:identifier=x').message).toBe('Invalid modifier :identifier for name');
    for (const code of ['_id', '_compartment', 'identifier', 'code-value-quantity']) {
      expect(fail(code === 'code-value-quantity' ? 'Observation' : 'Patient', `${code}:missing=maybe`).message).toBe("Search filter ':missing' must have a value of 'true' or 'false'");
    }
    add({ resourceType: 'Patient', id: 'p1' });
    expect(ids('Patient', '_id:exact=p1')).toEqual(['p1']);
  });

  it('meta parameters _security, _source, _tag and _profile, on any type (Resource meta search params, Can search … on _profile)', () => {
    const meta = { profile: ['http://example.com/fhir/a-patient-profile'], security: [{ system: 'http://hl7.org/fhir/v3/Confidentiality', code: 'N' }],
      source: 'http://example.org', tag: [{ system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' }] };
    add({ resourceType: 'Patient', id: 'm1', meta });
    add({ resourceType: 'Patient', id: 'm2' });
    add({ resourceType: 'Organization', id: 'o1', meta: { profile: ['http://example.com/org'] } });
    add({ resourceType: 'MedicinalProductManufactured', id: 'x1', meta: { profile: ['http://example.com/mpm'] }, manufacturedDoseForm: { text: 'tablet' }, quantity: { value: 1 } } as Resource);
    expect(ids('Patient', '_security=http://hl7.org/fhir/v3/Confidentiality|N')).toEqual(['m1']);
    expect(ids('Patient', '_source=http://example.org')).toEqual(['m1']);
    expect(ids('Patient', '_tag=http://hl7.org/fhir/v3/ObservationValue|SUBSETTED')).toEqual(['m1']);
    expect(ids('Patient', '_tag=SUBSETTED')).toEqual(['m1']);
    expect(ids('Patient', '_profile=http://example.com/fhir/a-patient-profile')).toEqual(['m1']);
    expect(ids('Patient', '_profile:missing=true')).toEqual(['m2']);
    expect(ids('Organization', '_profile=http://example.com/org')).toEqual(['o1']);
    expect(ids('MedicinalProductManufactured', '_profile=http://example.com/mpm')).toEqual(['x1']);
  });

  it('_filter: and, or, not and parentheses (_filter search)', () => {
    let n = 0;
    for (const status of ['preliminary', 'final'] as const) for (const code of ['123', '456']) obs(`f${++n}`, { status, code: { coding: [{ code }] }, subject: { reference: 'Patient/p' } });
    expect(ids('Observation', `subject=Patient/p&_filter=${encodeURIComponent('(status eq preliminary and code eq 123) or (not (status eq preliminary) and code eq 456)')}`)).toEqual(['f1', 'f4']);
  });

  it('_filter eq on a string is exact, sw a prefix, co a substring, ne its negation (_filter eq, sw, ne; Disjunction with lookup tables)', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ given: ['Evelyn', 'Dierdre'], family: 'Arachnae' }] });
    add({ resourceType: 'Patient', id: 'p2', name: [{ given: ['Eve'], family: 'Zed' }] });
    expect(ids('Patient', '_filter=given eq Eve')).toEqual(['p2']);
    expect(ids('Patient', '_filter=given eq Evelyn')).toEqual(['p1']);
    expect(ids('Patient', '_filter=name eq Dier')).toEqual([]);
    expect(ids('Patient', '_filter=name sw Dier')).toEqual(['p1']);
    expect(ids('Patient', '_filter=given ne Eve')).toEqual([]); // ne negates the prefix match, as Medplum
    expect(ids('Patient', '_filter=given ne Evelyn')).toEqual(['p2']);
    expect(ids('Patient', `_filter=${encodeURIComponent('name co "rachn" or name co "zed"')}`)).toEqual(['p1', 'p2']);
  });

  it('_filter values: quoted, a date, a UUID (_filter birthdate eq, _filter with UUID value)', () => {
    add({ resourceType: 'Patient', id: '0b2b1f4e-0000-4000-8000-000000000001', birthDate: '2000-01-01' });
    add({ resourceType: 'Patient', id: 'p2', birthDate: '2001-01-01' });
    expect(ids('Patient', '_filter=birthdate eq "2000-01-01"')).toEqual(['0b2b1f4e-0000-4000-8000-000000000001']);
    expect(ids('Patient', '_filter=birthdate gt 2000-06-01')).toEqual(['p2']);
    expect(ids('Patient', '_filter=birthdate le 2000-06-01')).toEqual(['0b2b1f4e-0000-4000-8000-000000000001']);
    for (const v of ['_id eq 12345678-1234-4123-8123-123456789abc or _id eq p2', '(_id eq 12345678-1234-4123-8123-123456789abc or _id eq p2)']) {
      expect(ids('Patient', `_filter=${encodeURIComponent(v)}`)).toEqual(['p2']);
    }
  });

  it('_filter re and ne on references (_filter re, Reference search patterns)', () => {
    add({ resourceType: 'Patient', id: 'p1', identifier: [{ value: 'u' }] });
    add({ resourceType: 'Patient', id: 'p2', identifier: [{ value: 'u' }], link: [{ type: 'refer', other: { reference: 'Patient/p1' } }], managingOrganization: { reference: 'Organization/o1' } });
    expect(ids('Patient', '_filter=organization re Organization/o1')).toEqual(['p2']);
    expect(ids('Patient', `_filter=${encodeURIComponent('identifier eq "u" and link re "Patient/p1"')}`)).toEqual(['p2']);
    expect(ids('Patient', `_filter=${encodeURIComponent('identifier eq "u" and link ne "Patient/p1"')}`)).toEqual(['p1']);
  });

  it('_filter with chains and _has, and _has:…:_filter (_filter with chained search, with reverse chained search; Reverse chained search with _filter)', () => {
    add({ resourceType: 'Patient', id: 'p1', identifier: [{ system: 'http://example.com/mrn', value: 'mrn1' }] });
    add({ resourceType: 'Patient', id: 'p2', identifier: [{ system: 'http://example.com/mrn', value: 'no-match' }] });
    add({ resourceType: 'Practitioner', id: 'pr1', identifier: [{ system: 'http://example.com/npi', value: 'npi1' }] });
    obs('o1', { subject: { reference: 'Patient/p1' }, performer: [{ reference: 'Patient/p1' }], effectiveDateTime: '2000-01-01' });
    obs('o2', { code: { coding: [{ system: LOINC, code: '3141-9' }] }, performer: [{ reference: 'Practitioner/pr1' }], subject: { reference: 'Patient/p2' }, valueDateTime: '2020-01-02T03:04:05Z' });
    const f = (type: string, v: string) => ids(type, `_filter=${encodeURIComponent(v)}`);
    expect(f('Observation', 'subject:Patient.identifier eq http://example.com/mrn|mrn1 or performer:Practitioner.identifier eq http://example.com/npi|npi1')).toEqual(['o1', 'o2']);
    expect(f('Patient', "_has:Observation:performer:_id eq 'o1'")).toEqual(['p1']);
    expect(f('Patient', "_has:Observation:performer:_id eq 'o2'")).toEqual([]);
    expect(f('Patient', "_has:Observation:performer:_id ne 'o1'")).toEqual([]);
    expect(f('Patient', "_has:Observation:performer:_id ne 'o2'")).toEqual(['p1']);
    expect(f('Patient', '_has:Observation:subject:date pr true')).toEqual(['p1']);
    expect(ids('Patient', `_has:Observation:subject:_filter=${encodeURIComponent('code eq "3141-9" and value-date eq "2020-01-02T03:04:05Z"')}`)).toEqual(['p2']);
    expect(ids('Patient', `_has:Observation:subject:_filter=${encodeURIComponent('code eq "xyz"')}`)).toEqual([]);
  });

  it('_filter eq and sw through a chain take the last parameter\'s meaning: exact and prefix on a string', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ given: ['Evelyn'] }] });
    add({ resourceType: 'Patient', id: 'p2', name: [{ given: ['Eve'] }] });
    obs('o1', { subject: { reference: 'Patient/p1' } });
    obs('o2', { subject: { reference: 'Patient/p2' } });
    expect(ids('Observation', '_filter=subject:Patient.given eq Eve')).toEqual(['o2']);
    expect(ids('Observation', '_filter=subject:Patient.given sw Eve')).toEqual(['o1', 'o2']);
    expect(ids('Observation', '_filter=subject:Patient._id eq p1')).toEqual(['o1']);
    expect(ids('Patient', '_filter=_has:Observation:subject:_id eq o2')).toEqual(['p2']);
  });

  it('ap: a date overlapping the value (no tolerance); a negative number within 10%', () => {
    add({ resourceType: 'Patient', id: 'd1', birthDate: '2000-01-01' });
    expect(ids('Patient', 'birthdate=ap2000-01-01')).toEqual(['d1']);
    expect(ids('Patient', 'birthdate=ap2000-01-02')).toEqual([]);
    expect(ids('Patient', '_filter=birthdate ap 2000-01-01')).toEqual(['d1']);
    obs('n1', { valueQuantity: { value: -10, system: UCUM, code: 'Cel' } });
    expect(ids('Observation', 'value-quantity=ap-10')).toEqual(['n1']);
    expect(ids('Observation', 'value-quantity=ap-10.5')).toEqual(['n1']);
    expect(ids('Observation', 'value-quantity=ap-12')).toEqual([]);
  });

  it('_filter operators on numbers and quantities; pr; a bad expression is 400 with Medplum\'s text', () => {
    obs('q1', { valueQuantity: { value: 5, system: UCUM, code: 'mg' } });
    obs('q2', { valueQuantity: { value: 50, system: UCUM, code: 'mg' } });
    obs('q3');
    expect(ids('Observation', '_filter=value-quantity gt 10')).toEqual(['q2']);
    expect(ids('Observation', '_filter=value-quantity lt 10')).toEqual(['q1']);
    expect(ids('Observation', '_filter=value-quantity ap 51')).toEqual(['q2']);
    expect(ids('Observation', '_filter=value-quantity pr false')).toEqual(['q3']);
    expect(fail('Observation', '_filter=code ew x').message).toBe('Invalid operator: ew');
    expect(fail('Observation', '_filter=code ss x').message).toBe('Invalid operator: ss');
    expect(fail('Observation', '_filter=nope eq x').message).toBe('Unknown search parameter: nope');
    expect(fail('Observation', '_filter=code in http://example.com/vs').message).toBe('Invalid modifier :in for code'); // terminology: plan 2
  });

  it('a value list too long for one SQL statement is 400, not a server error', () => {
    obs('o1');
    const n = Array.from({ length: 1100 }, (_, i) => i);
    for (const q of [`code=${n.map((i) => `c${i}`).join(',')}`, `combo-code-value-quantity=${n.map((i) => `c${i}$${i}`).join(',')}`,
      `_filter=${encodeURIComponent(n.map(() => 'status eq final').join(' and '))}`]) {
      const e = fail('Observation', q);
      expect([e.status, e.message]).toEqual([400, 'Search has too many values']);
    }
  });
});
