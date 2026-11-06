// Share access log: one local AuditEvent per view, download, document or question. Never shared (scope.ts NEVER).
import type { MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import type { Share } from './store.ts';

export type AccessEvent = { kind: 'view' | 'download' | 'question' | 'doc'; detail?: string; ip?: string; ua?: string; answerLength?: number };
type LogEntry = { at: string; label: string; kind: string; detail?: string; ip?: string };

const TAG_SYSTEM = 'urn:ga-server:share';
const KIND_SYSTEM = 'urn:ga-server:share-access';

export async function logAccess(client: MedplumClient, share: Share, e: AccessEvent): Promise<void> {
  const detail = [
    ...(e.detail !== undefined ? [{ type: e.kind === 'question' ? 'question' : 'detail', valueString: e.detail }] : []),
    ...(e.answerLength !== undefined ? [{ type: 'answer-length', valueString: String(e.answerLength) }] : []),
  ];
  await client.createResource<AuditEvent>({
    resourceType: 'AuditEvent',
    meta: { tag: [{ system: TAG_SYSTEM, code: share.id }] },
    type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest', display: 'RESTful Operation' },
    subtype: [{ system: KIND_SYSTEM, code: e.kind }],
    action: e.kind === 'question' ? 'E' : 'R',
    recorded: new Date().toISOString(),
    outcome: '0',
    agent: [{
      who: { display: share.label },
      requestor: true,
      ...(e.ua && { name: e.ua }),
      ...(e.ip && { network: { address: e.ip, type: '2' as const } }),
    }],
    source: { observer: { display: 'GA share' } },
    entity: [{ what: { reference: `Patient/${share.patientId}` }, ...(detail.length && { detail }) }],
  });
}

export async function readLog(client: MedplumClient, id?: string): Promise<LogEntry[]> {
  // shortcut: newest 1000 events only; page by cursor if a share log ever grows past that.
  const events = await client.searchResources('AuditEvent', { _tag: `${TAG_SYSTEM}|${id ?? ''}`, _sort: '-date', _count: '1000' }, { cache: 'no-cache' });
  return events.map((a) => {
    const d = a.entity?.[0]?.detail?.find((x) => x.type === 'question' || x.type === 'detail')?.valueString;
    const ip = a.agent?.[0]?.network?.address;
    return {
      at: a.recorded ?? '',
      label: a.agent?.[0]?.who?.display ?? '',
      kind: a.subtype?.find((c) => c.system === KIND_SYSTEM)?.code ?? '',
      ...(d !== undefined && { detail: d }),
      ...(ip && { ip }),
    };
  });
}
