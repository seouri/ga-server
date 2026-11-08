import { describe, expect, it, test } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { Observation } from '@medplum/fhirtypes';
import { CONCEPT_SRC } from '../src/concept-apply.ts';
import { isPanel, keyLabs, labResults, labRow, summarizeLabs, type LabRow, type LabTrend } from '../src/labs.ts';

describe('labRow', () => {
  it('keeps the comparator, unit, one-sided ranges and flags; omits empty fields', () => {
    const o: Observation = {
      resourceType: 'Observation', id: 'x', status: 'final', code: { coding: [{ code: '1988-5', display: 'CRP' }] },
      effectiveDateTime: '2024-05-01T08:00:00Z', valueQuantity: { comparator: '<', value: 0.5, unit: 'mg/L' },
      referenceRange: [{ high: { value: 5, unit: 'mg/L' } }], interpretation: [{ coding: [{ code: 'N' }] }],
      meta: { source: '/home/u/labs.pdf', tag: [{ code: 'extracted-by-llm' }, { code: 'possible-duplicate' }] },
    };
    expect(labRow(o)).toEqual({ date: '2024-05-01', name: 'CRP', value: '<0.5 mg/L', range: '≤5 mg/L', interpretation: 'N', source: 'labs.pdf', flags: ['read from a document by AI', 'possible-duplicate'], id: 'x' });
    expect(labRow({ resourceType: 'Observation', status: 'final', code: { text: 'HDL' }, referenceRange: [{ low: { value: 40 } }], valueString: 'see note' })).toEqual({ name: 'HDL', value: 'see note', range: '≥40' });
    expect(labRow({ resourceType: 'Observation', status: 'final', code: {}, referenceRange: [{ low: { value: 4 }, high: { value: 6, unit: '%' } }] }).range).toBe('4–6 %');
  });
});

const obs = (n: number, extra: Partial<Observation> = {}): Observation => ({ resourceType: 'Observation', id: `id${n}`, status: 'final', code: { text: 'X'.repeat(300) }, effectiveDateTime: '2024-01-01', ...extra });
const fake = (seen: string[] = []) =>
  ({
    search: async (_t: string, q: URLSearchParams) => (seen.push(q.toString()), page(0)),
    get: async (url: string) => (seen.push(url), page(Number(new URLSearchParams(url.split('?')[1]).get('p')))),
  }) as unknown as MedplumClient;
let pages: Observation[][] = [];
const page = (i: number) => ({ resourceType: 'Bundle', entry: pages[i].map((resource) => ({ resource })), link: i + 1 < pages.length ? [{ relation: 'next', url: `http://medplum:8103/fhir/R4/Observation?p=${i + 1}` }] : [] });

describe('labResults', () => {
  it('validates dates', async () => {
    for (const since of ['2024', '2024-02-30', '2024-01-01T00:00:00Z']) await expect(labResults(fake(), 'p', { since })).rejects.toThrow(/since must be/);
  });
  it('builds the query, follows next by path, drops non-lab categories and uncategorised vitals, flags truncation', async () => {
    const seen: string[] = [];
    pages = [[obs(0, { effectiveDateTime: undefined }), obs(1), obs(2, { category: [{ coding: [{ code: 'vital-signs' }] }] }), obs(5, { code: { text: 'Weight' } })], [obs(3), obs(4)]];
    const r = await labResults(fake(seen), 'p', { name: 'crp', since: '2024-01-01', until: '2024-12-31', limit: 2 });
    expect(r).toMatchObject({ total: 2, truncated: true });
    expect((r.rows as LabRow[]).map((x) => x.id)).toEqual(['id1', 'id3']);
    const q = new URLSearchParams(seen[0]);
    expect(q.getAll('date')).toEqual(['ge2024-01-01', 'lt2025-01-01']);
    expect(q.get('code:text')).toBe('crp');
    expect(q.get('_tag:not')).toBe('urn:ga-server:tag|src-apple-health');
    expect(seen[1]).toBe('fhir/R4/Observation?p=1');
  });
  it('name list: one scan, a result kept once when any name matches, newest first, limit on the merged set', async () => {
    let searches = 0;
    const all = [
      obs(1, { effectiveDateTime: '2024-01-01', code: { text: 'ZZFOO level' } }), obs(2, { effectiveDateTime: '2024-03-01', code: { text: 'zzfoo zzbar' } }),
      obs(3, { effectiveDateTime: '2024-02-01', code: { text: 'ZZBAR' } }), obs(4, { code: { text: 'other' } }),
    ];
    const client = { search: async () => (searches++, { resourceType: 'Bundle', entry: all.map((resource) => ({ resource })) }) } as unknown as MedplumClient;
    const r = await labResults(client, 'p', { name: ['zzfoo', 'zzbar'] });
    expect((r.rows as LabRow[]).map((x) => x.id)).toEqual(['id2', 'id3', 'id1']);
    expect(searches).toBe(1);
    expect((await labResults(client, 'p', { name: ['zzfoo', 'zzbar'], limit: 2 })).rows).toHaveLength(2);
  });
  it('drops rows past the remote size budget instead of letting the cap cut JSON', async () => {
    pages = [Array.from({ length: 1000 }, (_, n) => obs(n))];
    const r = await labResults(fake(), 'p', { limit: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.total).toBeLessThan(1000);
    expect(JSON.stringify(r).length).toBeLessThan(150_000);
  });
});

describe('summarizeLabs', () => {
  const lab = (text: string, date: string | undefined, value: number, extra: Partial<Observation> = {}): Observation =>
    ({ resourceType: 'Observation', status: 'final', code: { text }, effectiveDateTime: date, valueQuantity: { value, unit: 'mg/dL' }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-pdf' }] }, ...extra });
  const loinc = { coding: [{ system: 'urn:local', code: 'L1' }, { system: 'http://loinc.org', code: '13457-7' }] };
  it('groups by LOINC, else by case/space-insensitive name; an uncoded result joins the LOINC group of its name', () => {
    const s = summarizeLabs([
      lab('LDL Cholesterol', '2024-01-01', 120, { code: { ...loinc, text: 'LDL Cholesterol' } }),
      lab('LDL  cholesterol', '2025-01-01', 100), // PDF, no code
      lab('LDL calc', '2023-01-01', 130, { code: { ...loinc, text: 'LDL calc' } }),
      lab('Glucose', undefined, 90),
      lab('glucose', '2022-05-01', 99),
    ]);
    expect(s.map((x) => [x.test, x.name, x.loinc, x.count])).toEqual([['LDL', 'LDL  cholesterol', '13457-7', 3], [undefined, 'glucose', undefined, 2]]);
    expect(s[0]).toMatchObject({ latest: { date: '2025-01-01', value: 100 }, previous: { date: '2024-01-01', value: 120 }, change: -20, first: '2023-01-01' });
    expect(s[1]).toMatchObject({ latest: { date: '2022-05-01', value: 99 }, first: '2022-05-01' }); // undated last
    expect(s[1].previous).toBeUndefined();
  });
  it('change only for same-unit numbers; out of range by interpretation, else by the reference range', () => {
    const range = { referenceRange: [{ low: { value: 3.5 }, high: { value: 5.1 } }] };
    const [k] = summarizeLabs([
      lab('Potassium', '2024-03-01', 5.6, { ...range, interpretation: [{ coding: [{ code: 'N' }] }] }), // interpretation wins over the range
      lab('Potassium', '2024-02-01', 5.4, { ...range, valueQuantity: { value: 5.4, unit: 'mmol/L' } }),
      lab('Potassium', '2024-01-01', 3.0, range),
      lab('Potassium', '2023-01-01', 4, { interpretation: [{ text: 'High' }] }),
    ]);
    expect(k).toMatchObject({ count: 4, outOfRange: 3, previous: { value: 5.4 } });
    expect(k.latest.flag).toBeUndefined();
    expect(k.change).toBeUndefined(); // mg/dL vs mmol/L
    const [c] = summarizeLabs([lab('CRP', '2024-02-01', 5.6), lab('CRP', '2024-01-01', 5.4, { valueQuantity: { comparator: '<', value: 5.4, unit: 'mg/dL' } })]);
    expect(c.change).toBeUndefined();
    expect(c.previous?.value).toBe('<5.4 mg/dL');
    expect(summarizeLabs([lab('A', '2024-01-01', 6.1), lab('A', '2023-01-01', 5.4)])[0].change).toBe(0.7);
    // A comparator skips the range: "<5" is not high against a high of 3.
    expect(summarizeLabs([lab('B', '2024-01-01', 5, { valueQuantity: { comparator: '<', value: 5 }, referenceRange: [{ high: { value: 3 } }] })])[0].outOfRange).toBe(0);
  });
  it('same day: the newest written is latest; results with no name and no code are skipped', () => {
    const s = summarizeLabs([
      lab('C', '2024-01-01', 1, { meta: { lastUpdated: '2024-01-02T00:00:00Z' } }), lab('C', '2024-01-01', 2, { meta: { lastUpdated: '2024-01-03T00:00:00Z' } }),
      { resourceType: 'Observation', status: 'final', code: {}, effectiveDateTime: '2025-01-01', valueQuantity: { value: 9 } },
    ]);
    expect(s.map((x) => [x.name, x.latest.value])).toEqual([['C', 2]]);
  });
});

describe('concepts: one test under different names and codes', () => {
  const L = 'http://loinc.org';
  const tag = (...codes: string[]) => ({ tag: codes.map((code) => ({ system: 'urn:ga-server:tag', code })) });
  const ga = (code: string) => ({ system: L, code, extension: [{ url: CONCEPT_SRC, valueCode: 'agent' }] });
  const lab = (text: string, date: string, loinc?: string, extra: Partial<Observation> = {}): Observation =>
    ({ resourceType: 'Observation', id: `${text}${date}`, status: 'final', code: { text, ...(loinc && { coding: [{ system: L, code: loinc }] }) }, effectiveDateTime: date, valueQuantity: { value: 1, unit: 'mg/dL' }, meta: tag('src-pdf'), ...extra });
  const mapped = (text: string, date: string, code: string, suggested = false): Observation =>
    lab(text, date, undefined, { code: { text, coding: [ga(code)] }, meta: tag('extracted-by-llm', ...(suggested ? ['concept-suggested'] : [])) });
  const hospital = lab('LOW DENSITY LIPOPROTEIN CHOL', '2022-01-01', '13457-7');
  const pdf = mapped('LDL cholesterol', '2024-07-26', '13457-7');

  it('lab_results name "ldl": concept codes (incl. GA-added) plus literal text, no code:text query; summary groups by concept only', async () => {
    const seen: string[] = [];
    pages = [[hospital, pdf, lab('HIGH DENSITY LIPOPROTEIN CHOL', '2024-01-01', '2085-9'), lab('LDL-P', '2023-01-01')]];
    const r = await labResults(fake(seen), 'p', { name: 'ldl' });
    expect((r.rows as LabRow[]).map((x) => x.name)).toEqual(['LDL cholesterol', 'LDL-P', 'LOW DENSITY LIPOPROTEIN CHOL']);
    expect(new URLSearchParams(seen[0]).get('code:text')).toBeNull();
    pages = [[mapped('LDL chol (est)', '2025-01-01', '13457-7', true)]];
    expect(((await labResults(fake(), 'p', { name: 'ldl' })).rows as LabRow[])[0].flags).toContain('possibly LDL (suggested mapping)');
    pages = [[hospital, pdf, lab('HIGH DENSITY LIPOPROTEIN CHOL', '2024-01-01', '2085-9'), lab('LDL-P', '2023-01-01')]];
    const s = (await labResults(fake(), 'p', { name: 'ldl', summary: true })).rows as LabTrend[];
    expect(s.map((x) => [x.test, x.name, x.count])).toEqual([['LDL', 'LDL cholesterol', 2], [undefined, 'LDL-P', 1]]);
    expect(s[0]).toMatchObject({ latest: { date: '2024-07-26' }, previous: { date: '2022-01-01', method: 'calculated' } });
  });
  it('look-alikes never join the concept: urine glucose (urine LOINC, same name and unit), TSH receptor antibody, LDL-P; keyLabs in concept order', () => {
    const s = summarizeLabs([
      lab('Glucose', '2025-01-01', '5792-7'), lab('Glucose', '2024-01-01', '2345-7'), lab('Glucose', '2023-01-01'), // uncoded: two coded twins, joins neither
      lab('TSH receptor antibody', '2025-01-01'), lab('Thyrotropin receptor Ab', '2025-02-01', '5385-0'), lab('TSH', '2024-01-01', '3016-3'),
      lab('LDL-P', '2025-01-01'), lab('LDL calc', '2023-01-01', '13457-7'), lab('LDL direct', '2024-02-01', '18262-6'),
      lab('Hemoglobin A1c', '2024-01-01', '4548-4'), lab('hemoglobin  a1c', '2024-06-01'), // uncoded, one coded twin of its name and unit: joins
    ]);
    expect(keyLabs(s).map((x) => [x.test, x.name, x.count, x.latest.method])).toEqual([
      ['A1c', 'hemoglobin  a1c', 2, undefined], ['Glucose', 'Glucose', 1, undefined], ['LDL', 'LDL direct', 2, 'direct'], ['TSH', 'TSH', 1, undefined],
    ]);
    expect(s.filter((x) => !x.test).map((x) => [x.name, x.count])).toEqual(expect.arrayContaining([['Glucose', 1], ['Glucose', 1], ['TSH receptor antibody', 1], ['Thyrotropin receptor Ab', 1], ['LDL-P', 1]]));
  });
  it('an uncoded result joins a coded twin only from its own source, and never when its map says unmatched', () => {
    const ehi = (o: Observation): Observation => ({ ...o, identifier: [{ system: 'urn:ga-server:id:ehi:hosp', value: 'X|1' }], meta: tag('src-ehi') });
    const pdfGlucose = { ...lab('Glucose', '2025-06-01'), valueQuantity: { value: 300, unit: 'mg/dL' } };
    const s = summarizeLabs([ehi(lab('Glucose', '2024-01-01', '2345-7')), pdfGlucose]);
    expect(keyLabs(s).map((x) => [x.test, x.latest.date, x.count])).toEqual([['Glucose', '2024-01-01', 1]]);
    expect(s.find((x) => !x.test)?.latest.value).toBe(300);
    // the same source: joins
    expect(keyLabs(summarizeLabs([ehi(lab('Glucose', '2024-01-01', '2345-7')), ehi(lab('Glucose', '2025-06-01'))]))[0].count).toBe(2);
    const unmatched = { ...ehi(lab('Glucose', '2025-06-01')), meta: tag('src-ehi', 'concept-unmatched') };
    expect(keyLabs(summarizeLabs([ehi(lab('Glucose', '2024-01-01', '2345-7')), unmatched]))[0].count).toBe(1);
  });
  it('eGFR: race-free and race-based stay one trend, each value with its method', () => {
    const [e] = summarizeLabs([lab('eGFR', '2024-01-01', '98979-8'), lab('eGFR non-Afr. American', '2021-01-01', '48642-3')]);
    expect(e).toMatchObject({ test: 'eGFR', count: 2, latest: { method: 'race-free (CKD-EPI 2021)' }, previous: { method: 'race-based' } });
  });
  it('a group coded only 13457-7 reports latest.method calculated', () => {
    const [t] = summarizeLabs([lab('LDL', '2024-01-01', '13457-7'), lab('LDL', '2023-01-01', '13457-7')]);
    expect(t).toMatchObject({ test: 'LDL', latest: { method: 'calculated' }, previous: { method: 'calculated' } });
  });
  it('a match only through a concept-suggested coding is flagged "possibly", and stays out of the concept and keyLabs', () => {
    const guess = mapped('LDL chol (est)', '2025-01-01', '13457-7', true);
    expect(labRow(guess).flags).toEqual(['read from a document by AI', 'possibly LDL (suggested mapping)']);
    expect(labRow(pdf).flags).toEqual(['read from a document by AI']);
    // the record's own LOINC is never suggested, whatever the tag says
    expect(labRow({ ...guess, code: { coding: [{ system: L, code: '2085-9' }, ga('13457-7')] } }).flags).toEqual(['read from a document by AI']);
    // keyed by its own name only: the GA-suggested LOINC neither sets loinc nor pulls in an uncoded twin
    const twin = lab('LDL chol (est)', '2024-01-01');
    expect(summarizeLabs([guess, twin, lab('Other', '2020-01-01', '13457-7')]).map((x) => [x.name, x.count, x.loinc])).toEqual([['LDL chol (est)', 2, undefined], ['Other', 1, '13457-7']]);
    expect(summarizeLabs([guess, lab('LDL chol (est)', '2020-01-01', '13457-7')]).map((x) => [x.name, x.count])).toEqual([['LDL chol (est)', 1], ['LDL chol (est)', 1]]);
    const s = summarizeLabs([hospital, guess]);
    expect(s.map((x) => [x.test, x.name, x.count, x.flags])).toEqual([[undefined, 'LDL chol (est)', 1, ['read from a document by AI', 'possibly LDL (suggested mapping)']], ['LDL', 'LOW DENSITY LIPOPROTEIN CHOL', 1, undefined]]);
    expect(keyLabs(s).map((x) => x.name)).toEqual(['LOW DENSITY LIPOPROTEIN CHOL']);
  });
});

it('a name matches from the start of a word: "ast" never finds "FASTING STATUS"; "ferr" still finds Ferritin', async () => {
  const lab = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];
  const o = (id: string, text: string) => ({ resourceType: 'Observation', id, status: 'final', category: lab, code: { text }, effectiveDateTime: '2026-11-03', valueString: 'x' });
  const entries = [o('a', 'SGOT (AST)'), o('f', 'FASTING STATUS'), o('g', 'Fasting glucose'), o('r', 'Ferritin')];
  const client = { search: async () => ({ resourceType: 'Bundle', entry: entries.map((resource) => ({ resource })) }) } as unknown as MedplumClient;
  expect((await labResults(client, 'p', { name: 'ast' })).rows.map((r) => (r as LabRow).id)).toEqual(['a']);
  expect((await labResults(client, 'p', { name: ['ferr', 'ast'] })).rows.map((r) => (r as LabRow).id).sort()).toEqual(['a', 'r']);
});

test('isPanel: only a panel that holds nothing of its own is hidden behind its members', () => {
  const members = [{ reference: 'Observation/a' }];
  // A C-CDA vital signs organizer: members only.
  expect(isPanel({ resourceType: 'Observation', status: 'final', code: { text: 'Vital signs' }, hasMember: members })).toBe(true);
  // A portal panel with its own interpretation and note is shown.
  const portal = { resourceType: 'Observation', status: 'final', code: { text: 'Lipid panel' }, hasMember: members, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-smart' }] } } as Observation;
  expect(isPanel({ ...portal, interpretation: [{ coding: [{ code: 'A' }] }], note: [{ text: 'see members' }] })).toBe(false);
  expect(isPanel({ ...portal, referenceRange: [{ text: 'normal' }] })).toBe(false);
  expect(isPanel({ ...portal, dataAbsentReason: { text: 'not done' } })).toBe(false);
});
