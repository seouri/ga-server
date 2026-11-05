import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { extractWithApi } from '../src/llm.ts';

const stub = (msg: any) => ({ messages: { stream: () => ({ finalMessage: async () => msg }) } });
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('node', ['src/cli.ts', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, ...env } });

test('pdf without --llm api refuses with guidance', () => {
  const r = cli(['import', '/tmp/x.pdf']);
  expect(r.status).toBe(1);
  expect(r.stderr.trim()).toBe('PDFs are extracted by your agent: ask it to import /tmp/x.pdf, or pass --llm api');
});

test('--llm api without ANTHROPIC_API_KEY names the variable', () => {
  const r = cli(['import', '/tmp/x.pdf', '--llm', 'api']);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('ANTHROPIC_API_KEY');
});

test('extractWithApi parses tool output into resources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-llm-'));
  const file = join(dir, 'r.pdf');
  writeFileSync(file, '%PDF-1.4 fake');
  const calls: any[] = [];
  const fake = {
    messages: {
      stream: (p: any) => {
        calls.push(p);
        return { finalMessage: async () => ({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'submit_resources', input: { resources: [{ resourceType: 'Observation' }] } }],
        }) };
      },
    },
  };
  const out = await extractWithApi(file, 'k', fake as any);
  expect(out).toEqual([{ resourceType: 'Observation' }]);
  expect(calls[0].model).toBe('claude-opus-5-5');
  expect(calls[0].messages[0].content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
  expect(calls[0].system).toContain('Never invent values');
});

test('extractWithApi rejects a response with no tool output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-llm-'));
  const file = join(dir, 'r.png');
  writeFileSync(file, 'x');
  const fake = stub({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] });
  await expect(extractWithApi(file, 'k', fake as any)).rejects.toThrow('no resources');
});

test('extractWithApi reports max_tokens as too long', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ga-llm-')), 'r.pdf');
  writeFileSync(file, 'x');
  await expect(extractWithApi(file, 'k', stub({ stop_reason: 'max_tokens', content: [] }) as any)).rejects.toThrow('document too long for one extraction call');
});

test.each([
  ['r.png', 'image', 'image/png'],
  ['r.jpg', 'image', 'image/jpeg'],
  ['r.jpeg', 'image', 'image/jpeg'],
  ['r.pdf', 'document', 'application/pdf'],
])('%s is sent as a %s block', async (name, type, media) => {
  const file = join(mkdtempSync(join(tmpdir(), 'ga-llm-')), name);
  writeFileSync(file, 'x');
  let sent: any;
  const fake = { messages: { stream: (p: any) => ((sent = p), { finalMessage: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_resources', input: { resources: [{ resourceType: 'Observation' }] } }] }) }) } };
  await extractWithApi(file, 'k', fake as any);
  expect(sent.messages[0].content[0]).toMatchObject({ type, source: { type: 'base64', media_type: media } });
});
