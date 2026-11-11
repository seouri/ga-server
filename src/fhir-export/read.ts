// Read a FHIR export file ({ fhir: { <Type>: [resources] }, attachments?: [...] }) into the resources GA imports.
import { readFileSync } from 'node:fs';
import type { Resource } from '@medplum/fhirtypes';
import { GaError } from '../config.ts';
import { COMPARTMENT } from '../engine.ts';

type Attach = { resourceType: string; resourceId: string; path: string; contentType: string; contentBase64: string };
const KEPT = new Set(['Patient', ...Object.keys(COMPARTMENT), 'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication']);
const DATES = ['effectiveDateTime', 'issued', 'date', 'authoredOn', 'recordedDate'];
const NOT_EXPORT = 'not a FHIR export: expected {"fhir": {...}}';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

// Put the attachment at its dotted path (content.0.attachment) under the resource. Every step must already exist as an own
// property (an array index below its length), so nothing is created and no prototype is reached; false otherwise.
function place(r: Resource, a: Attach): boolean {
  const parts = a.path.split('.');
  if (!parts.every((p) => p && !UNSAFE.has(p))) return false;
  let node: unknown = r;
  for (const p of parts.slice(0, -1)) {
    if (!(isObj(node) || Array.isArray(node)) || !Object.hasOwn(node, p) || (Array.isArray(node) && !/^\d+$/.test(p))) return false;
    node = (node as Record<string, unknown>)[p];
  }
  const last = parts[parts.length - 1];
  if (!(isObj(node) || Array.isArray(node)) || !Object.hasOwn(node, last) || (Array.isArray(node) && !/^\d+$/.test(last))) return false; // an index past the end is not an own property
  const holder = node as Record<string, unknown>;
  const existing = holder[last];
  holder[last] = { ...(isObj(existing) ? existing : {}), contentType: a.contentType, data: a.contentBase64 };
  return true;
}

export function readFhirExport(path: string): { resources: Resource[]; skippedTypes: Record<string, number>; attachmentsUnplaced: number; date: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new GaError('not a FHIR export: invalid JSON'); // never quote the file
  }
  if (!isObj(doc) || !isObj(doc.fhir)) throw new GaError(NOT_EXPORT);
  const resources: Resource[] = [];
  const skippedTypes: Record<string, number> = {};
  for (const [type, list] of Object.entries(doc.fhir)) {
    if (!Array.isArray(list)) continue;
    const ok = list.filter((r): r is Resource => isObj(r) && r.resourceType === type && typeof r.id === 'string');
    const bad = list.length - ok.length;
    if (bad) skippedTypes[`${type} (invalid)`] = bad;
    if (KEPT.has(type)) resources.push(...ok);
    else if (ok.length) skippedTypes[type] = ok.length;
  }
  const byKey = new Map(resources.map((r) => [`${r.resourceType}/${r.id}`, r]));
  let attachmentsUnplaced = 0;
  const attachments = Array.isArray(doc.attachments) ? (doc.attachments as Attach[]) : [];
  for (const a of attachments) {
    const r = isObj(a) && typeof a.path === 'string' && typeof a.contentBase64 === 'string' ? byKey.get(`${a.resourceType}/${a.resourceId}`) : undefined;
    if (!r || !place(r, a)) attachmentsUnplaced++;
  }
  const times = (vals: unknown[]): number[] => vals.filter((v): v is string => typeof v === 'string').map((v) => Date.parse(v)).filter((t) => !Number.isNaN(t));
  let newest = Math.max(...times(resources.map((r) => r.meta?.lastUpdated)), 0);
  if (!newest) newest = Math.max(...times(resources.flatMap((r) => DATES.map((k) => (r as unknown as Record<string, unknown>)[k]))), 0);
  return { resources, skippedTypes, attachmentsUnplaced, date: new Date(newest || Date.now()).toISOString() };
}
