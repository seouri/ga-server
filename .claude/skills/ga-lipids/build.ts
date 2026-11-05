#!/usr/bin/env node
// Builds the lipid trend page straight from GA: values never pass through the agent.
// Usage: node .claude/skills/ga-lipids/build.ts [since YYYY[-MM-DD]]
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MedicationStatement, Observation } from '@medplum/fhirtypes';
import { GaError, getClient, loadConfig } from '../../../src/config.ts';

type Test = 'tc' | 'ldl' | 'hdl' | 'tg';
type LdlKind = 'direct' | 'calculated' | 'text';
export type Panel = {
  d: string; tc: number | null; ldl: number | null; hdl: number | null; tg: number | null;
  ldlKind: LdlKind | null; src: string; llm: boolean; dup: boolean;
};

const LOINC: Record<string, [Test, LdlKind?]> = {
  '2093-3': ['tc'], '2085-9': ['hdl'], '2571-8': ['tg'], '13457-7': ['ldl', 'calculated'], '18262-6': ['ldl', 'direct'],
};
const RANK: Record<LdlKind, number> = { direct: 3, calculated: 2, text: 1 };
const TAG = 'urn:ga-server:tag';
const STATIN = /\b(atorva|rosuva|simva|prava|lova|pitava|fluva)statin\b|\bezetimibe\b/i;
const hasTag = (o: Observation, code: string) => !!o.meta?.tag?.some((t) => t.system === TAG && t.code === code);

// One panel per collection day; direct LDL beats calculated beats text-only; missing tests stay null.
export function toPanels(obs: Observation[]): { panels: Panel[]; otherUnits: number } {
  const byDay = new Map<string, Panel>();
  const files = new Map<string, Set<string>>();
  let otherUnits = 0;
  for (const o of obs) {
    const d = (o.effectiveDateTime ?? o.effectivePeriod?.start)?.slice(0, 10);
    const v = o.valueQuantity?.value;
    if (!d || typeof v !== 'number') continue;
    const loinc = o.code?.coding?.find((c) => c.system === 'http://loinc.org' && c.code && LOINC[c.code])?.code;
    if (!loinc && !/\bLDL\b/i.test(o.code?.text ?? '')) continue;
    const [test, kind]: [Test, LdlKind?] = loinc ? LOINC[loinc] : ['ldl', 'text'];
    const unit = (o.valueQuantity?.code ?? o.valueQuantity?.unit ?? 'mg/dL').toLowerCase();
    if (unit !== 'mg/dl') {
      otherUnits++; // shortcut: only mg/dL is charted, convert mmol/L when such data shows up
      continue;
    }
    const p = byDay.get(d) ?? { d, tc: null, ldl: null, hdl: null, tg: null, ldlKind: null, src: '', llm: false, dup: false };
    byDay.set(d, p);
    if (test === 'ldl') {
      if (p.ldl !== null && RANK[kind as LdlKind] <= RANK[p.ldlKind as LdlKind]) continue;
      p.ldl = v;
      p.ldlKind = kind as LdlKind;
    } else if (p[test] === null) p[test] = v;
    else continue;
    p.llm ||= hasTag(o, 'extracted-by-llm');
    p.dup ||= hasTag(o, 'possible-duplicate');
    if (o.meta?.source) (files.get(d) ?? files.set(d, new Set()).get(d)!).add(basename(o.meta.source));
  }
  const panels = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d));
  for (const p of panels) p.src = [...(files.get(p.d) ?? [])].join(', ');
  return { panels, otherUnits };
}

// Inserts the data into the template; `<` is escaped so a value can't close the script tag.
export function fill(template: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const out = template.replace(/(<script id="ga-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_m, a, b) => a + json + b);
  if (out === template) throw new GaError('template has no ga-data slot');
  return out;
}

async function main(arg: string): Promise<void> {
  const since = arg.match(/\d{4}(-\d{2}-\d{2})?/)?.[0];
  const cfg = loadConfig();
  const client = await getClient(cfg);
  const subject = `Patient/${cfg.patientId}`;
  const date = since ? { date: `ge${since.length === 4 ? `${since}-01-01` : since}` } : {};
  const coded = await client.searchResources('Observation', { subject, code: Object.keys(LOINC).map((c) => `http://loinc.org|${c}`).join(','), _count: '1000', ...date });
  const text = await client.searchResources('Observation', { subject, 'code:text': 'LDL', _count: '1000', ...date });
  const { panels, otherUnits } = toPanels([...new Map([...coded, ...text].map((o) => [o.id, o])).values()]);

  // Statin start dates, only where the record names the drug.
  const annotations: { d: string; label: string }[] = [];
  for (const ms of await client.searchResources('MedicationStatement', { subject, _count: '200' }) as MedicationStatement[]) {
    const start = ms.effectivePeriod?.start ?? ms.effectiveDateTime;
    if (!start) continue;
    let cc = ms.medicationCodeableConcept;
    if (!cc && ms.medicationReference?.reference) cc = (await client.readReference(ms.medicationReference as never) as { code?: typeof cc }).code;
    const name = [cc?.text, ...(cc?.coding ?? []).map((c) => c.display)].find((n) => n && STATIN.test(n));
    if (name) annotations.push({ d: start.slice(0, 10), label: `${name} started` });
  }

  const dir = '/tmp/ga-reports';
  const file = join(dir, `lipids-${new Date().toISOString().slice(0, 10)}.html`);
  mkdirSync(dir, { recursive: true });
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'template.html'), 'utf8');
  writeFileSync(file, fill(template, { panels, annotations }), { mode: 0o600 });
  chmodSync(file, 0o600); // mode above only applies when the file is new; it holds health data
  chmodSync(dir, 0o700);
  try {
    execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'ignore' });
  } catch {
    // headless or no opener: the path below is enough
  }

  const missing = (['tc', 'ldl', 'hdl', 'tg'] as const).filter((k) => panels.some((p) => p[k] === null));
  console.log(
    [
      panels.length ? `panels: ${panels.length}, ${panels[0].d} to ${panels.at(-1)!.d}` : 'panels: 0 (no lipid results in GA)',
      `missing tests: ${missing.length ? panels.filter((p) => missing.some((k) => p[k] === null)).map((p) => `${p.d} (${missing.filter((k) => p[k] === null).join(', ')})`).join('; ') : 'none'}`,
      `AI-extracted panels: ${panels.filter((p) => p.llm).map((p) => p.d).join(', ') || 'none'}`,
      `possible-duplicate panels: ${panels.filter((p) => p.dup).map((p) => p.d).join(', ') || 'none'}`,
      `statin markers: ${annotations.map((a) => `${a.d} ${a.label}`).join('; ') || 'none (no named statin record)'}`,
      ...(otherUnits ? [`skipped ${otherUnits} result(s) not in mg/dL`] : []),
      `file: ${file}`,
    ].join('\n'),
  );
}

if (import.meta.main) {
  console.warn = () => {}; // Medplum client warnings are noise here
  main(process.argv.slice(2).join(' ')).catch((e) => {
    console.error(e instanceof GaError ? e.message : e);
    process.exit(1);
  });
}
