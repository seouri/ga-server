import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { decodeBody, normalizeHandle, readSince, round, sendText, textHash } from '../src/notify/imessage.ts';

// Synthetic typedstream: ...NSString, 0x01 '+', length, utf8.
const blob = (t: string) => {
  const b = Buffer.from(t, 'utf8');
  const len = b.length < 0x80 ? Buffer.from([b.length]) : Buffer.from([0x81, b.length & 255, b.length >> 8]);
  return Buffer.concat([Buffer.from('streamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+', 'latin1'), len, b, Buffer.from([0x86, 0x84])]);
};

describe('sendText', () => {
  it('passes text as an argument', async () => {
    const calls: string[][] = [];
    const text = 'say "hi"\nit\'s \\ok';
    await sendText('+15551230000', text, async (a) => { calls.push(a); });
    const a = calls[0];
    expect(a.slice(-2)).toEqual(['+15551230000', text]);
    expect(a[0]).toBe('-e');
    expect(a.slice(0, -2).join('\n')).not.toContain('say');
  });
});

describe('decodeBody', () => {
  it('decodes short and long (0x81) lengths', () => {
    expect(decodeBody(blob('hello é'))).toBe('hello é');
    const long = 'x'.repeat(300);
    expect(decodeBody(blob(long))).toBe(long);
    expect(decodeBody(Buffer.from('nothing'))).toBeUndefined();
  });
});

describe('readSince', () => {
  it('returns the owner reply, not GA echo, not other handles; decodes attributedBody', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'chat-')), 'chat.db');
    const db = new DatabaseSync(p);
    db.exec('create table handle (ROWID integer primary key, id text); create table message (ROWID integer primary key, text text, attributedBody blob, is_from_me integer, handle_id integer, date integer, associated_message_type integer default 0)');
    db.prepare('insert into handle values (1, ?), (2, ?)').run('+15551230000', '+15559999999');
    const ins = db.prepare('insert into message (ROWID, text, attributedBody, is_from_me, handle_id, date) values (?, ?, ?, ?, ?, ?)');
    const d = 700_000_000_000_000_000n; // ns since 2001
    ins.run(1, 'old', null, 0, 1, d);
    ins.run(2, 'GA: digest', null, 1, 1, d); // GA's own send, echoed
    ins.run(3, 'reply plain', null, 0, 1, d);
    ins.run(4, null, blob('reply blob'), 0, 1, d);
    ins.run(5, 'stranger', null, 0, 2, d);
    ins.run(6, 'typed on this mac', null, 1, 1, d); // owner's own message in self chat
    db.close();
    const { rows, scanned } = readSince(p, 1, '+1 (555) 123-0000', [textHash('GA: digest')]);
    expect(scanned).toBe(6);
    expect(rows.map((r) => [r.rowId, r.text, r.from])).toEqual([[3, 'reply plain', '+15551230000'], [4, 'reply blob', '+15551230000'], [6, 'typed on this mac', '+15551230000']]);
    expect(rows[0].at).toBe(new Date(Date.UTC(2001, 0, 1) + 700_000_000_000).toISOString());
  });
});

describe('readSince reactions', () => {
  it('skips a tapback from the owner but still advances past it', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'chat-')), 'chat.db');
    const db = new DatabaseSync(p);
    db.exec('create table handle (ROWID integer primary key, id text); create table message (ROWID integer primary key, text text, attributedBody blob, is_from_me integer, handle_id integer, date integer, associated_message_type integer default 0)');
    db.prepare('insert into handle values (1, ?)').run('+15551230000');
    db.prepare('insert into message values (1, ?, null, 0, 1, 0, 2000)').run('Loved "GA: digest"');
    db.close();
    expect(readSince(p, 0, '+15551230000')).toEqual({ rows: [], scanned: 1 });
  });
});

describe('readSince with also handles', () => {
  it('takes is_from_me rows on an also handle, skips GA phone-handle send and other handles', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'chat-')), 'chat.db');
    const db = new DatabaseSync(p);
    db.exec('create table handle (ROWID integer primary key, id text); create table message (ROWID integer primary key, text text, attributedBody blob, is_from_me integer, handle_id integer, date integer, associated_message_type integer default 0)');
    db.prepare('insert into handle values (1, ?), (2, ?), (3, ?)').run('+15551230000', 'Owner@Example.com', 'other@example.com');
    const ins = db.prepare('insert into message (ROWID, text, attributedBody, is_from_me, handle_id, date) values (?, ?, ?, ?, ?, ?)');
    const d = 700_000_000_000_000_000n;
    ins.run(1, null, blob('GA: digest'), 1, 1, d); // GA's own send to the phone handle
    ins.run(2, 'iphone reply', null, 1, 2, d); // owner's iPhone reply, email handle
    ins.run(3, 'nope', null, 1, 3, d);
    db.close();
    const { rows, scanned } = readSince(p, 0, ['+15551230000', 'owner@example.com'], [textHash('GA: digest')]);
    expect(scanned).toBe(3);
    expect(rows.map((r) => [r.rowId, r.text, r.from])).toEqual([[2, 'iphone reply', 'owner@example.com']]);
    expect(readSince(p, 0, '+15551230000').rows.map((r) => r.rowId)).toEqual([1]);
  });
});

describe('normalizeHandle', () => {
  it('phone to +digits, email lowercased', () => {
    expect(normalizeHandle('+1 (555) 123-0000')).toBe('+15551230000');
    expect(normalizeHandle('Me@Ex.COM')).toBe('me@ex.com');
  });
});

describe('round', () => {
  const OWNER = '+15551230000', T0 = 1_800_000_000_000;
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
    const p = join(dir, 'chat.db');
    const db = new DatabaseSync(p);
    db.exec('create table handle (ROWID integer primary key, id text); create table message (ROWID integer primary key, text text, attributedBody blob, is_from_me integer, handle_id integer, date integer, associated_message_type integer default 0)');
    db.prepare('insert into handle values (1, ?)').run(OWNER);
    const add = (id: number, text: string, me: number, date = 0n) => db.prepare('insert into message (ROWID, text, attributedBody, is_from_me, handle_id, date) values (?, ?, null, ?, 1, ?)').run(id, text, me, date);
    const bodies: { incoming: unknown[]; sent: string[]; failed: unknown[] }[] = [];
    let outgoing: { id: string; text: string }[] = [];
    const fetch = (async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); const o = outgoing; outgoing = []; return { ok: true, json: async () => ({ outgoing: o }) }; }) as unknown as typeof globalThis.fetch;
    const deps = (now: number, send = async () => {}) => ({ url: 'http://x', token: 't', dbPath: p, owner: OWNER, every: 1, dir, send, fetch, now: () => now });
    const state = () => JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8'));
    return { dir, add, bodies, deps, state, setOut: (o: typeof outgoing) => { outgoing = o; } };
  };

  it('a skipped echo is not re-read after the recent window', async () => {
    const e = setup();
    await round(e.deps(T0), () => {}); // first run: starts at max rowid 0
    writeFileSync(join(e.dir, 'bridge.json'), JSON.stringify({ ...e.state(), recent: [{ h: textHash('GA: digest'), at: T0 }] }));
    e.add(1, 'GA: digest', 1);
    await round(e.deps(T0 + 60_000), () => {}); // inside window: skipped, lastRowId advances
    expect(e.state().lastRowId).toBe(1);
    await round(e.deps(T0 + 11 * 60_000), () => {});
    expect(e.bodies.map((b) => b.incoming.length)).toEqual([0, 0, 0]);
  });

  it('a crash mid-sends resumes without resending or replaying; acks carry over', async () => {
    const e = setup();
    await round(e.deps(T0), () => {});
    e.add(1, 'reply', 0);
    e.setOut([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]);
    let n = 0, mid: { sent: string[]; lastRowId: number } | undefined;
    await round(e.deps(T0 + 1000, async () => { if (++n === 2) { mid = e.state(); throw new Error('osascript exit 1 +1555 secret'); } }), () => {});
    expect(mid).toMatchObject({ sent: ['a'], lastRowId: 1 }); // persisted before the second send
    await round(e.deps(T0 + 6000), () => {});
    const b = e.bodies[2];
    expect(b.incoming).toEqual([]);
    expect(b.sent).toEqual(['a']);
    expect(b.failed).toEqual([{ id: 'b', error: 'send failed' }]);
    expect(e.bodies[1].incoming).toHaveLength(1);
  });

  it("the owner's text is taken once though its received copy comes a day after the sent copy", async () => {
    const e = setup();
    await round(e.deps(T0), () => {});
    e.add(1, 'when is my next shot?', 1, 815943109526000000n); // sent copy: send time, ms precision
    await round(e.deps(T0 + 1000), () => {});
    e.add(2, 'when is my next shot?', 0, 815943109526938624n); // received copy, same send time
    e.add(3, 'when is my next shot?', 1, 815943209526000000n); // the same words sent again later: a new text
    await round(e.deps(T0 + 24 * 3600_000), () => {});
    expect(e.bodies.map((b) => b.incoming.length)).toEqual([0, 1, 1]);
    expect(JSON.stringify(e.state())).not.toContain('next shot'); // hashes only on disk
  });

  it("GA's send echoed back a day later is not taken for the owner's text", async () => {
    const e = setup();
    await round(e.deps(T0), () => {});
    e.setOut([{ id: 'a', text: 'GA: answer' }]);
    await round(e.deps(T0 + 1000), () => {});
    e.add(1, 'GA: answer', 0); // Messages in iCloud delivered the received copy ~24 h late
    await round(e.deps(T0 + 25 * 3600_000), () => {});
    expect(e.bodies[2].incoming).toEqual([]);
    expect(JSON.stringify(e.state())).not.toContain('GA: answer'); // hashes only on disk
  });

  it('an is_from_me=0 row equal to a recent GA send is skipped', async () => {
    const e = setup();
    await round(e.deps(T0), () => {});
    writeFileSync(join(e.dir, 'bridge.json'), JSON.stringify({ ...e.state(), recent: [{ h: textHash('GA: digest'), at: T0 }] }));
    e.add(1, 'GA: digest', 0);
    await round(e.deps(T0 + 1000), () => {});
    expect(e.bodies[1].incoming).toEqual([]);
  });

  it('a failed send retries after 1, 5, then 30 minutes and logs once per attempt', async () => {
    const e = setup();
    const logs: string[] = [];
    await round(e.deps(T0), () => {});
    let sends = 0;
    const bad = async () => { sends++; throw new Error('osascript exit 1'); };
    e.setOut([{ id: 'a', text: 'A' }]);
    await round(e.deps(T0 + 1000, bad), (s) => logs.push(s));
    const again = () => e.setOut([{ id: 'a', text: 'A' }]); // the gateway keeps offering it
    for (const [dt, want] of [[30_000, 1], [61_000, 2], [3 * 60_000, 2], [6 * 60_000 + 2000, 3], [20 * 60_000, 3], [37 * 60_000, 4]] as const) {
      again(); await round(e.deps(T0 + dt, bad), (s) => logs.push(s)); expect(sends).toBe(want);
    }
    expect(logs.filter((l) => /failed 1/.test(l))).toHaveLength(4);
  });

  it('without a readable Messages database it still exchanges and sends; the hint is logged once per 10 minutes', async () => {
    const e = setup();
    const logs: string[] = [];
    const deps = (now: number) => ({ ...e.deps(now), dbPath: join(e.dir, 'missing', 'chat.db') });
    e.setOut([{ id: 'a', text: 'A' }]);
    const sent: string[] = [];
    await round({ ...deps(T0), send: async (_t: string, x: string) => { sent.push(x); } }, (s) => logs.push(s));
    expect(sent).toEqual(['A']);
    expect(e.bodies[0].incoming).toEqual([]);
    await round(deps(T0 + 5000), (s) => logs.push(s));
    await round(deps(T0 + 5 * 60_000), (s) => logs.push(s));
    expect(logs.filter((l) => /Full Disk Access/.test(l))).toHaveLength(1);
    await round(deps(T0 + 11 * 60_000), (s) => logs.push(s));
    expect(logs.filter((l) => /Full Disk Access/.test(l))).toHaveLength(2);
    expect(e.bodies).toHaveLength(4);
  });
});
