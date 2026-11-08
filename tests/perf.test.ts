import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MedplumClient } from '@medplum/core';
import { buildMcpServer } from '../src/mcp.ts';
import { countingFetch, perfSummary, record, timed } from '../src/perf.ts';

let dir: string, f: string;
const old = process.env.GA_CONFIG;
beforeEach(() => { process.env.GA_PERF_TEST = '1'; dir = mkdtempSync(join(tmpdir(), 'perf-')); f = join(dir, 'perf.jsonl'); process.env.GA_CONFIG = join(dir, 'config.json'); });
afterEach(() => { delete process.env.GA_PERF_TEST; process.env.GA_CONFIG = old; vi.unstubAllGlobals(); });
const settle = () => new Promise((r) => setTimeout(r, 100));
const lines = () => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function call(args: Record<string, unknown>) {
  const client = { search: async () => ({ resourceType: 'Bundle', entry: [] }), searchResources: async () => [] } as unknown as MedplumClient;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([buildMcpServer({ client, cfg: {} as never, patientId: 'p' }).connect(a), c.connect(b)]);
  return c.callTool({ name: 'fhir_search', arguments: args });
}

test('a tool call logs one line without arguments; file is 0600', async () => {
  await call({ resourceType: 'Observation', code: 'DISTINCTIVE-ARG-9' });
  await settle();
  const [l] = lines();
  expect(lines()).toHaveLength(1);
  expect(l).toMatchObject({ tool: 'fhir_search', app: 't', ok: true, requests: 0 });
  expect(l.ms).toBeGreaterThanOrEqual(0);
  expect(l.bytes).toBeGreaterThan(0);
  expect(readFileSync(f, 'utf8')).not.toContain('DISTINCTIVE-ARG-9');
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test('concurrent calls keep separate request counts', async () => {
  vi.stubGlobal('fetch', async () => new Response('{}'));
  const run = (n: number) => timed('x', 'a', async () => {
    for (let i = 0; i < n; i++) { await countingFetch('http://x'); await new Promise((r) => setTimeout(r, 1)); }
    return { content: [] };
  });
  await Promise.all([run(2), run(5)]);
  await settle();
  expect(lines().map((l) => l.requests).sort()).toEqual([2, 5]);
});

test('retention drops a 31-day-old line', async () => {
  const old = JSON.stringify({ t: new Date(Date.now() - 31 * 86_400_000).toISOString(), tool: 'old', app: 'a', ms: 1, ok: true });
  writeFileSync(f, `${old}\n`);
  record({ tool: 'new', app: 'a', ms: 1, ok: true });
  await settle();
  expect(lines().map((l) => l.tool)).toEqual(['new']);
});

test('ga perf math: median, p95, requests, errors, text replies', () => {
  const t = new Date().toISOString();
  const rows = [10, 20, 30, 40, 100].map((ms, i) => ({ t, tool: 'lab_results', app: 'a', ms, requests: i, ok: i !== 4 }));
  rows.push({ t: '2020-01-01T00:00:00Z', tool: 'lab_results', app: 'a', ms: 9999, requests: 0, ok: true });
  rows.push({ t, tool: 'text reply', app: 'iMessage', ms: 500, llmMs: 400, toolMs: 80, ok: true } as never);
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n'));
  const out = perfSummary(7, f);
  expect(out).toMatch(/lab_results\s+5\s+30\s+100\s+2\.0\s+20/);
  expect(out).toContain('text replies: 1, median total 500 ms, llm 400 ms, tools 80 ms');
});

test('an unwritable log dir does not fail the call', async () => {
  writeFileSync(join(dir, 'blocker'), '');
  process.env.GA_CONFIG = join(dir, 'blocker', 'config.json'); // parent is a file
  const r = (await call({ resourceType: 'Observation' })) as { isError?: boolean };
  await settle();
  expect(r.isError).toBeFalsy();
});

test('under vitest without the opt-in nothing is written', async () => {
  delete process.env.GA_PERF_TEST;
  record({ tool: 'x', app: 'a', ms: 1, ok: true });
  await settle();
  expect(() => readFileSync(f)).toThrow();
});
