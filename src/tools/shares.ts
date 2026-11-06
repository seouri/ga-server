// Share tools for chat apps (remote servers only). Creating a share is two steps: preview, then confirm with the same arguments.
import { isDeepStrictEqual } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import QRCode from 'qrcode';
import { z } from 'zod';
import { GaError } from '../config.ts';
import { preview, takeConfirmed } from '../confirm.ts';
import { fail, text, type ToolDeps } from '../mcp.ts';
import { readLog } from '../share/audit.ts';
import { expiryWords, parseGroups, status } from '../share/cli.ts';
import { scopeWords } from '../share/page.ts';
import { createShare, listShares, parseExpiry, parseSince, revokeShare, shareDir } from '../share/store.ts';

const CREATE = {
  audience: z.enum(['doctor', 'family']),
  label: z.string(),
  scope: z.union([z.literal('all'), z.array(z.string())]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  expires: z.string().optional(),
  questionsPerDay: z.number().int().min(0).optional(),
  confirm: z.string().optional(),
};
type Args = { audience: 'doctor' | 'family'; label: string; scope?: string[] | 'all'; since?: string; until?: string; expires?: string; questionsPerDay?: number; confirm?: string };

export function registerShareTools(server: McpServer, deps: ToolDeps, dir = shareDir()): void {
  const { client, patientId, remote } = deps;
  if (!remote) throw new GaError('share tools need a remote server');
  const find = (id: string) => {
    const s = listShares(dir).find((x) => x.id === id);
    if (!s) throw new GaError(`no share ${id} (see share_list)`);
    return s;
  };

  server.registerTool(
    'share_create',
    {
      description:
        'Create a share link to the health record for a doctor or family member. Two steps: call without confirm to get a preview (audience, scope, dates, expiry) ' +
        'and a confirm code; show it to the user, and only after they agree call again with the same arguments plus confirm. scope: "all" or groups ' +
        'labs, vitals, medications, problems, allergies, immunizations, visits, notes, procedures, family, messages, apple. since/until: 12m, 2y or YYYY-MM-DD. ' +
        'expires: 7d, 12h, YYYY-MM-DD or never (doctor default 7d).',
      inputSchema: CREATE,
      annotations: { destructiveHint: true },
    },
    async (a: Args) => {
      try {
        const { confirm, ...rest } = a;
        const now = new Date();
        const groups = rest.scope === undefined ? undefined : parseGroups(Array.isArray(rest.scope) ? rest.scope.join(',') : rest.scope);
        const since = rest.since === undefined ? undefined : parseSince(rest.since, now);
        const until = rest.until === undefined ? undefined : parseSince(rest.until, now);
        const expires = rest.expires ?? (rest.audience === 'doctor' ? '7d' : 'never');
        if (rest.expires !== undefined) parseExpiry(rest.expires, now); // reject a bad value in the preview
        if (!confirm) {
          const view = { audience: rest.audience, label: rest.label, scope: scopeWords({ groups: groups ?? 'all' } as never), since, until, expires };
          return text({ ...view, ...preview('share', structuredClone(rest)) });
        }
        if (!isDeepStrictEqual(takeConfirmed<typeof rest>('share', confirm), rest)) throw new GaError('arguments changed since the preview; ask for a new preview');
        const { share, token } = createShare(dir, {
          audience: rest.audience,
          label: rest.label,
          ...(groups && { groups }),
          ...(since && { since }),
          ...(until && { until }),
          ...(rest.expires !== undefined && { expires: rest.expires }),
          ...(rest.questionsPerDay !== undefined && { questionsPerDay: rest.questionsPerDay }),
          patientId,
          baseUrl: remote.publicUrl,
        }, now);
        const link = `${remote.publicUrl}/s/${token}`;
        const png = (await QRCode.toDataURL(link)).replace(/^data:image\/png;base64,/, '');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ id: share.id, link, scope: scopeWords(share), expires: expiryWords(share) }) }, { type: 'image' as const, data: png, mimeType: 'image/png' }] };
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'share_list',
    { description: 'List share links: id, label, audience, scope, expires, status, last access, access count.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      try {
        const rows = [];
        for (const s of listShares(dir)) {
          const log = await readLog(client, s.id);
          rows.push({ id: s.id, label: s.label, audience: s.audience, scope: scopeWords(s), expires: expiryWords(s), status: status(s), lastAccess: log[0]?.at ?? 'never', accesses: log.length });
        }
        return text(rows);
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'share_log',
    { description: 'Access log of share links (views, downloads, questions), newest first; for one share when id is given.', inputSchema: { id: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      try {
        if (id) find(id);
        return text(await readLog(client, id));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'share_revoke',
    { description: 'Revoke a share link by id; the link stops working immediately.', inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => {
      try {
        const s = revokeShare(dir, id);
        return text({ id: s.id, status: status(s) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
