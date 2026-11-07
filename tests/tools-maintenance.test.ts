import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MedplumClient } from '@medplum/core';
import { takeConfirmPage } from '../src/confirm.ts';
import { registerMaintenanceTools } from '../src/tools/maintenance.ts';

const NOTE = 'Plan: repeat colonoscopy\nin 3 years, per Dr. X.';
const setup = async (remote = true) => {
  const created: any[] = [];
  const doc = (subject: string) => ({ resourceType: 'DocumentReference', id: 'd1', subject: { reference: subject }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(NOTE).toString('base64') } }] });
  const client = {
    readResource: async (type: string, id: string) => {
      if (type === 'Patient') return { resourceType: 'Patient', birthDate: '1970-01-01', gender: 'female' };
      if (id === 'd1') return doc('Patient/p');
      if (type === 'Communication' && id === 'm1') return { resourceType: 'Communication', id: 'm1', status: 'completed', subject: { reference: 'Patient/p' }, payload: [{ contentString: 'Started the new medicine. We will repeat your lab panel in 6 weeks.' }] };
      if (id === 'other') return doc('Patient/q');
      throw new Error('not found');
    },
    searchResourcePages: async function* () { yield []; },
    searchResources: async () => [],
    createResource: async (r: any) => { created.push(r); return { ...r, id: `id${created.length}` }; },
  } as unknown as MedplumClient;
  const server = new McpServer({ name: 't', version: '0' });
  registerMaintenanceTools(server, { client, cfg: {} as never, patientId: 'p', ...(remote && { remote: { publicUrl: 'https://x.example', clientName: 'chat app', log: async () => {} } }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError, msg: r.content[0].text, json: r.isError ? undefined : JSON.parse(r.content[0].text) };
  };
  return { created, call };
};

describe('postpone', () => {
  it('writes a Basic and Provenance for a listed topic', async () => {
    const { created, call } = await setup();
    const r = await call('postpone', { topic: 'COLORECTAL', until: '2027-03-01', reason: 'after the trip' });
    expect(r.json).toEqual({ topic: 'colorectal', recorded: 'postpone', until: '2027-03-01' });
    expect(created[0]).toMatchObject({
      resourceType: 'Basic', subject: { reference: 'Patient/p' }, code: { coding: [{ system: 'urn:ga-server:reminder', code: 'postpone' }] },
      extension: [{ url: 'urn:ga-server:ext:topic', valueString: 'colorectal' }, { url: 'urn:ga-server:ext:until', valueDate: '2027-03-01' }],
    });
    expect(created[0].created).toMatch(/^\d{4}-/);
    expect(created[1]).toMatchObject({ resourceType: 'Provenance', target: [{ reference: 'Basic/id1' }], agent: [{ who: { display: 'chat app' } }] });
  });
  it('refuses dismiss for a high-importance item; not-now is coded', async () => {
    const { created, call } = await setup();
    const r = await call('postpone', { topic: 'colorectal', dismiss: true });
    expect(r.error).toBe(true);
    expect(r.msg).toContain('not now');
    expect(created).toEqual([]);
    await call('postpone', { topic: 'colorectal' });
    expect(created.filter((x) => x.resourceType === 'Basic').map((x) => x.code.coding[0].code)).toEqual(['not-now']);
  });
  it('refuses an unknown topic and until with dismiss, writing nothing', async () => {
    const { created, call } = await setup();
    expect((await call('postpone', { topic: 'nonsense' })).error).toBe(true);
    expect((await call('postpone', { topic: 'colorectal', until: '2027-03-01', dismiss: true })).error).toBe(true);
    expect(created).toEqual([]);
  });
});

describe('record_followup', () => {
  const args = { topic: 'Colonoscopy', due: '2029-05-01', quote: 'REPEAT colonoscopy in 3  years', documentRef: 'DocumentReference/d1' };
  it('stdio: previews first, writes only with the confirm code', async () => {
    const { created, call } = await setup(false);
    const p = await call('record_followup', args);
    expect(p.json.confirm).toBeTruthy();
    expect(created).toEqual([]);
    expect((await call('record_followup', { ...args, due: '2030-01-01', confirm: p.json.confirm })).error).toBe(true); // changed arguments
    const p2 = await call('record_followup', args);
    expect((await call('record_followup', { ...args, confirm: p2.json.confirm })).json.recorded).toBe('followup');
    expect(created[0]).toMatchObject({
      resourceType: 'Basic', code: { coding: [{ system: 'urn:ga-server:reminder', code: 'followup' }] },
      extension: [{ url: 'urn:ga-server:ext:topic', valueString: 'Colonoscopy' }, { url: 'urn:ga-server:ext:due', valueDate: '2029-05-01' }, { url: 'urn:ga-server:ext:quote', valueString: args.quote }],
    });
    expect(created[1]).toMatchObject({ resourceType: 'Provenance', entity: [{ what: { reference: 'DocumentReference/d1' } }] });
    expect((await call('record_followup', { ...args, confirm: p2.json.confirm })).error).toBe(true); // used
  });
  it('remote: the preview links to the confirm page; the agent cannot confirm, the page writes', async () => {
    const { created, call } = await setup();
    const p = await call('record_followup', args);
    expect(p.json.confirm).toBeUndefined();
    const code = p.json.confirmUrl.split('/').pop();
    await call('record_followup', { ...args, confirm: code });
    expect(created).toEqual([]);
    expect((await takeConfirmPage(code)!.run()).done).toContain('recorded');
    expect(created.map((x) => x.resourceType)).toEqual(['Basic', 'Provenance']);
    expect(created[1].agent[0].who.display).toBe('chat app');
  });
  it('accepts a MyChart message as the source, checking the quote against its text', async () => {
    const { created, call } = await setup(false);
    const m = { ...args, topic: 'Repeat lab panel', quote: 'repeat your lab panel in 6 weeks', documentRef: 'Communication/m1' };
    const p = await call('record_followup', m);
    expect(p.json.confirm).toBeTruthy();
    expect((await call('record_followup', { ...m, quote: 'in 3 months' })).error).toBe(true);
    await call('record_followup', { ...m, confirm: p.json.confirm });
    expect(created[1]).toMatchObject({ resourceType: 'Provenance', entity: [{ what: { reference: 'Communication/m1' } }] });
  });
  it('an impossible date fails validation cleanly', async () => {
    const { created, call } = await setup();
    expect((await call('record_followup', { ...args, due: '2027-13-01' })).error).toBe(true);
    expect(created).toEqual([]);
  });
  it('refuses a quote not in the document, another patient\'s or a missing document', async () => {
    const { created, call } = await setup();
    expect((await call('record_followup', { ...args, quote: 'in 5 years' })).error).toBe(true);
    expect((await call('record_followup', { ...args, documentRef: 'DocumentReference/other' })).error).toBe(true);
    expect((await call('record_followup', { ...args, documentRef: 'DocumentReference/none' })).error).toBe(true);
    expect(created).toEqual([]);
  });
});

describe('postpone done', () => {
  it('needs a method from the rule, then records', async () => {
    const { created, call } = await setup();
    const miss = await call('postpone', { topic: 'colorectal', done: { date: '2024' } });
    expect(miss.error).toBe(true);
    expect(miss.msg).toContain('method must be one of: colonoscopy, stool test (FIT or gFOBT)');
    expect(created).toEqual([]);
    const r = await call('postpone', { topic: 'colorectal', done: { date: '2024-05', method: 'Colonoscopy', where: 'City GI' }, reason: 'told me' });
    expect(r.json).toEqual({ topic: 'colorectal', recorded: 'done', date: '2024-05' });
    expect(created[0]).toMatchObject({ code: { coding: [{ code: 'done' }] }, extension: [
      { url: 'urn:ga-server:ext:topic', valueString: 'colorectal' }, { url: 'urn:ga-server:ext:done-date', valueString: '2024-05' },
      { url: 'urn:ga-server:ext:method', valueString: 'colonoscopy' }, { url: 'urn:ga-server:ext:where', valueString: 'City GI' }] });
    expect(created[1].reason[0].text).toBe('done "colorectal" 2024-05 colonoscopy at City GI: told me');
  });
  it('refuses a screening done with no method', async () => {
    const { call } = await setup();
    expect((await call('postpone', { topic: 'colorectal', done: { date: '2024' } })).error).toBe(true);
  });
  it('refuses until, dismiss, a future date and a bad date', async () => {
    const { created, call } = await setup();
    const done = { date: '2024', method: 'colonoscopy' };
    expect((await call('postpone', { topic: 'colorectal', done, until: '2027-03-01' })).error).toBe(true);
    expect((await call('postpone', { topic: 'colorectal', done, dismiss: true })).error).toBe(true);
    expect((await call('postpone', { topic: 'colorectal', done: { ...done, date: '2999-01' } })).error).toBe(true);
    expect((await call('postpone', { topic: 'colorectal', done: { ...done, date: '2024-13' } })).error).toBe(true);
    expect(created).toEqual([]);
  });
});
