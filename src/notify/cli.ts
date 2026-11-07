// `ga notify setup|test|status|off|bridge`: settings, the LaunchAgent that runs the host-side iMessage bridge, and the test message.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, GaError } from '../config.ts';
import { writeAtomic } from '../smart/store.ts';
import { writeJson } from '../gateway/store.ts';
import { normalizeHandle } from './imessage.ts';
import { enqueue, pending } from './outbox.ts';
import { inSleep } from './select.ts';
import { notifyDir, readSettings, readState } from './settings.ts';

const LABEL = 'org.ga.notify-bridge';
const USAGE = 'usage: ga notify setup --to <phone or email> [--also <handle>]... [--digest HH:MM] [--sleep HH:MM-HH:MM] | ga notify test | ga notify status | ga notify off';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type NotifyDeps = { cfgPath?: string; plistDir?: string; uid?: number; launchctl?: (args: string[]) => Promise<boolean>; log?: (s: string) => void; now?: () => Date };

const realLaunchctl = (args: string[]): Promise<boolean> => new Promise((r) => execFile('launchctl', args, (e) => r(!e)));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function notifyCommand(args: string[], deps: NotifyDeps = {}): Promise<void> {
  const cfgPath = deps.cfgPath ?? defaultConfigPath(), dir = notifyDir(cfgPath);
  const log = deps.log ?? console.log, launchctl = deps.launchctl ?? realLaunchctl;
  const uid = deps.uid ?? process.getuid?.() ?? 501, domain = `gui/${uid}`;
  const plist = join(deps.plistDir ?? join(homedir(), 'Library', 'LaunchAgents'), `${LABEL}.plist`);
  const [cmd, ...rest] = args;

  if (cmd === 'setup') {
    const raw = rest.indexOf('--to') < 0 ? undefined : rest[rest.indexOf('--to') + 1];
    const opt = (k: string) => { const i = rest.indexOf(k); return i < 0 ? undefined : rest[i + 1]; };
    const valid = (v?: string) => v && /^(\+[\d\s\-().]{7,20}|[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+)$/.test(v) && (v.includes('@') || normalizeHandle(v).length >= 8) ? normalizeHandle(v) : undefined;
    const alsoRaw = rest.flatMap((a, i) => (a === '--also' ? [rest[i + 1]] : [])), also = alsoRaw.map(valid);
    const to = raw && /^(\+[\d\s\-().]{7,20}|[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+)$/.test(raw) ? normalizeHandle(raw) : undefined, digest = opt('--digest') ?? '09:00', sleep = (opt('--sleep') ?? '22:00-07:00').split('-');
    const known = rest.every((a, i) => a.startsWith('--') ? ['--to', '--also', '--digest', '--sleep'].includes(a) : i > 0 && rest[i - 1].startsWith('--'));
    if (to && !to.includes('@') && to.length < 8) throw new GaError(USAGE); // +, then at least 7 digits
    if (!to || !known || also.includes(undefined) || !HHMM.test(digest) || sleep.length !== 2 || !sleep.every((s) => HHMM.test(s))) throw new GaError(USAGE);
    if (inSleep(new Date(2000, 0, 1, ...(digest.split(':').map(Number) as [number, number])), sleep as [string, string])) throw new GaError('the digest time is inside the sleep window; choose another time or sleep hours');
    writeJson(dir, 'settings.json', { to, ...(also.length ? { also: also as string[] } : {}), digestAt: digest, sleep, setupAt: (deps.now?.() ?? new Date()).toISOString() });
    if (!existsSync(join(dir, 'token'))) writeAtomic(join(dir, 'token'), randomBytes(32).toString('hex'), 0o600);
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const env = `<key>GA_CONFIG</key><string>${esc(cfgPath)}</string>`;
    const argv = [process.execPath, join(repo, 'src', 'cli.ts'), 'notify', 'bridge'].map((a) => `<string>${esc(a)}</string>`).join('');
    mkdirSync(dirname(plist), { recursive: true });
    writeAtomic(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${argv}</array><key>WorkingDirectory</key><string>${esc(repo)}</string><key>EnvironmentVariables</key><dict>${env}</dict><key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${esc(join(dir, 'bridge.log'))}</string><key>StandardErrorPath</key><string>${esc(join(dir, 'bridge.log'))}</string></dict></plist>\n`);
    await launchctl(['bootout', `${domain}/${LABEL}`]); // reload when already installed
    if (!(await launchctl(['bootstrap', domain, plist]))) log(`launchctl bootstrap failed; run: launchctl bootstrap ${domain} ${plist}`);
    log(`GA will text ${to}; digest at ${digest}, quiet ${sleep.join('-')}.\nGrant these in System Settings > Privacy & Security for ${process.execPath}: Full Disk Access (to read replies) and Automation > Messages (to send).\nRestart GA's gateway to apply: docker compose restart ga-gateway\nThen run: ga notify test`);
  } else if (cmd === 'test' && !rest.length) {
    if (!readSettings(dir)) throw new GaError('run ga notify setup first');
    enqueue(dir, { id: `test-${Date.now()}`, text: 'GA: test message. Reply anything to check replies.', kind: 'reply', keys: [] });
    log('test message queued; the bridge sends it within seconds');
  } else if (cmd === 'status' && !rest.length) {
    const s = readSettings(dir);
    if (!s) return log('notify is not set up: ga notify setup --to <handle>');
    const st = readState(dir), running = await launchctl(['print', `${domain}/${LABEL}`]);
    log([`to: ${s.to}${s.off ? ' (off)' : ''}`, ...(s.also?.length ? [`also (owner handles): ${s.also.join(', ')}`] : []), `digest: ${s.digestAt}`, `sleep: ${s.sleep.join('-')}`, `last send: ${st.lastSend ?? 'never'}`, `last error: ${st.lastError ?? 'none'}`, `outbox: ${pending(dir).length}`, `bridge running: ${running ? 'yes' : 'no'}`].join('\n'));
  } else if (cmd === 'off' && !rest.length) {
    const s = readSettings(dir);
    if (s) writeJson(dir, 'settings.json', { ...s, off: true });
    await launchctl(['bootout', `${domain}/${LABEL}`]);
    rmSync(plist, { force: true });
    log("notify is off. Restart GA's gateway to apply: docker compose restart ga-gateway");
  } else if (cmd === 'bridge' && !rest.length) {
    const s = readSettings(dir);
    if (!s || s.off) throw new GaError('notify is not set up or is off');
    const { bridge } = await import('./imessage.ts');
    await bridge({ url: 'http://127.0.0.1:8110', token: readFileSync(join(dir, 'token'), 'utf8').trim(), dbPath: join(homedir(), 'Library', 'Messages', 'chat.db'), owner: s.to, also: s.also, every: 5000, dir });
  } else throw new GaError(USAGE);
}
