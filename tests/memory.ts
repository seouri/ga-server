// Runs a command and reports its peak resident memory, sampled every 200 ms from /proc (Linux) or `ps -o rss=` (macOS).
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

function rssKiB(pid: number): number {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    if (m) return Number(m[1]);
  } catch { /* no /proc: fall through to ps */ }
  try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0; } catch { return 0; }
}

export function peakRss(cmd: string[], env: Record<string, string>): Promise<{ peakMiB: number; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd[0], cmd.slice(1), { env: { PATH: process.env.PATH!, ...env } });
    let peak = 0, stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    const t = setInterval(() => { peak = Math.max(peak, rssKiB(c.pid!)); }, 200);
    c.on('close', (code) => { clearInterval(t); resolve({ peakMiB: Math.round(peak / 1024), exitCode: code ?? -1, stdout, stderr }); });
  });
}
