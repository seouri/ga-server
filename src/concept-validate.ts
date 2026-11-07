// Checks an agent-proposed code exists (spec "Validation"). Only the code goes out, to NLM: never values, dates or ids.
import { CVX, cvxShort, LOINC, RXNORM } from './concepts.ts';

export type Validation = { ok: boolean; display?: string; reason?: string };

const get = async (f: typeof fetch, url: string): Promise<unknown> => {
  const r = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); // 429/5xx: unavailable, not an unknown code
  return r.json();
};

export async function validate(system: string, code: string, _term: string, deps: { fetch?: typeof fetch } = {}): Promise<Validation> {
  const f = deps.fetch ?? fetch;
  const unknown = (name: string): Validation => ({ ok: false, reason: `unknown ${name} code ${code}` });
  if (system === CVX) {
    const short = cvxShort(code);
    return short ? { ok: true, display: short } : unknown('CVX');
  }
  if (system !== LOINC && system !== RXNORM) return { ok: true, reason: 'not validated' }; // SNOMED, ICD-10, CPT, HCPCS: GA ships no content
  // Format first: the code goes into a URL.
  if (system === LOINC ? !/^\d{1,7}-\d$/.test(code) : !/^\d{1,10}$/.test(code)) return unknown(system === LOINC ? 'LOINC' : 'RxNorm');
  try {
    if (system === LOINC) {
      // The search matches prefixes: only an exact code counts.
      const [, codes, , names] = (await get(f, `https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?terms=${code}&sf=LOINC_NUM&df=LONG_COMMON_NAME`)) as [number, string[], unknown, string[][]];
      const i = codes?.indexOf(code) ?? -1;
      return i < 0 ? unknown('LOINC') : { ok: true, display: names[i][0] };
    }
    const { properties } = (await get(f, `https://rxnav.nlm.nih.gov/REST/rxcui/${code}/properties.json`)) as { properties?: { name?: string } };
    return properties ? { ok: true, ...(properties.name && { display: properties.name }) } : unknown('RxNorm');
  } catch {
    return { ok: false, reason: 'validation unavailable' };
  }
}
