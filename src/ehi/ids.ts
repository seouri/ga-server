import type { MedplumClient } from '@medplum/core';
import type { Condition, Encounter, Identifier, Resource } from '@medplum/fhirtypes';
import { linkCandidates } from '../engine.ts';
import { EPIC_OID } from '../identity.ts';
import type { EhiTables } from './read.ts';

// epicOrgNumber: n in Epic's org OID root 1.2.840.114350.1.13.<n>; absent = no link identifiers.
// timeZone: IANA zone the export's local times are in (R17).
export type EhiCtx = { org: string; date: string; timeZone: string; epicOrgNumber?: string };

// Every mapped resource points here; the importer adds a Patient with this id so collapsePatients maps it to the GA Patient.
export const PATIENT_REF = { reference: 'Patient/ehi-patient' };

export const ehiId = (ctx: EhiCtx, table: string, pk: string): Identifier => ({ system: `urn:ga-server:id:ehi:${ctx.org}`, value: `${table}|${pk}` });

// Suffixes under the org root, from recon (d). imm: IMMUNE_ID (R15: all 28 match C-CDA immunization ids; same root as problems).
// dx: a visit diagnosis, value `<CSN>-<DX_ID>` (R12: matched 53 of 77 real PAT_ENC_DX rows).
const EPIC_SUFFIX = { order: '2.7.2.798268', problem: '2.7.2.768076', imm: '2.7.2.768076', csn: '2.7.3.698084.8', dx: '2.7.1.1099.1' };
// R13: C-CDAs carry a CSN under the org root or under 1.2.840.114350.1.72.75210, so a CSN gets both.
export const epicId = (ctx: EhiCtx, kind: keyof typeof EPIC_SUFFIX, value: string): Identifier[] =>
  ctx.epicOrgNumber && value
    ? [
        { system: `urn:oid:1.2.840.114350.1.13.${ctx.epicOrgNumber}.${EPIC_SUFFIX[kind]}`, value },
        ...(kind === 'csn' ? [{ system: 'urn:oid:1.2.840.114350.1.72.75210', value }] : []),
      ]
    : [];

// Resource id for intra-batch references (the engine replaces it on write).
export const localId = (table: string, pk: string): string => `${table}-${pk}`;

// Encounter reference for a CSN, only when PAT_ENC has that CSN (a dangling reference would fail the write).
export function encounterRef(t: EhiTables): (csn: string) => { reference: string } | undefined {
  const csns = new Set(t.rows('PAT_ENC').map((r) => r.PAT_ENC_CSN_ID));
  return (csn) => (csns.has(csn) ? { reference: `Encounter/${localId('PAT_ENC', csn)}` } : undefined);
}

// The export carries no OID, so the org number comes from Epic ids the patient's C-CDA records already have.
// shortcut: samples up to 1000 records per type; enough to find the one org number, upgrade if several Epic orgs mix.
export async function epicOrgNumber(client: MedplumClient, patientId: string): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const type of ['DiagnosticReport', 'Encounter', 'Condition'] as const) {
    for (const r of await client.searchResources(type, { subject: `Patient/${patientId}`, _count: '1000' }, { cache: 'no-cache' })) {
      for (const i of r.identifier ?? []) {
        const n = /^urn:oid:1\.2\.840\.114350\.1\.13\.(\d+)\./.exec(i.system ?? '')?.[1];
        if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
      }
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) console.error('no Epic org number in GA: EHI records get no link identifiers');
  return best;
}

// Before import: a record whose Epic link id finds no existing record of the patient is new to GA. A new Condition
// without a name says nothing: skipped and counted. A new Encounter gets class UNK (required; the export has none) and
// status 'unknown' when the export has none,
// while a linked one leaves class out so the engine keeps the C-CDA class (R11).
export async function resolveUnlinked(
  client: MedplumClient,
  resources: Resource[],
  patientId: string,
): Promise<{ resources: Resource[]; skippedNoName: number }> {
  const out: Resource[] = [];
  let skippedNoName = 0;
  for (const r of structuredClone(resources)) {
    const nameless = r.resourceType === 'Condition' && !(r as Condition).code;
    const classless = r.resourceType === 'Encounter' && !(r as Encounter).class;
    if (nameless || classless) {
      // Linked = already in GA under its own EHI id, or exactly one free link candidate (the engine's rule; 2+ is
      // an ambiguous link that the engine creates from this record, unfilled).
      const [own, ...rest] = (r as Condition | Encounter).identifier ?? [];
      const type = r.resourceType as 'Condition' | 'Encounter';
      const stored = !!own?.value && (await client.searchResources(type, { identifier: `${own.system}|${own.value}`, subject: `Patient/${patientId}` }, { cache: 'no-cache' })).length > 0;
      const epic = rest.filter((x) => x.system?.startsWith(EPIC_OID) && x.value);
      const linked = stored || (epic.length > 0 && (await linkCandidates(client, type, epic, patientId, own?.system as string)).free.length === 1);
      if (!linked && nameless) {
        skippedNoName++;
        continue;
      }
      if (!linked && classless) Object.assign(r, { class: { system: 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor', code: 'UNK' }, status: (r as Encounter).status ?? 'unknown' });
    }
    out.push(r);
  }
  return { resources: out, skippedNoName };
}
