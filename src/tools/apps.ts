// Connected-apps tools for chat apps (remote servers only): list the OAuth clients and disconnect one.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GaError } from '../config.ts';
import { gatewayDir } from '../gateway/store.ts';
import { listClients } from '../gateway/oauth.ts';
import { REMOTE_TAG } from '../gateway/remote-log.ts';
import { fail, text, type ToolDeps } from '../mcp.ts';

export function registerAppTools(server: McpServer, deps: ToolDeps): void {
  const { client, remote } = deps;
  if (!remote?.disconnect) throw new GaError('app tools need a remote server with disconnect');
  const dir = remote.dir ?? gatewayDir();

  server.registerTool(
    'connected_apps',
    {
      description:
        'The chat apps connected to GA: name, clientId, connected date and last use. Last use is per app name (the access log records the name, not the client), ' +
        'so two connections of the same app show the same last use.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const clients = listClients(dir);
        const last = new Map<string, string | null>();
        for (const { name } of clients) {
          if (last.has(name)) continue;
          const [e] = await client.searchResources('AuditEvent', { _tag: `${REMOTE_TAG}|${name}`, _sort: '-date', _count: '1' }, { cache: 'no-cache' });
          last.set(name, e?.recorded ?? null);
        }
        return text({ apps: clients.map((c) => ({ name: c.name, clientId: c.clientId, connected: c.created, lastUse: last.get(c.name) })) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'disconnect_app',
    {
      description: 'Disconnect a chat app by clientId (see connected_apps): its tokens stop working at once and it must be connected again. The app making this call may disconnect itself.',
      inputSchema: { clientId: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ clientId }) => {
      try {
        const app = listClients(dir).find((c) => c.clientId === clientId);
        if (!app) throw new GaError(`no connected app ${clientId} (see connected_apps)`);
        await remote.disconnect!(clientId);
        const self = app.name === remote.clientName;
        return text({ disconnected: app.name, clientId, ...(self && { note: `${app.name} is the app making this call: if it is this connection, it has lost access now` }) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
