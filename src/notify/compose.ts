import type { Item } from '../maintenance.ts';
import type { ReviewItem } from '../whats-new.ts';

const MAX = 5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Mon D" in the current year, "Mon YYYY" otherwise; text that is not YYYY-MM-DD passes through.
function when(d: string | undefined, now: Date): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d ?? '');
  if (!m) return d ?? '';
  return +m[1] === now.getFullYear() ? `${MON[+m[2] - 1]} ${+m[3]}` : `${MON[+m[2] - 1]} ${m[1]}`;
}

// Whole lines only: at most MAX item lines, then "+N more"; headings only when their group has a shown line.
function build(head: string, groups: [string, string[]][], hint: string): string {
  let left = MAX;
  const body: string[] = [];
  for (const [h, lines] of groups) {
    const shown = lines.slice(0, left);
    left -= shown.length;
    if (shown.length) body.push(...(h ? [h] : []), ...shown);
  }
  const more = groups.reduce((n, [, l]) => n + l.length, 0) - (MAX - left);
  return [head, '', ...body, ...(more ? [`+${more} more`] : []), '', hint].join('\n');
}

export function resultMessage(items: ReviewItem[], now = new Date()): string {
  const lines = items.map((i) => {
    const d = i.detail as { value?: unknown; range?: unknown; flag?: unknown };
    const note = [d.flag, d.range ? `range ${d.range}` : ''].filter(Boolean).join('; ');
    return `• ${i.title}: ${d.value}${note ? ` (${note})` : ''}${i.date ? `, ${when(i.date, now)}` : ''}`;
  });
  return build(`GA: ${items.length} new result${items.length === 1 ? '' : 's'}`, [['', lines]], 'Reply a name for details. Not medical advice.');
}

export function digestMessage(meds: ReviewItem[], due: Item[], labels: { drug: string; label: { status?: string; [k: string]: unknown } }[] = [], now = new Date()): string {
  const n = meds.length + due.length;
  const hasLabel = (t: string) => labels.some((l) => l.drug.toLowerCase() === t.toLowerCase() && (!l.label.status || l.label.status === 'ok'));
  const medLines = meds.map((m) => `• ${m.title}: new${hasLabel(m.title) ? ' (FDA label notes)' : ''}`);
  const dueLines = due.map((i) => `• ${i.name}: ${i.status}${i.dueDate ? `${i.status === 'overdue' ? ' since' : ''} ${when(i.dueDate, now)}` : ''}${i.doctorsPlan ? " (doctor's plan)" : ''}`);
  return build(`GA: ${n} item${n === 1 ? '' : 's'} for you`, [['New medications:', medLines], ['Due:', dueLines]], 'Reply a name for why and sources. Not medical advice.');
}
