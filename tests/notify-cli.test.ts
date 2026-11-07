import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notifyCommand } from '../src/notify/cli.ts';
import { pending } from '../src/notify/outbox.ts';
import { readSettings, writeState } from '../src/notify/settings.ts';

const setupEnv = () => {
  const root = mkdtempSync(join(tmpdir(), 'ganotify-'));
  const calls: string[][] = [];
  const out: string[] = [];
  const deps = { cfgPath: join(root, '.ga', 'config.json'), plistDir: join(root, 'LaunchAgents'), uid: 501, launchctl: async (a: string[]) => { calls.push(a); return true; }, log: (s: string) => out.push(s), now: () => new Date('2026-11-07T10:00:00Z') };
  return { root, calls, out, deps, dir: join(root, '.ga', 'notify'), plist: join(root, 'LaunchAgents', 'org.ga.notify-bridge.plist') };
};

describe('ga notify', () => {
  it('setup stores repeated --also normalized and rejects an invalid one', async () => {
    const e = setupEnv();
    await notifyCommand(['setup', '--to', '+15551230000', '--also', 'Owner@Example.com', '--also', '+1 (555) 123-4567'], e.deps);
    expect(readSettings(e.dir)).toMatchObject({ to: '+15551230000', also: ['owner@example.com', '+15551234567'] });
    await expect(notifyCommand(['setup', '--to', '+15551230000', '--also', 'nope'], setupEnv().deps)).rejects.toThrow(/usage/);
  });

  it('setup writes settings, 0600 token, plist, bootstraps', async () => {
    const e = setupEnv();
    await notifyCommand(['setup', '--to', '+1 (555) 123-0000', '--digest', '08:30', '--sleep', '22:00-07:00'], e.deps);
    expect(readSettings(e.dir)).toMatchObject({ to: '+15551230000', digestAt: '08:30', sleep: ['22:00', '07:00'], setupAt: '2026-11-07T10:00:00.000Z' });
    expect(statSync(join(e.dir, 'token')).mode & 0o777).toBe(0o600);
    const plist = readFileSync(e.plist, 'utf8');
    expect(plist).toContain(process.execPath);
    expect(plist).toMatch(/src\/cli\.ts/);
    expect(plist).toContain(e.deps.cfgPath);
    expect(plist).toContain('KeepAlive');
    expect(e.calls.some((c) => c[0] === 'bootstrap' && c[1] === 'gui/501')).toBe(true);
    expect(e.out.join('\n')).toMatch(/Full Disk Access/);
    expect(e.out.join('\n')).toContain('docker compose restart ga-gateway');
    const t = readFileSync(join(e.dir, 'token'), 'utf8');
    await notifyCommand(['setup', '--to', '+15551230000'], e.deps);
    expect(readFileSync(join(e.dir, 'token'), 'utf8')).toBe(t);
  });

  it('digest defaults to 09:00', async () => {
    const e = setupEnv();
    await notifyCommand(['setup', '--to', '+15551230000'], e.deps);
    expect(readSettings(e.dir)?.digestAt).toBe('09:00');
  });

  it('rejects a phone with under 7 digits and a digest inside the sleep window', async () => {
    const e = setupEnv();
    await expect(notifyCommand(['setup', '--to', '+-------'], e.deps)).rejects.toThrow(/usage/);
    await expect(notifyCommand(['setup', '--to', '+15551230000', '--digest', '23:00'], e.deps)).rejects.toThrow(/sleep/);
  });

  it('rejects bad args', async () => {
    const e = setupEnv();
    await expect(notifyCommand(['setup'], e.deps)).rejects.toThrow(/usage/);
    await expect(notifyCommand(['setup', '--to', '--digest'], e.deps)).rejects.toThrow(/usage/);
    await expect(notifyCommand(['setup', '--to', '5551230000'], e.deps)).rejects.toThrow(/usage/);
    await expect(notifyCommand(['setup', '--to', '+15551230000', '--digest', '9am'], e.deps)).rejects.toThrow(/usage/);
  });

  it('test enqueues, status prints last error and bridge state, off removes plist', async () => {
    const e = setupEnv();
    await notifyCommand(['setup', '--to', 'A@B.co'], e.deps);
    await notifyCommand(['test'], e.deps);
    expect(pending(e.dir)[0].text).toBe('GA: test message. Reply anything to check replies.');
    writeState(e.dir, { sentResults: {}, sentTopics: {}, lastError: 'boom' });
    e.out.length = 0;
    await notifyCommand(['status'], e.deps);
    const s = e.out.join('\n');
    expect(s).toContain('a@b.co');
    expect(s).toContain('boom');
    expect(s).toMatch(/outbox: 1/);
    expect(s).toMatch(/bridge running: yes/);
    await notifyCommand(['off'], e.deps);
    expect(existsSync(e.plist)).toBe(false);
    expect(readSettings(e.dir)?.off).toBe(true);
    expect(e.calls.some((c) => c[0] === 'bootout')).toBe(true);
  });
});
