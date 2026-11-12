import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DocumentReference, Identifier, Observation, Resource } from '@medplum/fhirtypes';
import { COMPARTMENT } from '../engine.ts';
import { APPLE, sha256 as sha } from '../identity.ts';
import { sourceKey } from '../smart/auth.ts';
import { mapForGa, type PendingBinary } from '../smart/fetch.ts';
import type { SourceRec } from '../smart/store.ts';
import { appleDate, type AhClinical } from './read.ts';
import { keyed, SUBJECT } from './readings.ts';

// FHIR base and source key of a ClinicalRecord's sourceURL (".../<Type>/<id>"); undefined when it has no such shape.
export function fhirBaseOf(sourceURL: string): { base: string; key: string } | undefined {
  try {
    const u = new URL(sourceURL);
    const m = /^(.*)\/[A-Za-z]+\/[^/]+$/.exec(u.pathname);
    if (!m || !/^https?:$/.test(u.protocol)) return undefined;
    const base = `${u.origin}${m[1]}`;
    return { base, key: sourceKey(base) };
  } catch { return undefined; }
}

// Hospital JSON now and then holds an invalid escape (a stray "\d" in a string): double that backslash and parse again.
function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return JSON.parse(text.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, ok) => (ok ? m : '\\\\'))); }
}

export type ClinicalGroup = { src: SourceRec; resources: Resource[]; binaries: PendingBinary[] };

// Every R4 clinical record of the export: one Patient with the union of the Patient files' identifiers, then the other records
// mapped once per FHIR base (references between a base's records resolve within one import call). Each record carries the
// hospital's portal-style identifier first and Apple's sourceURL second.
export function mapClinical(dir: string, refs: AhClinical[]): { resources: Resource[]; groups: ClinicalGroup[]; skips: { clinicalVersionUnsupported: number; clinicalUnreadable: number } } {
  const ids = new Map<string, Identifier>();
  let clinicalVersionUnsupported = 0;
  let clinicalUnreadable = 0;
  let patients = 0;
  const bases = new Map<string, { src: SourceRec; rs: any[]; url: Map<string, string> }>();
  for (const ref of refs) {
    if (!ref.fhirVersion?.startsWith('4.')) { clinicalVersionUnsupported++; continue; }
    let r: any;
    try { r = parseJson(readFileSync(join(dir, ref.resourceFilePath), 'utf8')); } catch { clinicalUnreadable++; continue; }
    if (r?.resourceType === 'Patient') {
      patients++;
      for (const i of r.identifier ?? []) ids.set(`${i.system}|${i.value}`, i);
      continue;
    }
    const at = fhirBaseOf(ref.sourceURL);
    if (!at || typeof r?.resourceType !== 'string' || !r.id) { clinicalUnreadable++; continue; }
    let g = bases.get(at.base);
    if (!g) bases.set(at.base, g = { src: { key: at.key, name: ref.sourceName ?? new URL(at.base).hostname, fhirBase: at.base }, rs: [], url: new Map() });
    g.rs.push(r);
    g.url.set(`${r.resourceType}/${r.id}`, ref.sourceURL);
  }
  // The key is the host: a second base on that host (another tenant) gets its own, so its ids never collide with the first's.
  // The first in sorted order keeps the plain key (matching a portal sync of it), whatever order the export lists them in.
  const taken = new Set<string>();
  for (const base of [...bases.keys()].sort()) {
    const src = bases.get(base)!.src;
    if (taken.has(src.key)) src.key = `${src.key}-${sha(base).slice(0, 8)}`;
    else taken.add(src.key);
  }
  const groups: ClinicalGroup[] = [];
  for (const g of bases.values()) {
    const mapped = mapForGa(g.rs, g.src);
    const out = mapped.resources.map((m, i) => {
      const o = m as Record<string, any>;
      const orig = g.rs[i];
      const field = COMPARTMENT[o.resourceType];
      if (field) o[field] = { ...SUBJECT, ...(orig[field]?.display && { display: orig[field].display }) };
      o.identifier = [o.identifier, { system: APPLE, value: g.url.get(`${orig.resourceType}/${orig.id}`) }].flat();
      return m;
    });
    groups.push({ src: g.src, resources: out, binaries: mapped.binaries });
  }
  const resources = groups.flatMap((g) => g.resources);
  if (patients) resources.unshift({ resourceType: 'Patient', id: 'apple-patient', identifier: [...ids.values()] });
  return { resources, groups, skips: { clinicalVersionUnsupported, clinicalUnreadable } };
}

const KEYS = new Set(['Recorded Date', 'Classification', 'Symptoms']);

function ecg(folder: string, f: string, n: number): Resource[] | undefined {
  const text = readFileSync(join(folder, f), 'utf8');
  const h: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^[-\d.,\s]+$/.test(line) && /\d/.test(line)) break; // first sample row: header is over
    const i = line.indexOf(',');
    const k = line.slice(0, i);
    if (i > 0 && KEYS.has(k)) h[k] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  if (!h['Recorded Date'] || !h.Classification) return undefined;
  const recorded = appleDate(h['Recorded Date']);
  const id = `apple-ecg-${n}`;
  const doc: DocumentReference = {
    resourceType: 'DocumentReference', id, status: 'current', subject: SUBJECT, type: { text: 'Apple Watch ECG' }, date: recorded,
    content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: Buffer.from(text).toString('base64'), title: basename(f) } }],
  };
  // Keyed on the file with its Recorded Date line rewritten (the offset Apple writes may differ between exports); as written, the old key.
  keyed(doc, (at) => {
    const t = at(recorded);
    return `ecg|${t === recorded ? text : text.replace(/^(Recorded Date,).*$/m, `$1${t.replace('T', ' ').replace(/([+-]\d\d):(\d\d)$/, ' $1$2')}`)}`;
  });
  const o: Observation = {
    resourceType: 'Observation', status: 'final', code: { text: 'Apple Watch ECG classification' }, subject: SUBJECT,
    valueString: h.Classification, effectiveDateTime: recorded,
    derivedFrom: [{ reference: `DocumentReference/${id}` }],
    ...(h.Symptoms && { note: [{ text: h.Symptoms }] }),
  };
  keyed(o, (at) => `ecg-class|${at(recorded)}`);
  return [doc, o];
}

// One item per ECG file: its identifiers now, its DocumentReference and classification when built (the file is read again
// then, so a folder of ECGs is never held at once).
export function ecgItems(dir: string): { items: { keys: string[]; build: () => Resource[] }[]; skips: { ecgUnparsed: number } } {
  const folder = join(dir, 'electrocardiograms');
  const files = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith('.csv')).sort() : [];
  const items: { keys: string[]; build: () => Resource[] }[] = [];
  let ecgUnparsed = 0;
  files.forEach((f, n) => {
    const rs = ecg(folder, f, n);
    if (!rs) { ecgUnparsed++; return; }
    items.push({ keys: rs.map((r) => `${APPLE}|${(r as { identifier: Identifier[] }).identifier[0].value}`), build: () => ecg(folder, f, n) as Resource[] });
  });
  return { items, skips: { ecgUnparsed } };
}

export function mapEcgs(dir: string): { resources: Resource[]; skips: { ecgUnparsed: number } } {
  const { items, skips } = ecgItems(dir);
  return { resources: items.flatMap((i) => i.build()), skips };
}
