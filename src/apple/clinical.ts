import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Identifier, Resource } from '@medplum/fhirtypes';
import { APPLE } from '../identity.ts';
import { appleDate, type AhClinical } from './read.ts';
import { sha, SUBJECT } from './readings.ts';

// Replace every Reference with its display only (hospital ids mean nothing in GA); no display -> dropped.
function stripRefs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripRefs).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.reference === 'string') return o.display === undefined ? undefined : { display: o.display };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, stripRefs(x)]).filter(([, x]) => x !== undefined));
  }
  return v;
}

export function mapClinical(dir: string, refs: AhClinical[]): { resources: Resource[]; skips: { clinicalTypeUnsupported: number; clinicalUnreadable: number } } {
  const resources: Resource[] = [];
  const ids = new Map<string, Identifier>(); // one Patient with the union of identifiers
  let clinicalTypeUnsupported = 0;
  let clinicalUnreadable = 0;
  let patients = 0;
  for (const ref of refs) {
    let r: any;
    try { r = JSON.parse(readFileSync(join(dir, ref.resourceFilePath), 'utf8')); } catch { clinicalUnreadable++; continue; }
    if (r?.resourceType === 'Patient') {
      patients++;
      for (const i of r.identifier ?? []) ids.set(`${i.system}|${i.value}`, i);
    } else if (r?.resourceType === 'AllergyIntolerance' && ref.fhirVersion.startsWith('4.')) {
      const { id: _id, patient, ...rest } = r;
      const a = stripRefs(rest) as Record<string, any>;
      resources.push({ ...a, resourceType: 'AllergyIntolerance', patient: { ...SUBJECT, ...(patient?.display && { display: patient.display }) }, identifier: [{ system: APPLE, value: ref.sourceURL }, ...(a.identifier ?? [])] });
    } else clinicalTypeUnsupported++;
  }
  if (patients) resources.unshift({ resourceType: 'Patient', id: 'apple-patient', identifier: [...ids.values()] });
  return { resources, skips: { clinicalTypeUnsupported, clinicalUnreadable } };
}

const KEYS = new Set(['Recorded Date', 'Classification', 'Symptoms']);

export function mapEcgs(dir: string): { resources: Resource[]; skips: { ecgUnparsed: number } } {
  const folder = join(dir, 'electrocardiograms');
  const files = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith('.csv')).sort() : [];
  const out: Resource[] = [];
  let ecgUnparsed = 0;
  files.forEach((f, n) => {
    const text = readFileSync(join(folder, f), 'utf8');
    const h: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      if (/^[-\d.,\s]+$/.test(line) && /\d/.test(line)) break; // first sample row: header is over
      const i = line.indexOf(',');
      const k = line.slice(0, i);
      if (i > 0 && KEYS.has(k)) h[k] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    }
    if (!h['Recorded Date'] || !h.Classification) { ecgUnparsed++; return; }
    const recorded = appleDate(h['Recorded Date']);
    const id = `apple-ecg-${n}`;
    out.push({
      resourceType: 'DocumentReference', id, status: 'current', type: { text: 'Apple Watch ECG' }, date: recorded,
      content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: Buffer.from(text).toString('base64'), title: basename(f) } }],
      identifier: [{ system: APPLE, value: sha(`ecg|${text}`) }],
    });
    out.push({
      resourceType: 'Observation', status: 'final', code: { text: 'Apple Watch ECG classification' }, subject: SUBJECT,
      valueString: h.Classification, effectiveDateTime: recorded,
      derivedFrom: [{ reference: `DocumentReference/${id}` }],
      identifier: [{ system: APPLE, value: sha(`ecg-class|${recorded}`) }],
      ...(h.Symptoms && { note: [{ text: h.Symptoms }] }),
    });
  });
  return { resources: out, skips: { ecgUnparsed } };
}
