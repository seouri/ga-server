import type { Item } from '../maintenance.ts';
import type { ReviewItem } from '../whats-new.ts';

const CAP = 1500;
const FDA = 'From the FDA label; not a full interaction screen. Ask your pharmacist.';

// Whole items only: when the cap bites, the rest become "…and N more: ask GA" before the final hint line.
// Plain text for iMessage: bullet items, details indented two spaces, blank lines between parts.
const item = (title: string, ...details: (string | undefined | '')[]): string => [`• ${title}`, ...details.filter(Boolean).map((d) => `  ${d}`)].join('\n');
function build(head: string, blocks: string[], hint: string, tail: string[] = []): string {
  const out = (n: number) => [head, ...blocks.slice(0, n), ...(n < blocks.length ? [`…and ${blocks.length - n} more: ask GA`] : []), ...tail, hint].join('\n\n');
  let n = blocks.length;
  while (n > 1 && out(n).length > CAP) n--;
  return out(n);
}

export function resultMessage(items: ReviewItem[]): string {
  const blocks = items.map((i) => {
    const d = i.detail as { value?: unknown; range?: unknown; flag?: unknown; previous?: { date?: string; value?: unknown } };
    return item(`${i.title}: ${d.value}${d.range ? ` (range ${d.range})` : ''}${d.flag ? `, ${d.flag}` : ''}`, `${i.date}${i.source ? `, ${i.source}` : ''}${d.previous ? `; previous ${d.previous.value} on ${d.previous.date}` : ''}`);
  });
  return build(`GA: ${items.length} new result${items.length === 1 ? '' : 's'}`, blocks, 'Reply with a question about it. Not medical advice.');
}

export function digestMessage(meds: ReviewItem[], due: Item[], labels: { drug: string; label: { status?: string; [k: string]: unknown } }[] = []): string {
  const n = meds.length + due.length;
  const blocks = [
    ...meds.map((m, k) => (k ? '' : 'New medications:\n') + item(`${m.title}${m.date ? ` (${m.date})` : ''}`)),
    ...due.map((i, k) => {
      const plan = i.doctorsPlan;
      return (k ? '' : 'Due:\n') + item(`${i.name} — ${i.status}${i.dueDate ? (i.status === 'overdue' ? ` since ${i.dueDate}` : `, due ${i.dueDate}`) : ''}`, i.why && `Why: ${i.why}`, plan && `Your doctor's plan: ${plan.quote ?? plan.status ?? plan.due ?? plan.topic}`);
    }),
  ];
  const fda = meds.some((m) => labels.some((l) => l.drug.toLowerCase() === m.title.toLowerCase() && (!l.label.status || l.label.status === 'ok')));
  return build(`GA: ${n} item${n === 1 ? '' : 's'} for you`, blocks, 'Reply "done" if you already had one, "not now", or ask a question. Not medical advice.', fda ? [FDA] : []);
}
