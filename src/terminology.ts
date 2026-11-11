// Finds standard codes by term name. Only the name goes out, to NLM Clinical Tables (LOINC, ICD-10-CM), RxNav (RxNorm) and tx.fhir.org (SNOMED CT): never values, dates, units, ids or source names.
import { CVX, cvxLike, ICD10CM, LOINC, RXNORM, SNOMED } from './concepts.ts';

export type Candidate = { system: string; code: string; display: string; from?: 'linked record' };

const get = async (f: typeof fetch, url: string): Promise<unknown> => {
  const r = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const sameName = (a: string, b: string): boolean => words(a) === words(b);

const SMALL = /^(left|right|bilateral|\d+(st|nd|rd|th)|of|the|a|an|in|on|to|with|and|for)$/;
const simpler = (term: string) => words(term).split(' ').filter((w) => !SMALL.test(w)).join(' ');

const snomed = async (f: typeof fetch, term: string, limit: number): Promise<Candidate[]> => {
  const { expansion } = (await get(f, `https://tx.fhir.org/r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs&count=${limit}&filter=${encodeURIComponent(term)}`)) as { expansion?: { contains?: { code: string; display: string }[] } };
  return (expansion?.contains ?? []).slice(0, limit).map((c) => ({ system: SNOMED, code: c.code, display: c.display }));
};

export async function searchCodes(system: string, term: string, deps: { fetch?: typeof fetch; limit?: number } = {}): Promise<Candidate[]> {
  const f = deps.fetch ?? fetch;
  const limit = deps.limit ?? 5;
  const q = encodeURIComponent(term);
  try {
    if (system === LOINC) {
      const [, codes, , names] = (await get(f, `https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?terms=${q}&df=LONG_COMMON_NAME&maxList=${limit}`)) as [number, string[], unknown, string[][]];
      return codes.slice(0, limit).map((code, i) => ({ system, code, display: names[i][0] }));
    }
    if (system === ICD10CM) {
      const [, codes, , rows] = (await get(f, `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?terms=${q}&sf=code,name&df=code,name&maxList=${limit}`)) as [number, string[], unknown, string[][]];
      return codes.slice(0, limit).map((code, i) => ({ system, code, display: rows[i][1] }));
    }
    if (system === RXNORM) {
      const { approximateGroup } = (await get(f, `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${q}&maxEntries=${limit}`)) as { approximateGroup?: { candidate?: { rxcui: string }[] } };
      const ids = [...new Set((approximateGroup?.candidate ?? []).map((c) => c.rxcui))].slice(0, limit);
      return Promise.all(ids.map(async (code) => {
        const { properties } = (await get(f, `https://rxnav.nlm.nih.gov/REST/rxcui/${code}/properties.json`)) as { properties?: { name?: string } };
        return { system, code, display: properties?.name ?? '' };
      }));
    }
    if (system === CVX) return cvxLike(term, limit) as Candidate[]; // the shipped table: nothing is sent
    if (system === SNOMED) {
      const found = await snomed(f, term, limit);
      const retry = simpler(term);
      return found.length || !retry || retry === words(term) ? found : snomed(f, retry, limit);
    }
  } catch {
    return [];
  }
  return [];
}
