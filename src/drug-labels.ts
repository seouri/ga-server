// FDA label sections by RxNorm code, cached 30 days. Only the code goes out, to openFDA and RxNav: never names, values or dates.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfigPath } from './config.ts';
import { writeAtomic } from './smart/store.ts';

const SECTIONS = ['boxed_warning', 'contraindications', 'warnings_and_cautions', 'warnings', 'drug_interactions', 'use_in_specific_populations'] as const;
export type LabelSections =
  | { status: 'ok'; rxcui: string; setId: string; effective: string; title?: string; sections: Partial<Record<(typeof SECTIONS)[number], string>> }
  | { status: 'no label' | 'unavailable' | 'no code'; rxcui?: string };

const TTL = 30 * 86_400_000;
const MAX = 4000;
type Label = Record<string, unknown> & { set_id?: string; effective_time?: string; openfda?: { generic_name?: string[] } };

// null = openFDA has nothing for these codes (404); other failures throw.
async function query(f: typeof fetch, codes: string[]): Promise<Label[] | null> {
  const search = codes.length === 1 ? `"${codes[0]}"` : `(${codes.map((c) => `"${c}"`).join('+OR+')})`;
  const r = await f(`https://api.fda.gov/drug/label.json?search=openfda.rxcui:${search}+AND+_exists_:drug_interactions&sort=effective_time:desc&limit=1`, { signal: AbortSignal.timeout(10_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { results?: Label[] }).results ?? [];
}

async function related(f: typeof fetch, rxcui: string): Promise<string[]> {
  const r = await f(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=SCD+SBD`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const groups = ((await r.json()) as { relatedGroup?: { conceptGroup?: { conceptProperties?: { rxcui: string }[] }[] } }).relatedGroup?.conceptGroup ?? [];
  const codes = groups.flatMap((g) => g.conceptProperties ?? []).map((p) => p.rxcui).filter((c) => /^\d{1,10}$/.test(c));
  return [...new Set(codes)].slice(0, 20);
}

function pick(rxcui: string, labels: Label[]): LabelSections {
  const best = labels.filter((l) => SECTIONS.some((s) => Array.isArray(l[s]))).sort((a, b) => (b.effective_time ?? '').localeCompare(a.effective_time ?? ''))[0];
  if (!best?.set_id || !best.effective_time) return { status: 'no label', rxcui };
  const sections: Partial<Record<(typeof SECTIONS)[number], string>> = {};
  for (const s of SECTIONS) {
    const v = best[s];
    const text = Array.isArray(v) ? v.join('\n').trim() : '';
    if (text) sections[s] = text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
  }
  const title = best.openfda?.generic_name?.[0];
  return { status: 'ok', rxcui, setId: best.set_id, effective: best.effective_time, ...(title && { title }), sections };
}

export async function drugLabel(rxcui: string, opts: { fetch?: typeof fetch; dir?: string; now?: Date } = {}): Promise<LabelSections> {
  if (!/^\d{1,10}$/.test(rxcui)) return { status: 'no code' };
  const f = opts.fetch ?? fetch;
  const now = (opts.now ?? new Date()).getTime();
  const file = join(opts.dir ?? join(dirname(defaultConfigPath()), 'labels'), `${rxcui}.json`);
  try {
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: number; result: LabelSections };
      if (now - c.fetchedAt < TTL) return c.result;
    }
  } catch { /* corrupt cache: refetch */ }
  let result: LabelSections;
  try {
    let labels = await query(f, [rxcui]);
    if (!labels?.length) {
      const codes = (await related(f, rxcui)).filter((c) => c !== rxcui);
      labels = codes.length ? await query(f, codes) : null;
    }
    result = pick(rxcui, labels ?? []);
  } catch {
    return { status: 'unavailable', rxcui }; // never cached
  }
  try { writeAtomic(file, JSON.stringify({ fetchedAt: now, result })); } catch { /* cache is best effort */ }
  return result;
}
