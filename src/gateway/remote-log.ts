// Remote access log: one local AuditEvent per chat-app tool call (tool, client name, time; never arguments or results). Follows share/audit.ts.
import type { MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GaConfig } from '../config.ts';
import { buildMcpServer } from '../mcp.ts';

export const REMOTE_TAG = 'urn:ga-server:remote';

export async function logRemote(client: MedplumClient, tool: string, clientName: string): Promise<void> {
  await client.createResource<AuditEvent>({
    resourceType: 'AuditEvent',
    meta: { tag: [{ system: REMOTE_TAG, code: clientName }] },
    type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest', display: 'RESTful Operation' },
    action: 'E',
    recorded: new Date().toISOString(),
    outcome: '0',
    agent: [{ who: { display: clientName }, requestor: true }],
    source: { observer: { display: 'GA gateway' } },
    entity: [{ what: { display: tool } }],
  });
}

// The gateway's tools factory: the full remote tool set, each call logged under the chat app's name.
export const remoteTools = (client: MedplumClient, cfg: GaConfig, patientId: string) => (remote: { publicUrl: string; clientName: string }): McpServer =>
  buildMcpServer({ client, cfg, patientId, remote: { ...remote, log: (tool) => logRemote(client, tool, remote.clientName) } });
