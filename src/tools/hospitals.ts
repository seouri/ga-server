// Hospital (Epic SMART) tools for chat apps (remote servers only). The login itself finishes at the gateway's /callback (completeLogin).
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GaError } from '../config.ts';
import { preview, takeConfirmed } from '../confirm.ts';
import { fail, text, type ToolDeps } from '../mcp.ts';
import { checkTypes, disconnectSource, enableTypes } from '../smart/actions.ts';
import { startLogin } from '../smart/auth.ts';
import type { LoginResult } from '../smart/auth.ts';
import { deleteSecret, loadSecret, readApp, readSources, smartDir } from '../smart/store.ts';
import { readStatus, syncAll, syncSource } from '../smart/sync.ts';

const fns = { startLogin, readStatus, syncAll, syncSource };
type Pending = { fhirBase: string; expires: number };

// Pending logins are encrypted files in tokens/: pending-<hash> (waiting) and result-<hash> (finished or failed).
function logins(dir: string, now = new Date()) {
  const t = join(dir, 'tokens');
  const files = existsSync(t) ? readdirSync(t) : [];
  const names = (prefix: string) => files.filter((f) => f.startsWith(prefix) && f.endsWith('.enc')).map((f) => f.slice(0, -4));
  const out: { name: string; id: string; fhirBase: string; status: string; fetched?: Record<string, number>; sourceKey?: string }[] = [];
  for (const name of names('pending-')) {
    const p = loadSecret<Pending>(dir, name);
    if (!p) continue;
    if (p.expires < now.getTime()) deleteSecret(dir, name);
    else out.push({ name, id: name.slice(8), fhirBase: p.fhirBase, status: 'waiting' });
  }
  for (const name of names('result-')) {
    const r = loadSecret<LoginResult>(dir, name);
    if (!r) continue;
    const id = name.slice(7);
    if ('error' in r) out.push({ name, id, fhirBase: r.fhirBase, status: `failed: ${r.error}` });
    else out.push({ name, id, fhirBase: r.source.fhirBase, status: 'finished', fetched: r.result.fetched, sourceKey: r.source.key });
  }
  return out;
}

export function registerHospitalTools(server: McpServer, deps: ToolDeps, dir = smartDir(), f: Partial<typeof fns> = {}): void {
  const { client, patientId, remote } = deps;
  if (!remote) throw new GaError('hospital tools need a remote server');
  const { startLogin: start, readStatus: status, syncAll: all, syncSource: sync } = { ...fns, ...f };
  const find = (key: string) => {
    const s = readSources(dir).find((x) => x.key === key || x.name === key);
    if (!s) throw new GaError(`unknown source: ${key} (see hospital_status)`);
    return s;
  };

  server.registerTool(
    'hospital_connect',
    {
      description:
        'Start connecting a hospital patient portal (Epic SMART). Returns a login link: give it to the user to open and log in, then call hospital_status ' +
        'to see when the login has finished and what the portal returned. Nothing is stored in the record until hospital_enable.',
      inputSchema: { fhirBase: z.string().url(), name: z.string().optional() },
      annotations: { openWorldHint: true },
    },
    async ({ fhirBase, name }: { fhirBase: string; name?: string }) => {
      try {
        const app = readApp(dir);
        if (!app.redirectUri?.startsWith('https://') || !app.clientId) {
          throw new GaError('hospital login from chat needs a client id and an https redirect URI: run ga connect <fhir-base-url> --client-id <id> --redirect-uri <https url> on the GA host');
        }
        const { url } = await start(dir, fhirBase, app.clientId, app.redirectUri, name);
        return text({ url, next: 'Give this link to the user to open and log in (valid 10 minutes), then call hospital_status.' });
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'hospital_status',
    {
      description: 'Hospital sources (status, last success, enabled types, stale) and pending logins: waiting, finished (with the counts per type the portal returned) or failed.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return text({
          sources: await status(client, patientId, dir),
          pendingLogins: logins(dir).map(({ id, fhirBase, status: s, fetched }) => ({ id, fhirBase, status: s, ...(fetched && { fetched }) })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'hospital_enable',
    {
      description:
        'Enable record types to sync from a source. Two steps: call without confirm to see what the portal returned for those types, show it to the user ' +
        '(enable only types that are new to GA or link to what it holds; a type GA already holds from Epic C-CDA/EHI likely duplicates), and only after they agree call again ' +
        'with the same arguments plus confirm. types: type names or "all".',
      inputSchema: { source: z.string(), types: z.union([z.literal('all'), z.array(z.string())]), confirm: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    async ({ source, types, confirm }: { source: string; types: string[] | 'all'; confirm?: string }) => {
      try {
        const src = find(source);
        const want = checkTypes(types);
        const args = { source: src.key, types: want };
        if (!confirm) {
          const done = logins(dir).find((l) => l.sourceKey === src.key && l.fetched);
          const fetched = done?.fetched ?? (await sync(client, dir, src, patientId, { dryRun: true })).fetched ?? {};
          return text({ source: src.key, types: want, fetched: Object.fromEntries(want.map((t) => [t, fetched[t] ?? 0])), ...preview('enable', structuredClone(args)) });
        }
        if (!isDeepStrictEqual(takeConfirmed<typeof args>('enable', confirm), args)) throw new GaError('arguments changed since the preview; ask for a new preview');
        const rec = enableTypes(dir, src.key, want);
        for (const l of logins(dir)) if (l.sourceKey === src.key) deleteSecret(dir, l.name); // its dry run is out of date now
        return text(await sync(client, dir, rec, patientId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'hospital_sync',
    { description: 'Sync one hospital source, or all of them, now.', inputSchema: { source: z.string().optional() }, annotations: { openWorldHint: true } },
    async ({ source }: { source?: string }) => {
      try {
        return text(source ? [await sync(client, dir, find(source), patientId)] : await all(client, dir, patientId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'hospital_disconnect',
    {
      description: 'Disconnect a hospital source: its tokens are deleted and it is marked off; records already fetched stay. Reconnect with hospital_connect.',
      inputSchema: { source: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ source }: { source: string }) => {
      try {
        const src = find(source);
        await disconnectSource(client, dir, src.key, patientId);
        return text({ source: src.key, status: 'disconnected' });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
