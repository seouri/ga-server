import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { decodeBody, readSince, sendText } from '../src/notify/imessage.ts';

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
    db.exec('create table handle (ROWID integer primary key, id text); create table message (ROWID integer primary key, text text, attributedBody blob, is_from_me integer, handle_id integer, date integer)');
    db.prepare('insert into handle values (1, ?), (2, ?)').run('+15551230000', '+15559999999');
    const ins = db.prepare('insert into message values (?, ?, ?, ?, ?, ?)');
    const d = 700_000_000_000_000_000n; // ns since 2001
    ins.run(1, 'old', null, 0, 1, d);
    ins.run(2, 'GA: digest', null, 1, 1, d); // GA's own send, echoed
    ins.run(3, 'reply plain', null, 0, 1, d);
    ins.run(4, null, blob('reply blob'), 0, 1, d);
    ins.run(5, 'stranger', null, 0, 2, d);
    ins.run(6, 'typed on this mac', null, 1, 1, d); // owner's own message in self chat
    db.close();
    const rows = readSince(p, 1, '+15551230000', ['GA: digest']);
    expect(rows.map((r) => [r.rowId, r.text, r.from])).toEqual([[3, 'reply plain', '+15551230000'], [4, 'reply blob', '+15551230000'], [6, 'typed on this mac', '+15551230000']]);
    expect(rows[0].at).toBe(new Date(Date.UTC(2001, 0, 1) + 700_000_000_000).toISOString());
  });
});
