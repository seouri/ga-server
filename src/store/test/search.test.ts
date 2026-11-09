import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bundle, Observation, Resource } from '@medplum/fhirtypes';
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

  it('one-level chain: subject.name=Doe', () => {
    add({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe' }] });
    add({ resourceType: 'Patient', id: 'p2', name: [{ family: 'Roe' }] });
    obs('c1', { subject: { reference: 'Patient/p1' } });
    obs('c2', { subject: { reference: 'Patient/p2' } });
    expect(ids('Observation', 'subject.name=Doe')).toEqual(['c1']);
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
    expect(fail('Observation', 'subject.organization.name=x').message).toMatch(/chain/i);
    expect(fail('Observation', `code-value-quantity=${LOINC}|1$gt5`).message).toMatch(/composite/i);
    expect(fail('Observation', 'code:below=x').message).toMatch(/:below/);
    expect(fail('Observation', '_summary=true').message).toMatch(/_summary/);
    for (const q of ['_summary=data', '_summary=text', 'code:of-type=a|b|c', 'code:not-in=http://vs', 'code:above=x', '_contained=true', '_text=x', '_content=x',
      '_include=*', '_include:iterate=Observation:subject', '_has:Observation:subject:_has:Observation:subject:code=x']) expect(fail('Observation', q).status, q).toBe(400);
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

  it('token :contains is 400: R4 defines :contains for strings and uris only (Medplum accepts it)', () => {
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
  });
});
