import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Identifier, Resource } from '@medplum/fhirtypes';
import { COMPARTMENT } from '../engine.ts';
import { APPLE, sha256 as sha } from '../identity.ts';
import { sourceKey } from '../smart/auth.ts';
import { mapForGa } from '../smart/fetch.ts';
import { appleDate, type AhClinical } from './read.ts';
import { SUBJECT } from './readings.ts';

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

// Epic's receivedDate per sourceURL (the APPLE identifier value): the source date of an Apple clinical copy. Keyed by value because
// the engine stamps a clone of each resource.
export const receivedBy = new Map<string, string>();

// Hospital JSON now and then holds an invalid escape (a stray "\d" in a string): double that backslash and parse again.
function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return JSON.parse(text.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, ok) => (ok ? m : '\\\\'))); }
}

export function mapClinical(dir: string, refs: AhClinical[]): { resources: Resource[]; skips: { clinicalVersionUnsupported: number; clinicalUnreadable: number } } {
  const resources: Resource[] = [];
  const ids = new Map<string, Identifier>(); // one Patient with the union of identifiers
  let clinicalVersionUnsupported = 0;
  let clinicalUnreadable = 0;
  let patients = 0;
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
    // One record at a time: a reference to another record would dangle when the batches cut between them, so mapForGa keeps displays only.
    const { resources: [m] } = mapForGa([r], { key: at.key, name: ref.sourceName ?? new URL(at.base).hostname, fhirBase: at.base });
    const out = m as Record<string, any>;
    const field = COMPARTMENT[out.resourceType];
    if (field) out[field] = { ...SUBJECT, ...(r[field]?.display && { display: r[field].display }) };
    for (const c of out.content ?? []) if (String(c.attachment?.url).startsWith('urn:ga-server:pending-binary:')) delete c.attachment.url; // no Binary upload for an Apple copy
    out.identifier = [out.identifier, { system: APPLE, value: ref.sourceURL }].flat();
    if (ref.receivedDate) receivedBy.set(ref.sourceURL, ref.receivedDate);
    resources.push(m);
  }
  if (patients) resources.unshift({ resourceType: 'Patient', id: 'apple-patient', identifier: [...ids.values()] });
  return { resources, skips: { clinicalVersionUnsupported, clinicalUnreadable } };
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
  return [{
    resourceType: 'DocumentReference', id, status: 'current', subject: SUBJECT, type: { text: 'Apple Watch ECG' }, date: recorded,
    content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: Buffer.from(text).toString('base64'), title: basename(f) } }],
    identifier: [{ system: APPLE, value: sha(`ecg|${text}`) }],
  }, {
    resourceType: 'Observation', status: 'final', code: { text: 'Apple Watch ECG classification' }, subject: SUBJECT,
    valueString: h.Classification, effectiveDateTime: recorded,
    derivedFrom: [{ reference: `DocumentReference/${id}` }],
    identifier: [{ system: APPLE, value: sha(`ecg-class|${recorded}`) }],
    ...(h.Symptoms && { note: [{ text: h.Symptoms }] }),
  } as Resource];
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
