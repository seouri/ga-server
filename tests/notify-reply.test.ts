import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import { findConfirmPage } from '../src/confirm.ts';
import { pending } from '../src/notify/outbox.ts';
import { createReplier } from '../src/notify/reply.ts';
import { writeJson } from '../src/gateway/store.ts';

type Msg = Record<string, any>;
const call = (name: string, args: object = {}, id = 'c1') => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const say = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { content } }] });

const setup = (script: unknown[], opts: { publicUrl?: string; model?: string | null; fail?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-reply-'));
  writeJson(dir, 'settings.json', { to: '+1 (555) 010-0000', digestAt: '08:00', sleep: ['22:00', '07:00'], setupAt: '2026-11-01T00:00:00Z' });
  const audits: any[] = [];
  const client = {
    createResource: async (r: any) => (audits.push(r), r),
    search: async () => ({ resourceType: 'Bundle', entry: [] }),
    searchResources: async () => [],
    searchResourcePages: async function* () { yield []; },
    searchOne: async () => undefined,
    readResource: async () => ({ resourceType: 'Patient', birthDate: '1980-01-01' }),
  } as unknown as MedplumClient;
  const seen: Msg[] = [];
  const llm = { chat: { completions: { create: async (p: Msg) => { seen.push(structuredClone(p)); if (opts.fail) throw new Error('boom'); return script.shift(); } } } };
  const r = createReplier({ client, cfg: {} as never, patientId: 'p', dir, publicUrl: opts.publicUrl, ...(opts.model === null ? {} : { llm, model: opts.model ?? 'm' }) });
  const text = (t: string, from = '+15550100000') => r.onIncoming({ from, text: t, at: '2026-11-07T12:00:00Z' });
  return { r, dir, audits, seen, text };
};
const names = (p: Msg) => p.tools.map((t: Msg) => t.function.name);

describe('answering texts', () => {
  it('non-owner text is ignored and logged without content', async () => {
    const { text, dir, audits, seen } = setup([say('hi')]);
    await text('secret words', '+15559999999');
    expect(pending(dir)).toEqual([]);
    expect(seen).toEqual([]);
    expect(JSON.stringify(audits)).not.toContain('secret words');
    expect(audits.map((a) => a.entity[0].what.display)).toEqual(['ignored sender']);
  });

  it('owner handles match after stripping spaces, dashes, parentheses and a leading +', async () => {
    const { text, dir, audits } = setup([say('ok')]);
    await text('hello', '15550100000');
    expect(pending(dir)).toHaveLength(1);
    expect(audits[0].entity[0].what.display).toBe('received');
  });

  it('the model sees only allowed tools; share_create only with publicUrl and its confirmUrl resolves here', async () => {
    const a = setup([say('ok')]);
    await a.text('hi');
    const n = names(a.seen[0]);
    expect(n).toContain('health_maintenance');
    expect(n).toContain('postpone');
    expect(n).not.toContain('share_create');
    for (const bad of ['hospital_sync', 'ga_import', 'map_concept', 'import_file', 'share_list', 'disconnect_app']) expect(n).not.toContain(bad);

    const b = setup([call('share_create', { audience: 'family', label: 'Mom', scope: ['labs'] }), say('done')], { publicUrl: 'https://x.example' });
    await b.text('share my labs with mom');
    expect(names(b.seen[0])).toEqual(expect.arrayContaining(['share_create', 'hospital_enable']));
    const result = JSON.parse(b.seen[1].messages.at(-1).content);
    const code = /\/confirm\/([A-Za-z0-9_-]{43})$/.exec(result.confirmUrl)![1];
    expect(findConfirmPage(code)).toBeDefined();
  });

  it('a disallowed tool call is refused and not executed', async () => {
    const { text, seen, audits } = setup([call('hospital_sync'), say('cannot')]);
    await text('sync now');
    expect(seen[1].messages.at(-1).content).toContain('tool not available by text');
    expect(audits.map((a) => a.entity[0].what.display)).not.toContain('hospital_sync');
  });

  it('no model gives the setup reply; a provider error gives the try-again reply and does not throw', async () => {
    const a = setup([], { model: null });
    await a.text('hi');
    expect(pending(a.dir)[0]).toMatchObject({ kind: 'reply', keys: [], text: "GA can't answer texts until an AI provider is set (GA_LLM_MODEL)." });
    const b = setup([], { fail: true });
    await b.text('hi');
    expect(pending(b.dir)[0].text).toBe("GA couldn't answer just now. Try again later.");
  });

  it('long replies are cut', async () => {
    const { text, dir } = setup([say('x'.repeat(3000))]);
    await text('hi');
    const t = pending(dir)[0].text;
    expect(t.length).toBeLessThan(1600);
    expect(t.endsWith('…(cut short; ask a narrower question)')).toBe(true);
  });

  it('the thread carries the last digest so "done" reaches postpone', async () => {
    const { r, text, seen, audits } = setup([call('postpone', { topic: 'Colonoscopy', done: { date: '2024-03-01', method: 'Colonoscopy' } }), say('noted')]);
    r.remember('Due soon: Colonoscopy. Reply done or not now.');
    await text('done');
    const msgs = seen[0].messages as Msg[];
    expect(msgs[0].content).toContain('You are answering by text message.');
    expect(msgs.slice(1)).toEqual([{ role: 'assistant', content: 'Due soon: Colonoscopy. Reply done or not now.' }, { role: 'user', content: 'done' }]);
    expect(seen[1].messages.at(-1).content).not.toContain('tool not available');
    expect(audits.map((a) => a.entity[0].what.display)).toContain('postpone');
  });

  it('without publicUrl record_followup and the confirm tools are hidden and refused, also under a case variant; whats_new loses markSeen', async () => {
    const { text, seen } = setup([call('record_followup', { topic: 't' }, 'a'), call('hospital_enable', {}, 'b'), call('Hospital_Sync', {}, 'c'), say('no')]);
    await text('hi');
    expect(names(seen[0])).not.toContain('record_followup');
    for (const i of [1, 2, 3]) expect(seen[i].messages.at(-1).content).toContain('tool not available by text');
  });

  it('whats_new is called without markSeen: nothing is marked seen (temp config dir)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ga-seen-'));
    const old = process.env.GA_CONFIG;
    process.env.GA_CONFIG = join(tmp, 'config.json');
    try {
      const { text, seen } = setup([call('whats_new', { markSeen: true }), say('ok')]);
      await text('what is new');
      expect(seen[1].messages.at(-1).content).not.toContain('error');
      expect(readdirSync(tmp)).not.toContain('whats-new.json');
    } finally {
      if (old === undefined) delete process.env.GA_CONFIG; else process.env.GA_CONFIG = old;
    }
  });
});
