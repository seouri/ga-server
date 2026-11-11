import { describe, expect, it, vi } from 'vitest';
import { CPT, ICD10CM, LOINC, RXNORM, SNOMED } from '../src/concepts.ts';
import { sameName, searchCodes } from '../src/terminology.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stub = (...bodies: unknown[]) => {
  const f = vi.fn();
  for (const b of bodies) f.mockResolvedValueOnce(json(b));
  return f;
};
const url = (f: ReturnType<typeof vi.fn>, n = 0) => new URL(String(f.mock.calls[n][0]));

describe('searchCodes', () => {
  it('searches LOINC by name and returns long common names', async () => {
    const f = stub([2, ['13457-7', '2089-1'], null, [['Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation'], ['Cholesterol in LDL [Mass/volume] in Serum or Plasma']]]);
    const r = await searchCodes(LOINC, 'LDL cholesterol', { fetch: f });
    expect(String(f.mock.calls[0][0]).startsWith('https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?')).toBe(true);
    expect(url(f).searchParams.get('terms')).toBe('LDL cholesterol');
    expect(url(f).searchParams.get('df')).toBe('LONG_COMMON_NAME');
    expect(r).toEqual([
      { system: LOINC, code: '13457-7', display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation' },
      { system: LOINC, code: '2089-1', display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma' },
    ]);
  });

  it('searches RxNorm and names each rxcui', async () => {
    const f = stub({ approximateGroup: { candidate: [{ rxcui: '308297' }, { rxcui: '308297' }, { rxcui: '197361' }] } }, { properties: { name: 'Drug A' } }, { properties: { name: 'Drug B' } });
    const r = await searchCodes(RXNORM, 'drug a 10 mg', { fetch: f });
    expect(String(f.mock.calls[0][0]).startsWith('https://rxnav.nlm.nih.gov/REST/approximateTerm.json?')).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
    expect(String(f.mock.calls[1][0])).toBe('https://rxnav.nlm.nih.gov/REST/rxcui/308297/properties.json');
    expect(r).toEqual([{ system: RXNORM, code: '308297', display: 'Drug A' }, { system: RXNORM, code: '197361', display: 'Drug B' }]);
  });

  it('keeps the RxNorm candidates whose name arrived when one name lookup fails', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ approximateGroup: { candidate: [{ rxcui: '308297' }, { rxcui: '197361' }] } }))
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ properties: { name: 'Drug B' } }));
    expect(await searchCodes(RXNORM, 'drug b', { fetch: f })).toEqual([{ system: RXNORM, code: '197361', display: 'Drug B' }]);
  });

  it('searches SNOMED CT on tx.fhir.org', async () => {
    const f = stub({ expansion: { contains: [{ code: '73761001', display: 'Colonoscopy' }] } });
    const r = await searchCodes(SNOMED, 'colonoscopy', { fetch: f });
    const u = String(f.mock.calls[0][0]);
    expect(u).toContain('https://tx.fhir.org/r4/ValueSet/$expand');
    expect(u).toContain('url=http://snomed.info/sct?fhir_vs');
    expect(u).toContain('filter=colonoscopy');
    expect(r).toEqual([{ system: SNOMED, code: '73761001', display: 'Colonoscopy' }]);
  });

  it('retries SNOMED once without laterality, ordinals and small words when the first search finds nothing', async () => {
    const f = stub({ expansion: {} }, { expansion: { contains: [{ code: '1', display: 'Pinning of finger fracture' }] } });
    const r = await searchCodes(SNOMED, 'pinning of left 5th finger fracture', { fetch: f });
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[1][0])).toContain('filter=pinning%20finger%20fracture');
    expect(r).toHaveLength(1);
  });

  it('searches ICD-10-CM', async () => {
    const f = stub([1, ['E11.9'], null, [['E11.9', 'Type 2 diabetes mellitus without complications']]]);
    expect(await searchCodes(ICD10CM, 'type 2 diabetes', { fetch: f })).toEqual([{ system: ICD10CM, code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' }]);
    expect(String(f.mock.calls[0][0]).startsWith('https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?')).toBe(true);
  });

  it('encodes the term', async () => {
    const f = stub([0, [], null, []]);
    await searchCodes(LOINC, 'A&B / 50% café', { fetch: f });
    expect(url(f).pathname).toBe('/api/loinc_items/v3/search');
    expect(url(f).searchParams.get('terms')).toBe('A&B / 50% café');
  });

  it('a failure gives no candidates', async () => {
    for (const f of [vi.fn().mockRejectedValue(new Error('down')), vi.fn().mockResolvedValue(json({}, 500)), vi.fn().mockResolvedValue(new Response('<html>'))]) {
      for (const s of [LOINC, RXNORM, SNOMED, ICD10CM]) expect(await searchCodes(s, 'x', { fetch: f })).toEqual([]);
    }
  });

  it('an unsupported system makes no request', async () => {
    const f = vi.fn();
    expect(await searchCodes(CPT, 'x', { fetch: f })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('sameName', () => {
  it('ignores case, punctuation and repeated spaces', () => {
    expect(sameName('LDL  Cholesterol,', 'ldl cholesterol')).toBe(true);
    expect(sameName('LDL', 'HDL')).toBe(false);
  });
});
