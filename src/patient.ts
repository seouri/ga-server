import type { Identifier, Resource } from '@medplum/fhirtypes';

// Visits every `reference` string in place; fn returns the replacement or undefined to keep.
export function walkReferences(obj: unknown, fn: (ref: string) => string | undefined): void {
  if (Array.isArray(obj)) return obj.forEach((x) => walkReferences(x, fn));
  if (obj === null || typeof obj !== 'object') return;
  const o = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'reference' && typeof v === 'string') o[k] = fn(v) ?? v;
    else walkReferences(v, fn);
  }
}

export function collapsePatients(
  rs: Resource[],
  gaPatientId: string,
): { resources: Resource[]; patientIdentifiers: Identifier[] } {
  const copy = structuredClone(rs);
  const patients = copy.filter((r) => r.resourceType === 'Patient');
  const refs = new Set(patients.flatMap((p) => [`Patient/${p.id}`, `urn:uuid:${p.id}`]));
  const resources = copy.filter((r) => r.resourceType !== 'Patient');
  walkReferences(resources, (ref) => (refs.has(ref) ? `Patient/${gaPatientId}` : undefined));
  return { resources, patientIdentifiers: patients.flatMap((p) => (p as { identifier?: Identifier[] }).identifier ?? []) };
}
