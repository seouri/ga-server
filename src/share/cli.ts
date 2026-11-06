// ga share / shares / revoke: create, list and revoke share links, read their log, export offline, and run the share server.
// The server prints only its listen line: never tokens, record text or questions.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import type { MedplumClient } from '@medplum/core';
import QRCode from 'qrcode';
import { GaError, getClient, loadConfig } from '../config.ts';
import { writeAtomic } from '../smart/store.ts';
import { vaccineGaps } from '../vaccines.ts';
import { ask, offersVaccines } from './ask.ts';
import { logAccess, readLog } from './audit.ts';
import { recordRows, summarize, toBundle, toPdf } from './export.ts';
import { scopeWords } from './page.ts';
import { BINARY_URL, loadScoped, scopedCache } from './scope.ts';
import { createServer, downloadName } from './server.ts';
import { createShare, expiryWords, listShares, parseGroups, parseSince, revokeShare, shareDir, status, tokenOf } from './store.ts';
import type { Group, Share } from './store.ts';

const PORT = 8110;
const USAGE =
  'ga share [--for doctor|family] [--label X] [--scope g1,g2|all] [--since 12m|YYYY-MM-DD] [--until YYYY-MM-DD] [--expires 7d|YYYY-MM-DD|never] [--layout A|B] [--questions N]' +
  ' | ga shares [show <id>] | ga revoke <id> | ga share log [<id>] | ga share export <id> [--out dir] | ga share serve';
const CREATE = {
  for: { type: 'string' }, label: { type: 'string' }, scope: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
  expires: { type: 'string' }, layout: { type: 'string' }, questions: { type: 'string' },
} as const;
const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

function args(argv: string[], options: Record<string, { type: 'string' | 'boolean' }>) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch {
    throw new GaError(`usage: ${USAGE}`);
  }
}
const usage = (ok: boolean): void => {
  if (!ok) throw new GaError(`usage: ${USAGE}`);
};

// First tailscale binary that answers; undefined when none does. Read-only commands only.
async function tailscale(...a: string[]): Promise<string | undefined> {
  for (const bin of TAILSCALE) {
    const out = await new Promise<string | undefined>((ok) => execFile(bin, a, { timeout: 5000 }, (e, stdout) => ok(e ? undefined : stdout)));
    if (out !== undefined) return out;
  }
  return undefined;
}

async function baseUrl(): Promise<string> {
  if (process.env.GA_SHARE_URL) return process.env.GA_SHARE_URL.replace(/\/+$/, '');
  let name: string | undefined;
  try {
    name = (JSON.parse((await tailscale('status', '--json')) ?? '') as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '');
  } catch {} // not running or not JSON: the error below
  if (!name) throw new GaError('cannot find this machine\'s Tailscale name: start Tailscale, or set GA_SHARE_URL');
  return `https://${name}`;
}

// `tailscale funnel status` output (macOS app CLI): "No serve config" when nothing is served. When Funnel is on it lists
// "https://<machine>.<tailnet>.ts.net (Funnel on)" followed by a line like "|-- / proxy http://127.0.0.1:8110".
async function funnelHint(): Promise<void> {
  const out = (await tailscale('funnel', 'status')) ?? '';
  if (!/Funnel on/.test(out) || !/proxy http:\/\/(127\.0\.0\.1|localhost):8110\b/.test(out)) console.log('Links work after you run: tailscale funnel --bg 8110');
}


async function printLink(s: Share, token: string): Promise<void> {
  const url = `${s.baseUrl}/s/${token}`;
  console.log(url);
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`For: ${s.label} (${s.audience}). Shows: ${scopeWords(s)}. Expires: ${expiryWords(s)}.`);
}

const patientId = (): string => process.env.GA_PATIENT_ID || loadConfig().patientId; // GA_PATIENT_ID: tests only, as in smart/cli.ts

async function create(argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, CREATE);
  const v = values as Partial<Record<keyof typeof CREATE, string>>;
  usage(!positionals.length);
  const audience = v.for ?? 'doctor';
  if (audience !== 'doctor' && audience !== 'family') throw new GaError('--for must be doctor or family');
  if (v.layout !== undefined && v.layout !== 'A' && v.layout !== 'B') throw new GaError('--layout must be A or B');
  if (v.questions !== undefined && !/^\d+$/.test(v.questions)) throw new GaError('--questions must be a whole number');
  const now = new Date();
  const dir = shareDir();
  const { share, token } = createShare(dir, {
    audience,
    label: v.label ?? audience,
    ...(v.scope !== undefined && { groups: parseGroups(v.scope) }),
    ...(v.since !== undefined && { since: parseSince(v.since, now) }),
    ...(v.until !== undefined && { until: parseSince(v.until, now) }),
    ...(v.expires !== undefined && { expires: v.expires }),
    ...(v.layout !== undefined && { layout: v.layout }),
    ...(v.questions !== undefined && { questionsPerDay: Number(v.questions) }),
    patientId: patientId(),
    baseUrl: await baseUrl(),
  }, now);
  await printLink(share, token);
  if (!process.env.GA_SHARE_URL) await funnelHint();
}

function find(id: string | undefined): Share {
  usage(!!id);
  const s = listShares(shareDir()).find((x) => x.id === id);
  if (!s) throw new GaError(`no share ${id} (see ga shares)`);
  return s;
}

async function list(): Promise<void> {
  const shares = listShares(shareDir());
  if (!shares.length) return void console.log('no shares');
  const client = await getClient(loadConfig());
  const rows = [['id', 'label', 'audience', 'scope', 'expires', 'status', 'last access', 'accesses']];
  for (const s of shares) {
    const log = await readLog(client, s.id);
    rows.push([s.id, s.label, s.audience, scopeWords(s), expiryWords(s), status(s), log[0] ? new Date(log[0].at).toLocaleString() : 'never', String(log.length)]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd());
}

async function showLog(id: string | undefined): Promise<void> {
  if (id) find(id);
  const log = await readLog(await getClient(loadConfig()), id);
  if (!log.length) return void console.log('no accesses');
  for (const e of log) console.log([new Date(e.at).toLocaleString(), e.label, e.kind, e.detail, e.ip].filter(Boolean).join('  '));
}

async function exportShare(argv: string[]): Promise<void> {
  const { values, positionals } = args(argv, { out: { type: 'string' } });
  usage(positionals.length === 1);
  const s = find(positionals[0]);
  const scoped = await loadScoped(await getClient(loadConfig()), s);
  const out = (values.out as string | undefined) ?? process.cwd();
  const at = new Date();
  const [pdfFile, jsonFile] = (['health-summary.pdf', 'health-records-FHIR.json'] as const).map((f) => join(out, downloadName(scoped, f, at)));
  writeAtomic(pdfFile, await toPdf(summarize(scoped), recordRows(scoped), { label: s.label, created: s.created, scope: scopeWords(s) }), 0o600);
  writeAtomic(jsonFile, JSON.stringify(toBundle(scoped)), 0o600);
  console.log(`wrote ${pdfFile} and ${jsonFile}`);
}

// Downloads through the client's base URL, so it works in the container where Medplum's presigned localhost URLs do not.
export const binaryFetcher = (client: MedplumClient) => async (ref: string): Promise<{ data: Buffer; contentType: string }> => {
  const id = BINARY_URL.exec(ref)?.[1];
  if (!id) throw new GaError('not a Binary reference');
  const blob = await client.download(client.fhirUrl('Binary', id));
  return { data: Buffer.from(await blob.arrayBuffer()), contentType: blob.type };
};

async function serve(): Promise<void> {
  const client = await getClient(loadConfig());
  // Any OpenAI-compatible Chat Completions API: OpenAI, Gemini, OpenRouter, Anthropic, or a local Ollama (no key).
  const model = process.env.GA_LLM_MODEL;
  const llm = model ? new OpenAI({ baseURL: process.env.GA_LLM_BASE_URL || undefined, apiKey: process.env.GA_LLM_API_KEY || 'none' }) : undefined;
  const cached = scopedCache(loadScoped);
  const server = createServer({
    dir: shareDir(),
    load: (share) => cached(client, share),
    log: (share, e) => logAccess(client, share, e),
    fetchBinary: binaryFetcher(client),
    ...(llm && model && {
      ask: (q, s, share) => ask(q, s, share, { llm, model, ...(offersVaccines(share) && { vaccines: () => vaccineGaps(client, share.patientId) }) }),
    }),
  });
  // Loopback unless told otherwise: the container sets 0.0.0.0 and publishes the port on 127.0.0.1 only.
  const host = process.env.GA_SHARE_HOST || '127.0.0.1';
  await new Promise<void>((ok) => server.listen(PORT, host, ok));
  console.log(`ga-share listening on ${host}:${PORT}${llm ? ` (questions: ${model})` : ' (questions off: no GA_LLM_MODEL)'}`);
}

// Returns false when argv is not a share command.
export async function shareCommand(argv: string[]): Promise<boolean> {
  const [cmd, sub, ...rest] = argv;
  if (cmd === 'share') {
    if (sub === 'log') {
      usage(rest.length <= 1);
      await showLog(rest[0]);
    } else if (sub === 'export') await exportShare(rest);
    else if (sub === 'serve') {
      usage(!rest.length);
      await serve();
    } else await create(argv.slice(1));
  } else if (cmd === 'shares') {
    if (sub === 'show') {
      usage(rest.length === 1);
      const s = find(rest[0]);
      await printLink(s, tokenOf(shareDir(), s.id));
      if (status(s) !== 'active') console.log(`This share is ${status(s)}.`);
    } else {
      usage(sub === undefined);
      await list();
    }
  } else if (cmd === 'revoke') {
    usage(!!sub && !rest.length);
    find(sub);
    const s = revokeShare(shareDir(), sub!);
    console.log(`revoked ${s.id} (${s.label})`);
  } else return false;
  return true;
}
