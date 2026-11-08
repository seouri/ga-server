import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, CodeableConcept, Condition, Encounter, Identifier, Medication, MedicationStatement, Resource } from '@medplum/fhirtypes';
import { XMLParser } from 'fast-xml-parser';
import { type GaConfig, GaError, isGaNotRunning } from './config.ts';
import { RXNORM } from './concepts.ts';
import { addReport, importResources, type ImportReport } from './engine.ts';
import { withImportLock } from './lock.ts';
import { storeDocument } from './document.ts';

export const CONVERTER_DOWN = 'the C-CDA converter is not running: start it with docker compose --profile ccda up -d fhir-converter';

export async function convertCcda(xml: string, converterUrl: string): Promise<Resource[]> {
  let res: Response;
  try {
    res = await fetch(`${converterUrl}convertToFhir?api-version=2024-05-01-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ InputDataFormat: 'Ccda', RootTemplateName: 'CCD', InputDataString: xml }),
    });
  } catch (e) {
    // On demand (compose profile ccda): a refused connection is not "GA is not running".
    if (isGaNotRunning(e)) throw new GaError(CONVERTER_DOWN);
    throw e;
  }
  // Status only: the converter's error body can echo document content.
  if (!res.ok) throw new GaError(`converter failed: HTTP ${res.status}`);
  const { result } = (await res.json()) as { result: Bundle };
  return repair((result.entry ?? []).map((e) => e.resource as Resource), xml);
}

type X = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const norm = (s: string) => s.replace(/^urn:(oid|uuid):/i, '').toLowerCase();
const cdaKeys = (n: X): string[] =>
  arr(n.id as X | X[] | undefined)
    .filter((i) => i['@_root'] && !i['@_nullFlavor']) // nullFlavor/empty ids identify nothing
    .map((i) => (i['@_extension'] ? `${norm(String(i['@_root']))}|${i['@_extension']}` : norm(String(i['@_root']))));
const fhirKey = (i: Identifier): string | undefined =>
  !i.value ? undefined : i.system === 'urn:ietf:rfc:3986' ? norm(i.value) : `${norm(i.system ?? '')}|${i.value}`;

const attr = (n: unknown, k: string) => (n as X | undefined)?.[`@_${k}`] as string | undefined;
// Problem Status observation (LOINC 33999-4) value, by SNOMED code or display name.
const PROBLEM_STATUS: Record<string, string> = {
  '55561003': 'active',
  '73425007': 'inactive',
  '413322009': 'resolved',
  active: 'active',
  inactive: 'inactive',
  resolved: 'resolved',
};
const ACT_STATUS: Record<string, string> = { active: 'active', completed: 'resolved', resolved: 'resolved' };

// R11 precedence: status observation > effectiveTime/high present > enclosing concern act statusCode.
function problemStatus(obs: X, act?: string): string | undefined {
  const statusObs = arr(obs.entryRelationship as X | X[] | undefined)
    .flatMap((er) => arr(er.observation as X | X[] | undefined))
    .find((o) => attr(o.code, 'code') === '33999-4');
  const v = statusObs?.value;
  const fromObs = PROBLEM_STATUS[attr(v, 'code') ?? ''] ?? PROBLEM_STATUS[(attr(v, 'displayName') ?? '').toLowerCase()];
  if (fromObs) return fromObs;
  if (attr((obs.effectiveTime as X | undefined)?.high, 'value')) return 'resolved';
  return ACT_STATUS[act ?? ''];
}

// Text of a narrative node (mixed content), whitespace collapsed.
const textOf = (n: unknown): string =>
  (typeof n === 'string' || typeof n === 'number' ? String(n)
    : Array.isArray(n) ? n.map(textOf).join(' ')
    : n && typeof n === 'object' ? Object.entries(n).filter(([k]) => !k.startsWith('@_')).map(([, v]) => textOf(v)).join(' ')
    : '').replace(/\s+/g, ' ').trim();

const RXNORM_OID = '2.16.840.1.113883.6.88';
const PROBLEM_SECTION = /^2\.16\.840\.1\.113883\.10\.20\.22\.2\.5(\.1)?$/;
type MedInfo = { name?: string; rxnorm?: string };

// Per source entry <id>: substanceAdministration status and drug (narrative name, RxNorm), and each observation's
// problem status (see problemStatus) and whether it sits in the Problems section (problem list) or elsewhere (visit diagnoses).
function sourceInfo(xml: string) {
  const med = new Map<string, string>();
  const drug = new Map<string, MedInfo>();
  const prob = new Map<string, string>();
  const problemList = new Map<string, boolean>();
  const narrative = new Map<string, string>();
  const root = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml) as X;
  const collect = (o: unknown) => {
    for (const c of arr(o as X | X[])) {
      if (!c || typeof c !== 'object') continue;
      const id = attr(c, 'ID');
      if (id && !narrative.has(id)) narrative.set(id, textOf(c));
      for (const [k, v] of Object.entries(c)) if (!k.startsWith('@_')) collect(v);
    }
  };
  collect(root);
  const walk = (o: X, act: string | undefined, inProblems: boolean) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('@_')) continue;
      for (const c of arr(v)) {
        if (!c || typeof c !== 'object') continue;
        const n = c as X;
        const code = attr(n.statusCode, 'code');
        const problems = k === 'section' ? arr(n.templateId as X | X[]).some((t) => PROBLEM_SECTION.test(attr(t, 'root') ?? '')) : inProblems;
        if (k === 'substanceAdministration') {
          const mat = ((n.consumable as X)?.manufacturedProduct as X)?.manufacturedMaterial as X | undefined;
          const mc = mat?.code as X | undefined;
          const ref = attr((mc?.originalText as X)?.reference, 'value')?.replace(/^#/, '');
          const info: MedInfo = {
            name: (ref && narrative.get(ref)) || attr(mc, 'displayName') || undefined,
            rxnorm: attr(mc, 'codeSystem') === RXNORM_OID ? attr(mc, 'code') : undefined,
          };
          for (const key of cdaKeys(n)) {
            if (code && !med.has(key)) med.set(key, code);
            if ((info.name || info.rxnorm) && !drug.has(key)) drug.set(key, info);
          }
        }
        if (k === 'observation') {
          const st = problemStatus(n, act);
          for (const key of cdaKeys(n)) {
            if (st && !prob.has(key)) prob.set(key, st);
            if (!problemList.has(key)) problemList.set(key, problems);
          }
        }
        walk(n, k === 'act' ? code : act, problems);
      }
    }
  };
  walk(root, undefined, false);
  return { med, drug, prob, problemList };
}

const MED_STATUS: Record<string, MedicationStatement['status']> = { active: 'active', completed: 'completed', aborted: 'stopped', suspended: 'on-hold' };
const cc = (system: string, code: string) => ({ coding: [{ system, code }] });
const CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category';

// Fixes converter template gaps from the source XML; only neutral values ('unknown') when the source has nothing.
// Drops the converter's DocumentReference: storeDocument keeps the original file.
export function repair(rs: Resource[], xml: string): Resource[] {
  const { med, drug, prob, problemList } = sourceInfo(xml);
  const lookup = <T>(m: Map<string, T>, r: Resource): T | undefined =>
    [(r as { identifier?: Identifier | Identifier[] }).identifier ?? []]
      .flat()
      .map((i) => fhirKey(i))
      .map((k) => (k ? m.get(k) : undefined))
      .find((v) => v !== undefined);
  // The converter keeps only the NDC package code: name each Medication from its statement's source entry.
  const drugOf = new Map<string, MedInfo>();
  for (const r of rs) {
    const ref = r.resourceType === 'MedicationStatement' ? (r as MedicationStatement).medicationReference?.reference : undefined;
    const info = ref && lookup(drug, r);
    if (ref && info) drugOf.set(ref, info);
  }
  const named = (c: CodeableConcept | undefined, info: MedInfo): CodeableConcept => {
    const coding = [...(c?.coding ?? [])];
    if (info.rxnorm && !coding.some((x) => x.system === RXNORM && x.code === info.rxnorm)) coding.push({ system: RXNORM, code: info.rxnorm, display: info.name });
    return { ...c, coding, text: info.name ?? c?.text };
  };
  return rs
    .filter((r) => r.resourceType !== 'DocumentReference')
    .map((r) => {
      if (r.resourceType === 'Medication') {
        const info = drugOf.get(`Medication/${r.id}`);
        return info ? { ...r, code: named((r as Medication).code, info) } : r;
      }
      if (r.resourceType === 'MedicationStatement') {
        return { ...r, status: MED_STATUS[lookup(med, r) ?? ''] ?? (r.status || 'unknown') };
      }
      if (r.resourceType === 'Encounter') return { ...r, status: (r as Encounter).status || 'unknown' };
      if (r.resourceType === 'Condition') {
        const inList = lookup(problemList, r);
        if (inList !== undefined) r = { ...r, category: [cc(CATEGORY, inList ? 'problem-list-item' : 'encounter-diagnosis')] } as Condition;
        const s = lookup(prob, r);
        if (!s) return r;
        const clinicalStatus = cc('http://terminology.hl7.org/CodeSystem/condition-clinical', s);
        if (s !== 'resolved') return { ...r, clinicalStatus };
        return { ...r, clinicalStatus, verificationStatus: cc('http://terminology.hl7.org/CodeSystem/condition-ver-status', 'confirmed') };
      }
      return r;
    });
}

// Custodian organisation name, matched only inside its own element so a nameless custodian can never pick up a later (patient) <name>.
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const custodian = (xml: string): string | undefined => {
  const body = /<(?:\w+:)?representedCustodianOrganization\b[^>]*>([\s\S]*?)<\/(?:\w+:)?representedCustodianOrganization>/.exec(xml)?.[1];
  const name = body && /<(?:\w+:)?name\b[^>]*>([^<]*)<\/(?:\w+:)?name>/.exec(body)?.[1];
  try {
    return name?.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, d, h, n) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : (ENTITY[n] ?? m))).trim() || undefined;
  } catch {
    return undefined; // a code point out of range: the folder name keys the source instead
  }
};

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
  const total: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: [] };
  for (const file of ccdaFiles(path)) {
    const xml = readFileSync(file, 'utf8');
    const resources = await convertCcda(xml, cfg.converterUrl);
    const { fileHash } = await storeDocument(client, file, patientId, 'application/xml');
    const r = await withImportLock(() => importResources(client, resources, { kind: 'ccda', file, org: custodian(xml), date: ccdaDate(xml), writer: 'importer' }, patientId, fileHash));
    addReport(total, r);
  }
  return total;
}
