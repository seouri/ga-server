// Per-call performance log: .ga/perf.jsonl, one line per tool call or texted reply. Never arguments, results or record content.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfigPath } from './config.ts';
import { writeAtomic } from './smart/store.ts';

type Line = { t: string; tool: string; app: string; ms: number; ok: boolean; bytes?: number; requests?: number; llmMs?: number; toolMs?: number };
const DAY = 86_400_000;
const calls = new AsyncLocalStorage<{ n: number }>();
const pruned = new Map<string, number>();
const file = () => join(dirname(defaultConfigPath()), 'perf.jsonl');

// MedplumClient's fetch: counts the requests made inside a timed() call (per call, so concurrent calls never mix).
export const countingFetch: typeof fetch = (input, init) => {
  const s = calls.getStore();
  if (s) s.n++;
  return fetch(input, init);
};

// Fire and forget: a log problem never fails or slows a call. shortcut: a prune racing an append can drop that one line.
export function record(l: Omit<Line, 't'>): void {
  const f = file();
  void (async () => {
    await mkdir(dirname(f), { recursive: true, mode: 0o700 });
    await appendFile(f, `${JSON.stringify({ t: new Date().toISOString(), ...l })}\n`, { mode: 0o600 });
    if (Date.now() - (pruned.get(f) ?? 0) < DAY) return;
    pruned.set(f, Date.now());
    const keep = readFileSync(f, 'utf8').split('\n').filter((x) => x && Date.parse(JSON.parse(x).t) >= Date.now() - 30 * DAY);
    writeAtomic(f, keep.map((x) => `${x}\n`).join(''), 0o600);
  })().catch(() => {});
}

export async function timed<R extends { isError?: boolean; content?: { type: string; text?: string }[] }>(tool: string, app: string, run: () => Promise<R>): Promise<R> {
  const s = { n: 0 }, t0 = performance.now();
  let ok = false, bytes = 0;
  try {
    const r = await calls.run(s, run);
    ok = !r.isError;
    bytes = (r.content ?? []).reduce((n, c) => n + (c.text?.length ?? 0), 0);
    return r;
  } finally {
    record({ tool, app, ms: Math.round(performance.now() - t0), bytes, requests: s.n, ok });
  }
}

const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil(p * a.length) - 1)];
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

export function perfSummary(days = 7, path = file()): string {
  const since = Date.now() - days * DAY;
  const lines: Line[] = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((l) => Date.parse(l.t) >= since) : [];
  if (!lines.length) return `no calls logged in the last ${days} days`;
  const by = new Map<string, Line[]>();
  for (const l of lines) by.set(l.tool, [...(by.get(l.tool) ?? []), l]);
  const rows = [['tool', 'calls', 'median ms', 'p95 ms', 'avg requests', 'error %']];
  for (const [tool, ls] of [...by].filter(([t]) => t !== 'text reply').sort()) {
    const ms = ls.map((l) => l.ms);
    rows.push([tool, String(ls.length), String(q(ms, 0.5)), String(q(ms, 0.95)), avg(ls.map((l) => l.requests ?? 0)).toFixed(1), (100 * ls.filter((l) => !l.ok).length / ls.length).toFixed(0)]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const out = rows.map((r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  '));
  const t = by.get('text reply');
  if (t) out.push('', `text replies: ${t.length}, median total ${q(t.map((l) => l.ms), 0.5)} ms, llm ${q(t.map((l) => l.llmMs ?? 0), 0.5)} ms, tools ${q(t.map((l) => l.toolMs ?? 0), 0.5)} ms`);
  return out.join('\n');
}
