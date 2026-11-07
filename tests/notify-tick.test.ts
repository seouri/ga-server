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
