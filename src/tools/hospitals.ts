// Hospital (Epic SMART) tools for chat apps (remote servers only). The login itself finishes at the gateway's /callback (completeLogin).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GaError } from '../config.ts';
import { CONFIRM_ON_PAGE, previewLink } from '../confirm.ts';
import { fail, text, type ToolDeps } from '../mcp.ts';
import { checkTypes, disconnectSource, enableTypes, listLogins } from '../smart/actions.ts';
import { startLogin } from '../smart/auth.ts';
import { deleteSecret, readApp, readSources, smartDir } from '../smart/store.ts';
import { readStatus, syncAll, syncSource } from '../smart/sync.ts';

const fns = { startLogin, readStatus, syncAll, syncSource };
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
      description: 'Hospital sources (status, last success, enabled types, stale; syncedTypes: the types of the last success, when a sync with the enabled ones has not succeeded yet) and pending logins: waiting, finished (with the counts per type the portal returned) or failed.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return text({
          sources: await status(client, patientId, dir),
          pendingLogins: listLogins(dir).map(({ id, fhirBase, status: s, fetched }) => ({ id, fhirBase, status: s, ...(fetched && { fetched }) })),
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
        `Enable record types to sync from a source. ${CONFIRM_ON_PAGE} The preview shows what the portal returned for those types ` +
        '(enable only types that are new to GA or link to what it holds; a type GA already holds from Epic C-CDA/EHI likely duplicates). ' +
        'Confirming enables them and syncs; then hospital_status shows the result. types: type names or "all".',
      inputSchema: { source: z.string(), types: z.union([z.literal('all'), z.array(z.string())]) },
      annotations: { destructiveHint: true },
    },
    async ({ source, types }: { source: string; types: string[] | 'all' }) => {
      try {
        const src = find(source);
        const want = checkTypes(types);
        const done = listLogins(dir).find((l) => l.sourceKey === src.key && l.fetched);
        const fetched = done?.fetched ?? (await sync(client, dir, src, patientId, { dryRun: true })).fetched ?? {};
        const view = { source: src.key, types: want, fetched: Object.fromEntries(want.map((t) => [t, fetched[t] ?? 0])) };
        const run = async () => {
          const rec = enableTypes(dir, src.key, want);
          for (const l of listLogins(dir)) if (l.sourceKey === src.key) deleteSecret(dir, l.name); // its dry run is out of date now
          const r = await sync(client, dir, rec, patientId);
          return { done: `Enabled ${want.join(', ')} for ${src.key}. Sync: ${r.status}${r.error ? ` (${r.error})` : ''}.` };
        };
        return text({ ...view, ...previewLink(remote.publicUrl, { title: 'Enable hospital record types', view, run }) });
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
