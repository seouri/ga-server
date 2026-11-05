import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { type GaConfig, GaError } from './config.ts';
import { importResources, type ImportReport } from './engine.ts';
import { storeDocument } from './document.ts';

export async function convertCcda(xml: string, converterUrl: string): Promise<Resource[]> {
  const res = await fetch(`${converterUrl}convertToFhir?api-version=2024-05-01-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ InputDataFormat: 'Ccda', RootTemplateName: 'CCD', InputDataString: xml }),
  });
  if (!res.ok) throw new GaError(`converter failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
  const { result } = (await res.json()) as { result: Bundle };
  const rs = (result.entry ?? []).map((e) => e.resource as Resource);
  // shortcut: converter CCD template (_MedicationStatement.liquid, ValueSet/MedicationStatementStatus) maps only
  // `aborted`, so status is empty and Medplum rejects it; 'unknown' invents nothing. Upgrade: custom template.
  for (const r of rs) if (r.resourceType === 'MedicationStatement' && !r.status) (r as { status: string }).status = 'unknown';
  return rs;
}

// The header effectiveTime precedes any body effectiveTime in CDA, so the first match is the document's.
export function ccdaDate(xml: string): string {
  const m = xml.match(/<effectiveTime\s[^>]*?value="(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?([+-]\d{4})?"/);
  if (!m) throw new GaError('ClinicalDocument has no effectiveTime');
  const [, y, mo, d, h, mi, s, tz] = m;
  const day = `${y}-${mo}-${d}`;
  // FHIR dateTime with a time needs a zone; without one keep only the date.
  return h && tz ? `${day}T${h}:${mi}:${s ?? '00'}${tz.slice(0, 3)}:${tz.slice(3)}` : day;
}

const isCcda = (xml: string) => /^﻿?\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<(?:\w+:)?ClinicalDocument[\s/>]/.test(xml);

export function ccdaFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const xmls = (readdirSync(path, { recursive: true }) as string[]).filter((f) => /\.xml$/i.test(f)).sort().map((f) => join(path, f));
  return xmls.filter((f) => {
    if (isCcda(readFileSync(f, 'utf8'))) return true;
    console.error(`skip ${basename(f)}: not a ClinicalDocument`);
    return false;
  });
}

export async function importPath(client: MedplumClient, cfg: GaConfig, path: string, patientId = cfg.patientId): Promise<ImportReport> {
  const total: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0 };
  for (const file of ccdaFiles(path)) {
    const xml = readFileSync(file, 'utf8');
    const resources = await convertCcda(xml, cfg.converterUrl);
    const { fileHash } = await storeDocument(client, file, patientId, 'application/xml');
    const r = await importResources(client, resources, { kind: 'ccda', file, date: ccdaDate(xml), writer: 'importer' }, patientId, fileHash);
    for (const k of Object.keys(total) as (keyof ImportReport)[]) total[k] += r[k];
  }
  return total;
}
