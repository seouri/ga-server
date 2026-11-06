import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Resource } from '@medplum/fhirtypes';
import { APPLE } from '../identity.ts';
import { appleDate, type AhClinical } from './read.ts';
import { sha, SUBJECT } from './readings.ts';

// Replace every Reference with its display only (hospital ids mean nothing in GA).
function stripRefs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripRefs);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.reference === 'string') return o.display === undefined ? {} : { display: o.display };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, stripRefs(x)]));
  }
  return v;
}

export function mapClinical(dir: string, refs: AhClinical[]): { resources: Resource[]; skips: { clinicalTypeUnsupported: number } } {
  const resources: Resource[] = [];
  let clinicalTypeUnsupported = 0;
  for (const ref of refs) {
    const r = JSON.parse(readFileSync(join(dir, ref.resourceFilePath), 'utf8'));
    if (r.resourceType === 'Patient') {
      resources.push({ resourceType: 'Patient', id: 'apple-patient', identifier: r.identifier });
    } else if (r.resourceType === 'AllergyIntolerance' && ref.fhirVersion.startsWith('4.')) {
      const { id: _id, patient, ...rest } = r;
      const a = stripRefs(rest) as Record<string, any>;
      resources.push({ ...a, resourceType: 'AllergyIntolerance', patient: { ...SUBJECT, ...(patient?.display && { display: patient.display }) }, identifier: [{ system: APPLE, value: ref.sourceURL }, ...(a.identifier ?? [])] });
    } else clinicalTypeUnsupported++;
  }
  return { resources, skips: { clinicalTypeUnsupported } };
}

const KEYS = new Set(['Recorded Date', 'Classification', 'Symptoms', 'Sample Rate', 'Lead', 'Unit']);

export function mapEcgs(dir: string): Resource[] {
  const folder = join(dir, 'electrocardiograms');
  let files: string[];
  try { files = readdirSync(folder).filter((f) => f.endsWith('.csv')).sort(); } catch { return []; }
  const out: Resource[] = [];
  files.forEach((f, n) => {
    const text = readFileSync(join(folder, f), 'utf8');
    const h: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      if (/^[-\d.,\s]+$/.test(line) && /\d/.test(line)) break; // first sample row: header is over
      const i = line.indexOf(',');
      const k = line.slice(0, i);
      if (i > 0 && KEYS.has(k)) h[k] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    }
    if (!h['Recorded Date'] || !h.Classification) return; // not an ECG export we understand
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
  return out;
}
