// The iMessage bridge: runs on the host (launchd), reads ~/Library/Messages/chat.db, sends through osascript, talks to the gateway's /notify/exchange.
// Logs hold counts, ids and errors only; never message text or handles.
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJson, writeJson } from '../gateway/store.ts';

const SCRIPT = ['-e', 'on run argv', '-e', 'tell application "Messages" to send (item 2 of argv) to participant (item 1 of argv) of (1st account whose service type = iMessage)', '-e', 'end run'];

// Errors are fixed strings: execFile's own message contains argv (the handle and the text).
const osascript = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
  execFile('osascript', args, { timeout: 60_000 }, (e) => (e ? reject(new Error((e as { killed?: boolean }).killed ? 'timeout' : `osascript exit ${(e as { code?: unknown }).code}`)) : resolve())); // timeout (Automation prompt) is a failed send
});

// Phone: +digits; email: lowercased. Applied to the setup value and to chat.db handles before comparing.
export const normalizeHandle = (h: string): string => (h.includes('@') ? h.trim().toLowerCase() : `+${h.replace(/\D/g, '')}`);

export const sendText = (to: string, text: string, run: (args: string[]) => Promise<void> = osascript): Promise<void> => run([...SCRIPT, to, text]);

// attributedBody is a typedstream: after "NSString" comes 0x01 '+', a length (1 byte, or 0x81 + 2 bytes LE), then UTF-8.
// shortcut: lengths above 65535 (0x82...) are not decoded, fine for texts.
export function decodeBody(b: Buffer): string | undefined {
  const ns = b.indexOf('NSString');
  if (ns < 0) return undefined;
  const m = b.indexOf(Buffer.from([0x01, 0x2b]), ns);
  if (m < 0) return undefined;
  let i = m + 2, len = b[i++];
  if (len === 0x81) { len = b.readUInt16LE(i); i += 2; } else if (len > 0x81) return undefined;
  return i + len <= b.length ? b.subarray(i, i + len).toString('utf8') : undefined;
}

type Row = { rowId: number; from: string; text: string; at: string };

// Owner's replies: any row unless its text is one GA just sent. is_from_me=1 counts as an owner text only in self-message mode
// (owner's Apple ID on this Mac), pending the spike. Other handles are skipped. `scanned` is the highest ROWID looked at, skipped rows included.
export function readSince(dbPath: string, afterRowId: number, owner: string, recent: string[] = []): { rows: Row[]; scanned: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const st = db.prepare('select h.id hid, m.ROWID r, m.text t, m.attributedBody b, m.is_from_me me, m.date d from message m join handle h on h.ROWID = m.handle_id where m.ROWID > ? order by m.ROWID');
    st.setReadBigInts(true); // ns dates exceed 2^53
    const rows = st.all(afterRowId) as { hid: string; r: bigint; t: string | null; b: Uint8Array | null; me: bigint; d: bigint }[];
    const out: Row[] = [], me = normalizeHandle(owner);
    let scanned = afterRowId;
    for (const x of rows) {
      scanned = Math.max(scanned, Number(x.r));
      if (normalizeHandle(x.hid) !== me) continue;
      const text = x.t ?? (x.b ? decodeBody(Buffer.from(x.b)) : undefined);
      if (!text || recent.includes(text)) continue; // GA's own sends can come back either way
      const d = Number(x.d), ms = Math.abs(d) > 1e12 ? d / 1e6 : d * 1e3; // ns on recent macOS, seconds before
      out.push({ rowId: Number(x.r), from: me, text, at: new Date(Date.UTC(2001, 0, 1) + ms).toISOString() });
    }
    return { rows: out, scanned };
  } finally { db.close(); }
}

type Bridge = { lastRowId?: number; recent: { text: string; at: number }[]; sent: string[]; failed: { id: string; error: string }[]; retry?: Record<string, { n: number; next: number }> };
const BACKOFF = [1, 5, 30].map((m) => m * 60_000); // a failed id is retried after 1, 5, then 30 minutes
export type BridgeDeps = { url: string; token: string; dbPath: string; owner: string; every: number; dir: string; send?: typeof sendText; fetch?: typeof fetch; now?: () => number };

const maxRowId = (dbPath: string): number => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return (db.prepare('select coalesce(max(ROWID), 0) m from message').get() as { m: number }).m; } finally { db.close(); }
};

// One round: read new owner rows, exchange with the gateway, send what comes back. Returns false when the gateway could not be reached.
export async function round(d: BridgeDeps, log: (s: string) => void): Promise<boolean> {
  const now = (d.now ?? Date.now)(), send = d.send ?? sendText;
  const st = readJson<Bridge>(d.dir, 'bridge.json', { recent: [], sent: [], failed: [] });
  st.recent = st.recent.filter((r) => now - r.at < 10 * 60_000);
  let incoming: Row[] = [], scanned = 0;
  try {
    if (st.lastRowId === undefined) { st.lastRowId = maxRowId(d.dbPath); writeJson(d.dir, 'bridge.json', st); } // first run: do not replay history
    else {
      const r = readSince(d.dbPath, st.lastRowId, d.owner, st.recent.map((x) => x.text));
      incoming = r.rows; scanned = r.scanned;
    }
  } catch (e) { log(`cannot read Messages database: ${(e as Error).message}; grant Full Disk Access to node (System Settings > Privacy & Security)`); }
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${d.url}/notify/exchange`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ incoming: incoming.map(({ from, text, at }) => ({ from, text, at })), sent: st.sent, failed: st.failed }) });
  } catch (e) { log(`gateway unreachable: ${(e as Error).message}`); return false; }
  if (!res.ok) { log(`gateway answered ${res.status}`); return false; }
  const { outgoing = [] } = (await res.json()) as { outgoing?: { id: string; text: string }[] };
  // Persist before any send, and after each, so a crash neither re-sends nor replays.
  if (scanned > (st.lastRowId ?? 0)) st.lastRowId = scanned;
  st.sent = []; st.failed = [];
  writeJson(d.dir, 'bridge.json', st);
  const retry = st.retry ?? {};
  let tried = 0;
  for (const o of outgoing) {
    if (retry[o.id] && now < retry[o.id].next) continue; // waiting out its backoff
    tried++;
    try { await send(d.owner, o.text); st.sent.push(o.id); delete retry[o.id]; st.recent.push({ text: o.text, at: (d.now ?? Date.now)() }); } catch (e) {
      const m = (e as Error).message, n = (retry[o.id]?.n ?? 0) + 1;
      retry[o.id] = { n, next: now + BACKOFF[Math.min(n, BACKOFF.length) - 1] };
      st.failed.push({ id: o.id, error: /^(timeout|osascript exit \S+)$/.test(m) ? m : 'send failed' });
    }
    st.retry = retry;
    writeJson(d.dir, 'bridge.json', st);
  }
  if (incoming.length || tried) log(`in ${incoming.length}, out ${tried}, failed ${st.failed.length}`);
  return true;
}

export async function bridge(d: BridgeDeps): Promise<void> {
  const log = (s: string) => appendFileSync(join(d.dir, 'bridge.log'), `${new Date().toISOString()} ${s}\n`);
  log('bridge started');
  for (;;) {
    try { await round(d, log); } catch (e) { log(`round failed: ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, d.every));
  }
}
