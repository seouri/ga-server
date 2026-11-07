import { randomUUID } from 'node:crypto';
import type { MedplumClient } from '@medplum/core';
import type { Endpoint } from '@medplum/fhirtypes';
import { healthMaintenance } from '../maintenance.ts';
import { whatsNew } from '../whats-new.ts';
import { digestMessage, resultMessage } from './compose.ts';
import { enqueue, pending } from './outbox.ts';
import { digestTime, dueToSend, inSleep, newResults } from './select.ts';
import { readSettings, readState, writeState } from './settings.ts';

export type TickDeps = {
  client: MedplumClient; patientId: string; dir: string; eps: () => Promise<Endpoint[]>; now: Date;
  whatsNew?: typeof whatsNew; healthMaintenance?: typeof healthMaintenance;
};

export async function tick(d: TickDeps): Promise<void> {
  const s = readSettings(d.dir);
  if (!s || s.off || inSleep(d.now, s.sleep)) return;
  const wn = d.whatsNew ?? whatsNew, hm = d.healthMaintenance ?? healthMaintenance;
  const state = readState(d.dir);
  let lastDigestDay = state.lastDigestDay;
  const asOf = d.now.toLocaleDateString('en-CA');
  const queued = new Set(pending(d.dir).flatMap((o) => o.keys));
  const since = state.checkedAt && new Date(state.checkedAt).getTime() - 600_000 > new Date(s.setupAt).getTime() ? new Date(new Date(state.checkedAt).getTime() - 600_000).toISOString() : s.setupAt;
  // Never markSeen: notify must not clear what the person has not looked at.
  const res = newResults((await wn(d.client, d.patientId, d.eps(), { since, asOf })).items, state, asOf).filter((i) => !queued.has(`result:${i.id}`));
  if (res.length) enqueue(d.dir, { id: randomUUID(), kind: 'result', text: resultMessage(res), keys: res.map((i) => `result:${i.id}`) });
  if (digestTime(d.now, s.digestAt, state.lastDigestDay)) {
    const due = dueToSend((await hm(d.client, d.patientId, asOf)).items, state, asOf).filter((i) => !queued.has(`topic:${i.topic}`));
    const w = await wn(d.client, d.patientId, d.eps(), { since: state.lastDigestDay ?? s.setupAt, asOf });
    const meds = w.items.filter((i) => i.kind === 'new medication');
    if (due.length || meds.length) enqueue(d.dir, { id: randomUUID(), kind: 'digest', text: digestMessage(meds, due, Array.isArray(w.medicationCheck) ? (w.medicationCheck as never) : []), keys: due.map((i) => `topic:${i.topic}`) });
    lastDigestDay = asOf;
  }
  // Re-read: an exchange may have acked while this tick awaited the server.
  writeState(d.dir, { ...readState(d.dir), lastDigestDay, checkedAt: d.now.toISOString() });
}
