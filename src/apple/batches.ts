import type { Identifier, Resource } from '@medplum/fhirtypes';
import { ecgItems, mapClinical } from './clinical.ts';
import { Daily } from './daily.ts';
import { type AhClinical, readItems } from './read.ts';
import { Readings, short } from './readings.ts';

export type Batch = { index: number; resources: Resource[] };

const firstId = (r: Resource): string[] => {
  const i = (r as { identifier?: Identifier[] }).identifier?.[0];
  return i ? [`${i.system}|${i.value}`] : [];
};

// Items sharing a key form one group, groups in order of their first item. A stable identifier twice (the engine keeps both
// apart by content only within one call) or an ECG and its classification (a reference resolves only within one call) must
// reach the engine in one batch.
export function together<T>(items: T[], keys: (t: T) => string[]): T[][] {
  const root: number[] = [];
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const owner = new Map<string, number>();
  items.forEach((t, i) => {
    root[i] = i;
    for (const k of keys(t)) {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, i);
      else { const a = find(o), b = find(i); root[Math.max(a, b)] = Math.min(a, b); } // a group's root is its first item
    }
  });
  const groups = new Map<number, T[]>();
  items.forEach((t, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g)?.push(t); });
  return [...groups.values()];
}

// The export's resources in today's order (readings as read, blood pressure, daily summaries, clinical records, ECGs), cut
// every `size` resources (a group is never cut, so a batch can run over). Only readings are emitted while reading; what needs
// the whole export (blood-pressure pairs, days, nights) follows when the read ends. Same export and size: same batches.
export async function* appleBatches(dir: string, opts: { size: number; timeZone: string }): AsyncGenerator<Batch, { exportDate: string; skips: Record<string, unknown> }> {
  let index = 0;
  let buf: Resource[] = [];
  const full: Resource[][] = [];
  const add = (...group: Resource[]) => {
    buf.push(...group);
    if (buf.length >= opts.size) { full.push(buf); buf = []; }
  };
  function* drain(): Generator<Batch> { while (full.length) yield { index: index++, resources: full.shift() as Resource[] }; }

  const readings = new Readings((o) => add(o));
  const daily = new Daily(opts.timeZone);
  const refs: AhClinical[] = [];
  const archiveOnly: Record<string, number> = {};
  const it = readItems(dir);
  let n = await it.next();
  for (; !n.done; n = await it.next()) {
    const x = n.value;
    if ('record' in x) {
      const a = readings.add(x.record);
      const b = daily.add(x.record);
      if (!a && !b) archiveOnly[short(x.record.type)] = (archiveOnly[short(x.record.type)] ?? 0) + 1;
    } else if ('summary' in x) daily.summary(x.summary);
    else if ('clinical' in x) refs.push(x.clinical);
    yield* drain();
  }
  const { exportDate, nested } = n.value;
  const rd = readings.result();
  yield* drain();
  for (const o of daily.sums()) { add(o); yield* drain(); }
  for (const g of together(daily.rings, firstId)) { add(...g); yield* drain(); }
  for (const o of daily.sleep()) { add(o); yield* drain(); }
  const cl = mapClinical(dir, refs), ecg = ecgItems(dir);
  const tail = [...cl.resources.map((r) => ({ keys: firstId(r), build: () => [r] })), ...ecg.items];
  for (const g of together(tail, (t) => t.keys)) { add(...g.flatMap((t) => t.build())); yield* drain(); }
  if (buf.length) yield { index: index++, resources: buf };
  return { exportDate, skips: { nested, archiveOnly, ...rd.skips, ...daily.skips, ...cl.skips, ...ecg.skips } };
}
