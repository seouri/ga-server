import { type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Extension, Identifier, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { GaError } from './config.ts';
import { contentKey, SINGULAR_ID, stableIdentifier, stamp, type SourceInfo } from './identity.ts';
import { collapsePatients, walkReferences } from './patient.ts';

export type Decision = 'create' | 'update' | 'skip' | 'conflict';
export type ImportReport = {
  created: number;
  updated: number;
  skipped: number;
  merged: number;
  conflicts: number;
  possibleDuplicates: number;
  invalid: number;
};

type R = Resource & { identifier?: Identifier[]; extension?: Extension[] };
const TAG = 'urn:ga-server:tag';
const SRC_DATE = 'urn:ga-server:ext:source-date';
const DUP_OF = 'urn:ga-server:ext:possible-duplicate-of';
const KEPT_TAGS = ['possible-duplicate', 'source-conflict'];
const VALIDATION = ['structure', 'required', 'value', 'invariant', 'invalid'];

const hasTag = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);
const srcDate = (r: R) => r.extension?.find((e) => e.url === SRC_DATE)?.valueDateTime;
const idKey = (i: Identifier) => `${i.system}|${i.value}`;
const idList = (r: R): Identifier[] => [r.identifier ?? []].flat(); // singular on SINGULAR_ID types
const canon = (x: unknown) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );

// Equality ignores id, meta, our bookkeeping extensions and identifiers; identifiers only need incoming ⊆ existing,
// because existing accumulates extra identifiers from merges.
function body(r: R): unknown {
  const { id: _i, meta: _m, identifier: _id, extension, ...rest } = r;
  const ext = (extension ?? []).filter((e) => e.url !== SRC_DATE && e.url !== DUP_OF);
  return ext.length ? { ...rest, extension: ext } : rest;
}

export function decide(existingRes: Resource | undefined, incomingRes: Resource): Decision {
  if (!existingRes) return 'create';
  const existing = existingRes as R;
  const incoming = incomingRes as R;
  const ed = srcDate(existing);
  const id = srcDate(incoming);
  if (ed && id && Date.parse(id) <= Date.parse(ed)) return 'skip';
  const have = new Set(idList(existing).map(idKey));
  const subset = idList(incoming).every((i) => have.has(idKey(i)));
  if (subset && canon(body(existing)) === canon(body(incoming))) return 'skip';
  // Only a write that would actually happen is a conflict.
  return hasTag(existing, 'writer-agent') && hasTag(incoming, 'writer-importer') ? 'conflict' : 'update';
}

const sourceKeys = (r: Resource) => (r.id ? [`${r.resourceType}/${r.id}`, `urn:uuid:${r.id}`] : []);

function topoSort(rs: Resource[]): Resource[] {
  const byKey = new Map<string, Resource>();
  for (const r of rs) for (const k of sourceKeys(r)) byKey.set(k, r);
  const out: Resource[] = [];
  const state = new Map<Resource, 'visiting' | 'done'>();
  const visit = (r: Resource, path: Resource[]) => {
    if (state.get(r) === 'done') return;
    if (state.get(r) === 'visiting') {
      const cycle = path.slice(path.indexOf(r)).map((x) => `${x.resourceType}/${x.id}`);
      throw new GaError(`reference cycle: ${cycle.join(', ')}`);
    }
    state.set(r, 'visiting');
    walkReferences(r, (ref) => {
      const dep = byKey.get(ref);
      if (dep && dep !== r) visit(dep, [...path, r]);
      return undefined;
    });
    state.set(r, 'done');
    out.push(r);
  };
  for (const r of rs) visit(r, []);
  return out;
}

const withTag = (r: Resource, code: string): Resource => ({ ...r, meta: { ...r.meta, tag: [...(r.meta?.tag ?? []), { system: TAG, code }] } });

function sameValue(a: Observation, b: Observation): boolean {
  if (a.valueQuantity && b.valueQuantity) return a.valueQuantity.value === b.valueQuantity.value && a.valueQuantity.unit === b.valueQuantity.unit;
  return a.valueString !== undefined && a.valueString === b.valueString;
}

// Incoming body wins; keeps identifiers from merges, review tags and possible-duplicate pointers.
async function unionUpdate(client: MedplumClient, existing: R, incoming: R): Promise<void> {
  const ids = idList(existing);
  for (const i of idList(incoming)) if (!ids.some((x) => idKey(x) === idKey(i))) ids.push(i);
  const kept = (existing.meta?.tag ?? []).filter((t) => t.system === TAG && KEPT_TAGS.includes(t.code as string) && !hasTag(incoming, t.code as string));
  const dupOf = (existing.extension ?? []).filter((e) => e.url === DUP_OF);
  await client.updateResource({
    ...incoming,
    id: existing.id,
    identifier: SINGULAR_ID.has(incoming.resourceType) ? incoming.identifier : ids,
    meta: { ...incoming.meta, tag: [...(incoming.meta?.tag ?? []), ...kept] },
    extension: [...(incoming.extension ?? []), ...dupOf],
  } as Resource);
}

export async function importResources(
  client: MedplumClient,
  resources: Resource[],
  source: SourceInfo,
  patientId: string,
  fileHash: string,
): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 };
  const { resources: collapsed, patientIdentifiers } = collapsePatients(resources, patientId);
  const ordered = topoSort(collapsed); // throws before any write

  const patient = await client.readResource('Patient', patientId);
  const have = new Set((patient.identifier ?? []).map(idKey));
  const missing: Identifier[] = [];
  for (const i of patientIdentifiers) {
    if (have.has(idKey(i))) continue;
    have.add(idKey(i));
    missing.push(i);
  }
  if (missing.length) await client.updateResource<Patient>({ ...patient, identifier: [...(patient.identifier ?? []), ...missing] });

  const idMap = new Map<string, string>();
  for (const src of ordered) {
    const r = structuredClone(src) as R;
    walkReferences(r, (ref) => idMap.get(ref));
    const ident = stableIdentifier(r, source, fileHash);
    if (!ident.value) throw new GaError(`${r.resourceType} has no source id`);
    const incoming = stamp(r, source, ident) as R;
    delete incoming.id;
    const type = incoming.resourceType;
    try {
      const existing = (await client.searchOne(type, { identifier: idKey(ident) })) as R | undefined;
      let target: Resource;

      if (existing) {
        target = existing;
        const d = decide(existing, incoming);
        if (d === 'update') {
          await unionUpdate(client, existing, incoming);
          report.updated++;
        } else if (d === 'conflict') {
          if (!hasTag(existing, 'source-conflict')) await client.updateResource(withTag(existing, 'source-conflict'));
          report.conflicts++;
        } else report.skipped++;
      } else {
        const key = type === 'Observation' ? contentKey(incoming as Observation) : undefined;
        const matches = key
          ? await client.searchResources('Observation', {
              subject: `Patient/${patientId}`,
              code: key.split('|').slice(0, 2).join('|'),
              date: key.split('|')[2],
            })
          : [];
        const same = matches.find((m) => sameValue(m, incoming as Observation)) as R | undefined;
        if (same) {
          target = same;
          const d = decide(same, incoming);
          // conflict: equal value already recorded by the agent; don't attach an importer identifier (it would conflict on every re-import).
          if (d === 'conflict') report.skipped++;
          else {
            if (d === 'update') await unionUpdate(client, same, incoming);
            else await client.updateResource({ ...same, identifier: [...(same.identifier ?? []), ident] } as Resource);
            report.merged++;
          }
        } else if (matches.length) {
          const dupExt = (o: Resource): Extension => ({ url: DUP_OF, valueReference: { reference: `Observation/${o.id}` } });
          target = await client.createResource(
            withTag({ ...incoming, extension: [...(incoming.extension ?? []), ...matches.map(dupExt)] } as Resource, 'possible-duplicate'),
          );
          for (const m of matches as R[]) {
            const tag = hasTag(m, 'possible-duplicate') ? m : withTag(m, 'possible-duplicate');
            await client.updateResource({ ...tag, extension: [...(m.extension ?? []), dupExt(target)] } as Resource);
          }
          report.possibleDuplicates++;
        } else {
          target = await client.createResource(incoming as Resource);
          report.created++;
        }
      }
      for (const k of sourceKeys(src)) idMap.set(k, `${type}/${target.id}`);
    } catch (e) {
      const issues = e instanceof OperationOutcomeError ? (e.outcome.issue ?? []) : [];
      if (!issues.length || !issues.every((i) => VALIDATION.includes(i.code))) throw e;
      // Element paths only: server diagnostics can echo values. References to this resource stay unresolved.
      console.error(`invalid ${issues.map((i) => `${type}/${i.expression?.join(',') ?? '?'}`).join(' ')}`);
      report.invalid++;
    }
  }
  return report;
}
