// A gateway stand-in for memory runs: loads the gateway's modules, runs one import_file job (startJob: a worker thread with the
// import limits) and prints, as JSON, its outcome and this process's resident memory in MiB, idle before the job and peak during
// it: rss, and on Linux anon (RssAnon: what the process allocated, without the node binary's mapped pages).
// argv: the upload (an export folder or zip), the EHI zone. GA_CONFIG names the store and patient. Used by tests/ehi-memory.test.ts
// and, inside node:26 alpine containers, for the Linux numbers in docs/superpowers/spikes/2026-11-09-import-memory.md.
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const linux = process.platform === 'linux';
const proc = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+) kB`).exec(readFileSync('/proc/self/status', 'utf8'))?.[1]) / 1024;
const rssMiB = () => process.memoryUsage().rss / 2 ** 20;
const anonMiB = () => (linux ? proc('RssAnon') : 0);
await import('../src/gateway/server.ts');
const { jobStatus, startJob } = await import('../src/import-jobs.ts');
const { loadConfig } = await import('../src/config.ts');
const [from, tz] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, 2000));
const idle = rssMiB();
const idleAnon = anonMiB();
const dir = mkdtempSync(join(tmpdir(), 'ga-mem-gw-'));
const up = join(dir, 'uploads', 'x', basename(from));
mkdirSync(join(up, '..'), { recursive: true });
cpSync(from, up, { recursive: true });
const t0 = Date.now();
const job = startJob(dir, up, { patientId: loadConfig().patientId, tz });
let peak = idle;
let peakAnon = idleAnon;
for (;;) {
  await new Promise((r) => setTimeout(r, 250));
  peak = Math.max(peak, rssMiB());
  peakAnon = Math.max(peakAnon, anonMiB());
  const j = jobStatus(dir, job.id);
  if (j?.status !== 'running') {
    const r = j?.report as { created?: number; skipped?: number; invalid?: number } | undefined;
    console.log(JSON.stringify({ status: j?.status, message: j?.message, created: r?.created, skipped: r?.skipped, invalid: r?.invalid, idle: Math.round(idle), peak: Math.round(peak), ...(linux && { idleAnon: Math.round(idleAnon), peakAnon: Math.round(peakAnon) }), seconds: Math.round((Date.now() - t0) / 1000) }));
    process.exit(0);
  }
}
