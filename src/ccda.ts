import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Condition, Encounter, Identifier, MedicationStatement, Resource } from '@medplum/fhirtypes';
import { XMLParser } from 'fast-xml-parser';
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
  return repair((result.entry ?? []).map((e) => e.resource as Resource), xml);
}

type X = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const norm = (s: string) => s.replace(/^urn:(oid|uuid):/i, '').toLowerCase();
const cdaKeys = (n: X) =>
  arr(n.id as X | X[] | undefined).map((i) =>
    i['@_extension'] !== undefined ? `${norm(String(i['@_root']))}|${i['@_extension']}` : norm(String(i['@_root'] ?? '')),
  );
const fhirKey = (i: Identifier) => (i.system === 'urn:ietf:rfc:3986' ? norm(i.value ?? '') : `${norm(i.system ?? '')}|${i.value}`);

// Source statusCode per entry <id>: substanceAdministration's own, and for each observation its nearest enclosing act's
// (the problem concern act).
function sourceStatuses(xml: string): { med: Map<string, string>; prob: Map<string, string> } {
  const med = new Map<string, string>();
  const prob = new Map<string, string>();
  const walk = (o: X, act?: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('@_')) continue;
      for (const c of arr(v)) {
        if (!c || typeof c !== 'object') continue;
        const code = ((c as X).statusCode as X | undefined)?.['@_code'] as string | undefined;
        if (k === 'substanceAdministration' && code) for (const key of cdaKeys(c as X)) if (!med.has(key)) med.set(key, code);
        if (k === 'observation' && act) for (const key of cdaKeys(c as X)) if (!prob.has(key)) prob.set(key, act);
        walk(c as X, k === 'act' ? code : act);
      }
    }
  };
  walk(new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml) as X);
  return { med, prob };
}

const MED_STATUS: Record<string, MedicationStatement['status']> = { active: 'active', completed: 'completed', aborted: 'stopped', suspended: 'on-hold' };
const cc = (system: string, code: string) => ({ coding: [{ system, code }] });

// Fixes converter template gaps from the source XML; only neutral values ('unknown') when the source has nothing.
// Drops the converter's DocumentReference: storeDocument keeps the original file.
export function repair(rs: Resource[], xml: string): Resource[] {
  const { med, prob } = sourceStatuses(xml);
  const lookup = (m: Map<string, string>, r: Resource) =>
    [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []].flat().map((i) => m.get(fhirKey(i))).find(Boolean);
  return rs
    .filter((r) => r.resourceType !== 'DocumentReference')
    .map((r) => {
      if (r.resourceType === 'MedicationStatement') {
        return { ...r, status: MED_STATUS[lookup(med, r) ?? ''] ?? (r.status || 'unknown') };
      }
      if (r.resourceType === 'Encounter') return { ...r, status: (r as Encounter).status || 'unknown' };
      if (r.resourceType === 'Condition' && !(r as Condition).clinicalStatus) {
        const s = lookup(prob, r);
        if (s === 'active') return { ...r, clinicalStatus: cc('http://terminology.hl7.org/CodeSystem/condition-clinical', 'active') };
        if (s === 'completed' || s === 'resolved') {
          return {
            ...r,
            clinicalStatus: cc('http://terminology.hl7.org/CodeSystem/condition-clinical', 'resolved'),
            verificationStatus: cc('http://terminology.hl7.org/CodeSystem/condition-ver-status', 'confirmed'),
          };
        }
      }
      return r;
    });
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
  const total: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 };
  for (const file of ccdaFiles(path)) {
    const xml = readFileSync(file, 'utf8');
    const resources = await convertCcda(xml, cfg.converterUrl);
    const { fileHash } = await storeDocument(client, file, patientId, 'application/xml');
    const r = await importResources(client, resources, { kind: 'ccda', file, date: ccdaDate(xml), writer: 'importer' }, patientId, fileHash);
    for (const k of Object.keys(total) as (keyof ImportReport)[]) total[k] += r[k];
  }
  return total;
}
