// Server-rendered share page. No scripts (CSP), so tabs, QR and Ask are plain links and a form. Every interpolated value goes through esc.
import QRCode from 'qrcode';
import type { Share } from './store.ts';
import type { Item, Row, Summary } from './summary.ts';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Opts = { base: string; tab?: 'summary' | 'records' | 'ask' | 'download'; page?: number; askEnabled: boolean; answer?: { q: string; a: string }; notice?: string };

const PAGE = 200;
const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#5f6368;--line:#d9dce1;--card:#f5f6f8;--acc:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8eaed;--mut:#9aa0a6;--line:#2e3238;--card:#1b1e23;--acc:#7ab4f5}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif;max-width:60rem;margin-inline:auto}
h1{font-size:1.15rem;margin:0 0 4px}h2{font-size:1.05rem;margin:24px 0 8px}a{color:var(--acc)}.mut{color:var(--mut);font-size:.9rem}
.btn{display:inline-block;padding:10px 14px;margin:0 8px 8px 0;border:1px solid var(--line);border-radius:8px;background:var(--card);text-decoration:none}
.tabs a{display:inline-block;padding:8px 12px;margin-right:4px;border-bottom:2px solid transparent}.tabs a.on{border-color:var(--acc);font-weight:600;text-decoration:none}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.note{color:var(--mut);font-size:.85rem}textarea{width:100%;box-sizing:border-box;min-height:5rem;font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px}
button{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.ans{background:var(--card);border-radius:8px;padding:10px 12px;margin:12px 0}`;

const doc = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date(iso).toLocaleDateString('en-CA')); // local zone, like expiry itself

function scopeWords(s: Share): string {
  const g = s.groups === 'all' ? 'all records' : s.groups.join(', ');
  return [g, s.since && `since ${s.since}`, s.until && `until ${s.until}`].filter(Boolean).join(' ');
}

function itemRow(i: Item, base: string): string {
  const m = /^DocumentReference\/(.+)$/.exec(i.ref);
  const label = m ? `<a href="${esc(base)}/doc/${esc(encodeURIComponent(m[1]!))}">${esc(i.label)}</a>` : esc(i.label);
  const meta = [i.date, i.source].filter(Boolean).join(' · ');
  return `<tr><td>${label}${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}</td><td>${esc(i.value)}</td><td>${esc(meta)}</td></tr>`;
}
const table = (items: Item[], base: string): string =>
  items.length ? `<table><thead><tr><th>Item</th><th>Value</th><th>Date · source</th></tr></thead><tbody>${items.map((i) => itemRow(i, base)).join('')}</tbody></table>` : '<p class="mut">None in this share.</p>';

function summaryHtml(sm: Summary, base: string, withLabs: boolean): string {
  const sec = (t: string, items: Item[]): string => `<h2>${esc(t)}</h2>${table(items, base)}`;
  return `<h2>Summary</h2>${sec('Problem list', sm.problems)}${sec('Current medications', sm.medications)}${sec('Allergies', sm.allergies)}${sec('Vaccinations', sm.immunizations)}${sec('Latest vitals', sm.vitals)}${sm.apple.length ? sec('Home readings (Apple Health)', sm.apple) : ''}${withLabs ? '' : sec('Latest results', sm.labs)}`;
}

const downloads = (base: string): string =>
  `<p><a class="btn" href="${esc(base)}/download/summary.pdf">Download PDF</a><a class="btn" href="${esc(base)}/download/records.json">Download FHIR (JSON)</a></p>`;

function askHtml(o: Opts): string {
  const out = `${o.notice ? `<p class="note">${esc(o.notice)}</p>` : ''}${o.answer ? `<p class="mut">You asked: ${esc(o.answer.q)}</p><div class="ans">${esc(o.answer.a).replace(/\r?\n/g, '<br>')}</div>` : ''}`;
  if (!o.askEnabled) return `<h2>Ask</h2><p class="mut">Questions are not set up for this link.</p>${out}`;
  return `<h2>Ask</h2><form method="post" action="${esc(o.base)}/ask"><textarea name="q" maxlength="2000" required aria-label="Your question"></textarea><p><button type="submit">Ask</button></p></form><p class="note">Answers come only from the shared records, via the owner's AI provider.</p>${out}`;
}

function recordsHtml(rows: Row[], o: Opts): string {
  const all = rows.flatMap((r) => r.items).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(o.page)) || 1));
  const slice = all.slice((page - 1) * PAGE, page * PAGE);
  const link = (n: number, t: string): string => `<a href="${esc(o.base)}?tab=records&amp;page=${n}">${t}</a>`;
  const nav = [page > 1 && link(page - 1, 'Previous'), page < pages && link(page + 1, `Next ${PAGE}`)].filter(Boolean).join(' ');
  return `<h2>All records</h2><p class="mut">${all.length} records, showing ${all.length ? (page - 1) * PAGE + 1 : 0}-${(page - 1) * PAGE + slice.length}</p>${table(slice, o.base)}${nav ? `<p>${nav}</p>` : ''}`;
}

export function renderPage(share: Share, summary: Summary, rows: Row[], opts: Opts): string {
  const exp = share.expires ? `expires ${day(share.expires)}` : 'no expiry';
  const head = `<h1>Shared by ${esc(summary.patient.name)} · for ${esc(share.label)} · ${esc(exp)}</h1><p class="mut">${esc(scopeWords(share))}</p><p><a class="btn" href="${esc(opts.base)}/qr">Show QR</a></p>`;
  let body: string;
  if (share.layout === 'A') {
    body = `${downloads(opts.base)}${summaryHtml(summary, opts.base, true)}<h2>Lab results</h2>${table(summary.labs, opts.base)}${askHtml(opts)}`;
  } else {
    const tab = opts.tab ?? 'summary';
    const t = (k: string, n: string): string => `<a href="${esc(opts.base)}?tab=${k}"${tab === k ? ' class="on"' : ''}>${n}</a>`;
    const inner = tab === 'records' ? recordsHtml(rows, opts) : tab === 'ask' ? askHtml(opts) : tab === 'download' ? `<h2>Download</h2>${downloads(opts.base)}` : summaryHtml(summary, opts.base, false);
    body = `<nav class="tabs">${t('summary', 'Summary')}${t('records', 'All records')}${t('ask', 'Ask')}${t('download', 'Download')}</nav>${inner}`;
  }
  return doc(`Shared record for ${summary.patient.name}`, head + body);
}

export const renderInactive = (): string => doc('Link not active', '<h1>This link is no longer active</h1>');

export async function renderQr(url: string): Promise<string> {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2 });
  return doc('QR code', `<h1>Scan to open</h1><div style="background:#fff;max-width:20rem">${svg}</div><p class="mut">${esc(url)}</p>`);
}
