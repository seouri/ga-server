// whats_new: records that arrived since a time, counted by kind, and the "last seen" marker.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { defaultConfigPath } from './config.ts';
import { arrivedAt, TAG } from './identity.ts';
import { writeAtomic } from './smart/store.ts';

export const SOURCES: [string, string][] = [['src-ccda', 'C-CDA'], ['src-ehi', 'Epic EHI export'], ['src-apple-health', 'Apple Health'], ['src-pdf', 'PDF or photo']];

export type Kind = 'lab results' | 'vital signs' | 'Apple Health readings' | 'medications' | 'problems' | 'allergies' | 'vaccines' | 'procedures' | 'visits' | 'notes and messages' | 'other';

const hasTag = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);

export function kindOf(r: Resource): Kind {
  switch (r.resourceType) {
    case 'Observation':
      if (hasTag(r, 'src-apple-health')) return 'Apple Health readings';
      return r.category?.some((c) => c.coding?.some((x) => x.code === 'vital-signs')) ? 'vital signs' : 'lab results';
    case 'MedicationStatement': case 'MedicationRequest': return 'medications';
    case 'Condition': return 'problems';
    case 'AllergyIntolerance': return 'allergies';
    case 'Immunization': return 'vaccines';
    case 'Procedure': return 'procedures';
    case 'Encounter': return 'visits';
    case 'DocumentReference': case 'Communication': return 'notes and messages';
    default: return 'other';
  }
}

export function clinicalDate(r: Resource): string | undefined {
  const x = r as Record<string, any>; // shortcut: untyped field probe across resource types, fine while the list is fixed
  const d = x.effectiveDateTime ?? x.effectivePeriod?.start ?? x.effectiveInstant ?? x.occurrenceDateTime ?? x.occurrencePeriod?.start ?? x.performedDateTime ?? x.performedPeriod?.start ?? x.onsetDateTime
    ?? x.recordedDate ?? x.authoredOn ?? x.period?.start ?? x.date ?? x.sent ?? x.issued;
  return typeof d === 'string' ? d.slice(0, 10) : undefined;
}

export function tally(arrived: Resource[], asOf: string) {
  const cutoff = new Date(Date.parse(asOf) - 365 * 864e5).toISOString().slice(0, 10);
  const byKind: Partial<Record<Kind, number>> = {};
  const sources = new Set<string>();
  let historical = 0;
  for (const r of arrived) {
    const k = kindOf(r);
    byKind[k] = (byKind[k] ?? 0) + 1;
    const d = clinicalDate(r);
    if (d && d < cutoff) historical++;
    for (const [tag, label] of SOURCES) if (hasTag(r, tag)) sources.add(label);
    for (const i of (r as { identifier?: { system?: string }[] }).identifier ?? []) {
      if (i.system?.startsWith('urn:ga-server:id:smart:')) sources.add(i.system.slice('urn:ga-server:id:smart:'.length));
    }
  }
  return { total: arrived.length, historical, byKind, sources: [...sources] };
}

// Types the engine creates, with their patient search parameter.
const TYPES: [Resource['resourceType'], 'subject' | 'patient'][] = [
  ['Observation', 'subject'], ['Condition', 'subject'], ['MedicationStatement', 'subject'], ['MedicationRequest', 'subject'], ['AllergyIntolerance', 'patient'],
  ['Immunization', 'patient'], ['Procedure', 'subject'], ['Encounter', 'subject'], ['DocumentReference', 'subject'], ['Communication', 'subject'],
  ['DiagnosticReport', 'subject'], ['FamilyMemberHistory', 'patient'], ['QuestionnaireResponse', 'subject'],
];

// Records without the arrival extension predate tracking and are never returned.
export async function arrivedSince(client: MedplumClient, patientId: string, since: string): Promise<Resource[]> {
  const out: Resource[] = [];
  for (const [type, param] of TYPES) {
    const q = { [param]: `Patient/${patientId}`, _lastUpdated: `ge${since}`, _sort: '_lastUpdated', _count: '1000' };
    for await (const page of client.searchResourcePages(type as 'Observation', q, { cache: 'no-cache' })) out.push(...page.filter((r) => { const a = arrivedAt(r); return a !== undefined && a >= since; }));
  }
  return out;
}

const lastSeenFile = (dir: string) => join(dir, 'whats-new.json');

export function readLastSeen(dir: string = dirname(defaultConfigPath())): string | undefined {
  const f = lastSeenFile(dir);
  if (!existsSync(f)) return undefined;
  try {
    const v = (JSON.parse(readFileSync(f, 'utf8')) as { lastSeen?: unknown } | null)?.lastSeen;
    return typeof v === 'string' ? v : undefined;
  } catch { return undefined; } // a bad file must not break whats_new
}

export function writeLastSeen(at: string, dir: string = dirname(defaultConfigPath())): void {
  writeAtomic(lastSeenFile(dir), JSON.stringify({ lastSeen: at }), 0o600);
}
