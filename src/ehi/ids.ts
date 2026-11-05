import type { MedplumClient } from '@medplum/core';
import type { Identifier } from '@medplum/fhirtypes';
import type { EhiTables } from './read.ts';

// epicOrgNumber: n in Epic's org OID root 1.2.840.114350.1.13.<n>; absent = no link identifiers.
export type EhiCtx = { org: string; date: string; epicOrgNumber?: string };

// Every mapped resource points here; the importer adds a Patient with this id so collapsePatients maps it to the GA Patient.
export const PATIENT_REF = { reference: 'Patient/ehi-patient' };

export const ehiId = (ctx: EhiCtx, table: string, pk: string): Identifier => ({ system: `urn:ga-server:id:ehi:${ctx.org}`, value: `${table}|${pk}` });

// Suffixes under the org root, from recon (d). Immunization ids match nothing in the C-CDA, so they have no root here.
const EPIC_SUFFIX = { order: '2.7.2.798268', problem: '2.7.2.768076', csn: '2.7.3.698084.8' };
export const epicId = (ctx: EhiCtx, kind: keyof typeof EPIC_SUFFIX, value: string): Identifier[] =>
  ctx.epicOrgNumber && value ? [{ system: `urn:oid:1.2.840.114350.1.13.${ctx.epicOrgNumber}.${EPIC_SUFFIX[kind]}`, value }] : [];

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
