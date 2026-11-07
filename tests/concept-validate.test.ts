import { expect, test } from 'vitest';
import { CPT, CVX, ICD10CM, LOINC, RXNORM, SNOMED } from '../src/concepts.ts';
import { validate } from '../src/concept-validate.ts';

const urls: string[] = [];
const fake = (body: unknown, status = 200) => (async (u: string) => (urls.push(u), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
const loinc = fake([1, ['2345-7'], null, [['Glucose [Mass/volume] in Serum or Plasma']]]);

test('LOINC: a known code passes with its long name; an unknown or prefix-only hit fails', async () => {
  expect(await validate(LOINC, '2345-7', 'Glucose', { fetch: loinc })).toEqual({ ok: true, display: 'Glucose [Mass/volume] in Serum or Plasma' });
  expect(urls.at(-1)).toMatch(/^https:\/\/clinicaltables\.nlm\.nih\.gov\/api\/loinc_items\/v3\/search\?terms=2345-7&/);
  expect(urls.at(-1)).not.toContain('Glucose'); // only the code goes out
  expect(await validate(LOINC, '99999-9', 'Glucose', { fetch: fake([0, [], null, []]) })).toEqual({ ok: false, reason: 'unknown LOINC code 99999-9' });
  expect((await validate(LOINC, '2345', 'Glucose', { fetch: loinc })).ok).toBe(false);
});

test('RxNorm: properties found passes; {} fails', async () => {
  expect(await validate(RXNORM, '1191', 'aspirin', { fetch: fake({ properties: { rxcui: '1191', name: 'aspirin' } }) })).toEqual({ ok: true, display: 'aspirin' });
  expect(urls.at(-1)).toBe('https://rxnav.nlm.nih.gov/REST/rxcui/1191/properties.json');
  expect((await validate(RXNORM, '99999999', 'x', { fetch: fake({}) })).ok).toBe(false);
});

test('CVX from the shipped table; SNOMED, ICD-10 and CPT not validated', async () => {
  const none = (async () => { throw new Error('no network for these'); }) as unknown as typeof fetch;
  expect((await validate(CVX, '208', 'covid', { fetch: none })).ok).toBe(true);
  expect((await validate(CVX, '99999', 'x', { fetch: none })).ok).toBe(false);
  for (const s of [SNOMED, ICD10CM, CPT]) expect(await validate(s, '123', 'x', { fetch: none })).toEqual({ ok: true, reason: 'not validated' });
});

test('a fetch that throws, or a server error, gives validation unavailable; a malformed code is refused without a request', async () => {
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  expect(await validate(LOINC, '2345-7', 'Glucose', { fetch: down })).toEqual({ ok: false, reason: 'validation unavailable' });
  expect(await validate(RXNORM, '1191', 'aspirin', { fetch: fake({}, 503) })).toEqual({ ok: false, reason: 'validation unavailable' });
  const n = urls.length;
  expect((await validate(RXNORM, '../x', 'aspirin', { fetch: loinc })).ok).toBe(false);
  expect(urls.length).toBe(n);
});
