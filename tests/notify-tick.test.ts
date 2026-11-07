import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeJson } from '../src/gateway/store.ts';
import { ack, pending } from '../src/notify/outbox.ts';
import { readState, type Settings } from '../src/notify/settings.ts';
import { tick } from '../src/notify/tick.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ga-notify-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settings: Settings = { to: '+15550100', digestAt: '09:00', sleep: ['22:00', '07:00'], setupAt: '2026-11-01T00:00:00.000Z' };
const lab = { kind: 'lab', title: 'LDL', date: '2026-11-07', detail: { value: 190, flag: 'high' }, id: 'Observation/1' };
let wnItems: unknown[] = [];
let due: unknown[] = [];
const deps = (now: Date) => ({
  client: {} as never, patientId: 'p', dir, eps: async () => [], now,
  whatsNew: (async () => ({ items: wnItems, medicationCheck: [] })) as never,
  healthMaintenance: (async () => ({ items: due })) as never,
});
const at = (h: number, m = 0) => new Date(2026, 10, 7, h, m);
beforeEach(() => { writeJson(dir, 'settings.json', settings); wnItems = [lab]; due = []; });

it('tick during sleep enqueues nothing', async () => {
  await tick(deps(at(3)));
  expect(pending(dir)).toEqual([]);
});
it('a 03:00 result is enqueued at 07:00 once', async () => {
  await tick(deps(at(3)));
  await tick(deps(at(7)));
  await tick(deps(at(7, 1)));
  expect(pending(dir)).toHaveLength(1);
  expect(pending(dir)[0].keys).toEqual(['result:Observation/1']);
});
it('tick does not re-enqueue a pending or sent result', async () => {
  await tick(deps(at(8)));
  await tick(deps(at(8, 1)));
  expect(pending(dir)).toHaveLength(1);
  ack(dir, [pending(dir)[0].id], [], at(8, 2));
  expect(pending(dir)).toEqual([]);
  await tick(deps(at(8, 3)));
  expect(pending(dir)).toEqual([]);
  expect(readState(dir).sentResults['Observation/1']).toBe('2026-11-07');
  expect(readState(dir).lastSend).toBeDefined();
});
it('ack failed keeps it and sets lastError', async () => {
  await tick(deps(at(8)));
  const id = pending(dir)[0].id;
  ack(dir, [], [{ id, error: 'bridge down' }], at(8, 1));
  expect(pending(dir)).toHaveLength(1);
  expect(readState(dir).lastError).toBe('bridge down');
});
it('digest on an empty day sends nothing and sets lastDigestDay', async () => {
  wnItems = [];
  await tick(deps(at(9, 5)));
  expect(pending(dir)).toEqual([]);
  expect(readState(dir).lastDigestDay).toBe('2026-11-07');
});
it('digest with a due item queues one with its topic key', async () => {
  wnItems = [];
  due = [{ topic: 'colon', name: 'Colonoscopy', kind: 'screening', status: 'overdue', importance: 'high', evidence: [] }];
  await tick(deps(at(9, 5)));
  expect(pending(dir).map((o) => [o.kind, o.keys])).toEqual([['digest', ['topic:colon']]]);
});

// A whatsNew fake that honors `since` and records its calls.
const calls: { since?: string; markSeen?: unknown }[] = [];
const honoring = (all: { id?: string; kind: string; title: string; date: string; arrived: string; detail: object }[], extra: object = {}) => (async (_c: unknown, _p: unknown, _e: unknown, o: { since?: string; markSeen?: unknown }) => {
  calls.push(o);
  return { items: all.filter((i) => i.arrived >= o.since!), medicationCheck: [], ...extra };
}) as never;

it('since is max(setupAt, checkedAt - 10 min), never markSeen', async () => {
  calls.length = 0;
  const d = (now: Date) => ({ ...deps(now), whatsNew: honoring([]) });
  await tick(d(at(8)));
  await tick(d(at(8, 30)));
  expect(calls[0].since).toBe(settings.setupAt);
  expect(calls[1].since).toBe(at(7, 50).toISOString());
  expect(calls.every((c) => !('markSeen' in c))).toBe(true);
});
it('a new medication appears in one digest only, even on the next day', async () => {
  const med = { id: 'm', kind: 'new medication', title: 'Statin', date: '2026-11-07', arrived: at(8).toISOString(), detail: {} };
  const day = (n: number, h: number, m = 0) => new Date(2026, 10, 7 + n, h, m);
  await tick({ ...deps(day(0, 9, 5)), whatsNew: honoring([med]) });
  expect(pending(dir)).toHaveLength(1);
  const id = pending(dir)[0].id;
  ack(dir, [id], [], day(0, 9, 6));
  await tick({ ...deps(day(1, 9, 5)), whatsNew: honoring([med]) });
  expect(pending(dir)).toEqual([]);
});
it('a labs section error or a throw does not advance checkedAt', async () => {
  await tick(deps(at(8)));
  const before = readState(dir).checkedAt;
  await tick({ ...deps(at(8, 5)), whatsNew: honoring([], { sectionErrors: { labs: 'x' } }) });
  expect(readState(dir).checkedAt).toBe(before);
  expect(readState(dir).lastError).toMatch(/labs/);
  await expect(tick({ ...deps(at(8, 6)), whatsNew: (async () => { throw new Error('down'); }) as never })).rejects.toThrow();
  expect(readState(dir).checkedAt).toBe(before);
});
