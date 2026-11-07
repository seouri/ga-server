// The outbox of messages GA wants sent: pure file I/O under .ga/notify. The bridge acks by id; keys mark results/topics sent on ack.
import { readJson, writeJson } from '../gateway/store.ts';
import { readState, writeState } from './settings.ts';

export type Outgoing = { id: string; text: string; kind: 'result' | 'digest' | 'reply'; keys: string[] };

export const pending = (dir: string): Outgoing[] => readJson<Outgoing[]>(dir, 'outbox.json', []);
export const enqueue = (dir: string, o: Outgoing): void => writeJson(dir, 'outbox.json', [...pending(dir).filter((p) => p.id !== o.id), o]);

export function ack(dir: string, sent: string[], failed: { id: string; error: string }[], now: Date): void {
  const all = pending(dir), state = readState(dir), day = now.toLocaleDateString('en-CA');
  const done = all.filter((o) => sent.includes(o.id));
  for (const o of done) for (const k of o.keys) {
    if (k.startsWith('result:')) state.sentResults[k.slice(7)] = day;
    else if (k.startsWith('topic:')) state.sentTopics[k.slice(6)] = day;
  }
  if (done.length) { state.lastSend = now.toISOString(); delete state.lastError; }
  if (failed.some((f) => all.some((o) => o.id === f.id))) state.lastError = failed.map((f) => f.error).join('; ').slice(0, 200);
  writeJson(dir, 'outbox.json', all.filter((o) => !sent.includes(o.id)));
  writeState(dir, state);
}
