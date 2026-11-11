import { expect, test } from 'vitest';
import { CPT, CVX, HCPCS, ICD10CM, LOINC, RXNORM, SNOMED } from '../src/concepts.ts';
import { validate, wellFormed } from '../src/concept-validate.ts';

const urls: string[] = [];
const fake = (body: unknown, status = 200) => (async (u: string) => (urls.push(u), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
const loinc = fake([1, ['2345-7'], null, [['Glucose [Mass/volume] in Serum or Plasma']]]);

test('LOINC: a known code passes with its long name; an unknown or prefix-only hit fails', async () => {
  expect(await validate(LOINC, '2345-7', { fetch: loinc })).toEqual({ ok: true, display: 'Glucose [Mass/volume] in Serum or Plasma' });
  expect(urls.at(-1)).toMatch(/^https:\/\/clinicaltables\.nlm\.nih\.gov\/api\/loinc_items\/v3\/search\?terms=2345-7&/);
  expect(urls.at(-1)).not.toContain('Glucose'); // only the code goes out
  expect(await validate(LOINC, '99999-9', { fetch: fake([0, [], null, []]) })).toEqual({ ok: false, reason: 'unknown LOINC code 99999-9' });
  expect((await validate(LOINC, '2345', { fetch: loinc })).ok).toBe(false);
});

test('RxNorm: properties found passes; {} fails', async () => {
  expect(await validate(RXNORM, '1191', { fetch: fake({ properties: { rxcui: '1191', name: 'aspirin' } }) })).toEqual({ ok: true, display: 'aspirin' });
  expect(urls.at(-1)).toBe('https://rxnav.nlm.nih.gov/REST/rxcui/1191/properties.json');
  expect((await validate(RXNORM, '99999999', { fetch: fake({}) })).ok).toBe(false);
});

test('CVX from the shipped table; CPT and HCPCS not validated', async () => {
  const none = (async () => { throw new Error('no network for these'); }) as unknown as typeof fetch;
  expect((await validate(CVX, '208', { fetch: none })).ok).toBe(true);
  expect((await validate(CVX, '99999', { fetch: none })).ok).toBe(false);
  for (const [s, c] of [[CPT, '80061'], [HCPCS, 'G0105']]) expect(await validate(s, c, { fetch: none })).toEqual({ ok: true, reason: 'not validated' });
});

test('a fetch that throws, or a server error, gives validation unavailable; a malformed code is refused without a request', async () => {
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  expect(await validate(LOINC, '2345-7', { fetch: down })).toEqual({ ok: false, reason: 'validation unavailable' });
  expect(await validate(RXNORM, '1191', { fetch: fake({}, 503) })).toEqual({ ok: false, reason: 'validation unavailable' });
  const n = urls.length;
  expect((await validate(RXNORM, '../x', { fetch: loinc })).ok).toBe(false);
  expect(urls.length).toBe(n);
});

test('wellFormed: per-system code shapes; unknown systems pass', () => {
  for (const [s, ok, bad] of [[SNOMED, '44054006', '123'], [ICD10CM, 'E11.65', 'e11.65'], [ICD10CM, 'Z00', 'Z00.12345'], [CPT, '80061', '8006'], [LOINC, '2345-7', '2345'], [RXNORM, '1191', '../x']]) {
    expect(wellFormed(s, ok)).toBe(true);
    expect(wellFormed(s, bad)).toBe(false);
  }
  expect(wellFormed('http://example.org/x', 'anything')).toBe(true);
});

test('validates a SNOMED CT code on tx.fhir.org', async () => {
  const ok = fake({ resourceType: 'Parameters', parameter: [{ name: 'display', valueString: 'Colonoscopy' }] });
  expect(await validate(SNOMED, '73761001', { fetch: ok })).toEqual({ ok: true, display: 'Colonoscopy' });
  expect(urls.at(-1)).toBe('https://tx.fhir.org/r4/CodeSystem/$lookup?system=http://snomed.info/sct&code=73761001');
  expect(await validate(SNOMED, '99999999', { fetch: fake({}, 404) })).toEqual({ ok: false, reason: 'unknown SNOMED CT code 99999999' });
});

test('validates an ICD-10-CM code exactly', async () => {
  const hit = fake([1, ['E11.9'], null, [['E11.9', 'Type 2 diabetes mellitus without complications']]]);
  expect(await validate(ICD10CM, 'E11.9', { fetch: hit })).toEqual({ ok: true, display: 'Type 2 diabetes mellitus without complications' });
  expect(urls.at(-1)).toMatch(/^https:\/\/clinicaltables\.nlm\.nih\.gov\/api\/icd10cm\/v3\/search\?terms=E11\.9&/);
  expect(await validate(ICD10CM, 'E11.9', { fetch: fake([1, ['E11.90'], null, [['E11.90', 'x']]]) })).toEqual({ ok: false, reason: NOT_BILLABLE });
});

// Clinical Tables lists billable codes only: a category code (E11) is refused with what to do instead.
const NOT_BILLABLE = 'not a billable ICD-10-CM code: use a more specific code or SNOMED CT';
test('refuses an ICD-10-CM category code as not billable', async () => {
  expect(await validate(ICD10CM, 'E11', { fetch: fake([2, ['E11.0', 'E11.9'], null, [['E11.0', 'x'], ['E11.9', 'y']]]) })).toEqual({ ok: false, reason: NOT_BILLABLE });
});

test('an unavailable service is not an unknown code', async () => {
  for (const [s, c] of [[SNOMED, '73761001'], [ICD10CM, 'E11.9']]) expect(await validate(s, c, { fetch: fake({}, 503) })).toEqual({ ok: false, reason: 'validation unavailable' });
});
